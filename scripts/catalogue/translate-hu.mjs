/* Fills the missing Hungarian catalogue text from the English source, resumably.

   Where the text lives: catalogue/i18n/<lang>.json, keyed by exercise id. Anything missing falls
   back to English in the app, so this tool only ever adds — it never overwrites a translation that
   is already there. After a run, `node scripts/catalogue/build.mjs` regenerates the app's packs.

   Providers (pick with --provider):
     gemini     Gemini API, free tier available. Text is sent to Google; on the free tier Google
                states the content may be used to improve its products (paid tier: not).
     translate  Cloud Translation v2 (paid per character, monthly free allowance on some accounts).
   The key is read from an environment variable, never from a file in this repo:
     GEMINI_API_KEY  /  GOOGLE_TRANSLATE_API_KEY

   Examples:
     node scripts/catalogue/translate-hu.mjs --dry-run
     node scripts/catalogue/translate-hu.mjs --limit 50
     node scripts/catalogue/translate-hu.mjs --with-descriptions --limit 200
     node scripts/catalogue/translate-hu.mjs --only 0025,0032
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const EX_DIR = path.join(root, 'catalogue', 'exercises');
const HU_FILE = path.join(root, 'catalogue', 'i18n', 'hu.json');

const LANGS = { hu: 'Hungarian' };
const LANG = 'hu';

// Terms kept identical across every exercise, so 4 000 entries do not drift into four ways of
// saying the same thing. Extend it when a review finds a repeated choice worth fixing.
const GLOSSARY = [
  ['rep', 'ismétlés'],
  ['set', 'sorozat'],
  ['core', 'törzs'],
  ['glutes', 'farizom'],
  ['lats', 'széles hátizom'],
  ['shoulders', 'váll'],
  ['chest', 'mell'],
  ['triceps', 'tricepsz'],
  ['biceps', 'bicepsz'],
  ['hamstrings', 'hátsó combizom'],
  ['quadriceps', 'négyfejű combizom'],
  ['calves', 'vádli'],
  ['forearms', 'alkar'],
  ['abs', 'hasizom'],
  ['lower back', 'derék'],
  ['hip width', 'csípőszélesség'],
  ['shoulder width', 'vállszélesség'],
  ['brace your core', 'feszítsd meg a törzsed'],
  ['range of motion', 'mozgásterjedelem'],
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const has = (name) => process.argv.includes('--' + name);

const DRY = has('dry-run');
const LIMIT = Number(arg('limit', 0)) || Infinity;
const ONLY = (arg('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const WITH_DESC = has('with-descriptions');
const PROVIDER = arg('provider', 'gemini');
const MODEL = arg('model', 'gemini-2.5-flash');
const BATCH = Number(arg('batch', 20));
const PAUSE_MS = Number(arg('pause', 4500));      // free tier is per-minute limited; be gentle
const MAX_RETRIES = 3;
const TEMPERATURE = 0.2;

/* ---------------------------------------------------------------- reading -- */

function readExercises() {
  const out = new Map();
  for (const rel of fs.readdirSync(EX_DIR, { recursive: true })) {
    const name = String(rel);
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(EX_DIR, name), 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed.exercises || [parsed]);
    for (const e of list) {
      if (!e || e.id == null) continue;
      // An empty stub (a female-variant placeholder) has nothing to translate.
      if (!(e.name || '').trim()) continue;
      out.set(String(e.id), e);
    }
  }
  return out;
}

const exercises = readExercises();
const hu = fs.existsSync(HU_FILE) ? JSON.parse(fs.readFileSync(HU_FILE, 'utf8')) : {};

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
const hasSteps = (entry) => Array.isArray(entry?.instructions) && entry.instructions.some(hasText);

const todo = [];
for (const [id, e] of exercises) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  const entry = hu[id] || {};
  const need = { id, ex: e, name: !hasText(entry.name), steps: !hasSteps(entry) };
  need.desc = WITH_DESC && !hasText(entry.description);
  if (!need.steps && !need.desc && !need.name) continue;
  todo.push(need);
}

const chars = { name: 0, description: 0, instructions: 0 };
for (const item of todo) {
  if (item.name) chars.name += (item.ex.name || '').length;
  if (item.desc) chars.description += (item.ex.description || '').length;
  if (item.steps) chars.instructions += Array.isArray(item.ex.instructions) ? item.ex.instructions.join(' ').length : 0;
}
const totalChars = chars.name + chars.description + chars.instructions;
const selected = todo.slice(0, LIMIT === Infinity ? todo.length : LIMIT);

/* ---------------------------------------------------------------- prompt -- */

function promptFor(batch) {
  const lines = [
    `Translate the following gym exercise text from English to ${LANGS[LANG]}.`,
    'Rules:',
    '- Keep the meaning of every instruction step; do not add steps, cautions or medical advice.',
    '- The name is stored lower-case: keep it lower-case in the translation.',
    '- Never use em dashes or en dashes.',
    '- Use these terms consistently:',
    ...GLOSSARY.map(([en, huTerm]) => `    ${en} -> ${huTerm}`),
    '- Answer with JSON only, no prose and no code fence, in exactly this shape:',
    '  {"<id>": {"name": "...", "instructions": ["...", "..."]}}',
    WITH_DESC ? '  Include "description" for every entry as well.' : '',
    '',
    'Entries:',
    JSON.stringify(batch.map(b => ({
      id: b.id,
      name: b.ex.name,
      ...(b.desc ? { description: b.ex.description } : {}),
      ...(b.steps ? { instructions: b.ex.instructions } : {}),
    })), null, 1),
  ];
  return lines.filter(l => l !== '').join('\n');
}

/* -------------------------------------------------------------- providers -- */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function retrying(fn, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try { return await fn(); } catch (e) {
      lastError = e;
      const wait = 2000 * attempt;
      console.error(`  ! ${label}: ${e.message} (probálkozás ${attempt}/${MAX_RETRIES}, várakozás ${wait} ms)`);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function gemini(batch) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY nincs beállítva');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptFor(batch) }] }],
      generationConfig: { temperature: TEMPERATURE, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
  return JSON.parse(text);
}

async function cloudTranslate(batch) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) throw new Error('GOOGLE_TRANSLATE_API_KEY nincs beállítva');
  const out = {};
  for (const item of batch) {
    const parts = [item.ex.name, ...(item.steps ? item.ex.instructions : [])];
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: parts, source: 'en', target: LANG, format: 'text' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const t = data?.data?.translations?.map(x => x.translatedText) ?? [];
    out[item.id] = { name: t[0], instructions: t.slice(1) };
  }
  return out;
}

const translate = PROVIDER === 'translate' ? cloudTranslate : gemini;

/* ------------------------------------------------------------------ write -- */

function apply(id, got) {
  const ex = exercises.get(id);
  const entry = hu[id] || (hu[id] = {});
  if (!hasText(entry.name) && hasText(got.name)) entry.name = got.name.trim().toLowerCase();
  const steps = Array.isArray(got.instructions) ? got.instructions.filter(hasText) : [];
  if (!hasSteps(entry) && steps.length) entry.instructions = steps.map(s => s.trim());
  if (WITH_DESC && !hasText(entry.description) && hasText(got.description)) entry.description = got.description.trim();
  return ex;
}

function save() {
  const sorted = Object.fromEntries(Object.keys(hu).sort().map(k => [k, hu[k]]));
  const tmp = HU_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n');
  fs.renameSync(tmp, HU_FILE);
}

/* ------------------------------------------------------------------- run -- */

console.log(`[fordítás] ${LANG}: ${selected.length} bejegyzés kiválasztva (összesen várakozik: ${todo.length})`);
console.log(`  név: ${todo.filter(t => t.name).length} · lépések: ${todo.filter(t => t.steps).length} · leírás: ${WITH_DESC ? todo.filter(t => t.desc).length : 0}`);
console.log(`  karakter: név ${chars.name.toLocaleString('hu-HU')} · lépések ${chars.instructions.toLocaleString('hu-HU')} · leírás ${chars.description.toLocaleString('hu-HU')} · összesen ${totalChars.toLocaleString('hu-HU')}`);
const batches = Math.ceil(selected.length / BATCH);
console.log(`  kötegek: ${batches} (${BATCH} bejegyzés/köteg), szolgáltató: ${PROVIDER}${PROVIDER === 'gemini' ? '/' + MODEL : ''}`);
if (PROVIDER === 'translate') {
  console.log(`  Cloud Translation: a karakterek száma a díjazás alapja -> ${totalChars.toLocaleString('hu-HU')} karakter`);
}
console.log(`  becsült futásidő: ${Math.ceil(batches * PAUSE_MS / 1000)} mp (${PAUSE_MS} ms szünet kötegenként)`);

if (DRY) {
  console.log('\n[dry-run] nem történt hívás és nem írtunk fájlt.');
  process.exit(0);
}

const keyVar = PROVIDER === 'translate' ? 'GOOGLE_TRANSLATE_API_KEY' : 'GEMINI_API_KEY';
if (!process.env[keyVar]) {
  console.error(`\n[fordítás] ${keyVar} nincs beállítva — a futás nem indul.`);
  console.error(PROVIDER === 'translate'
    ? '  Példa: $env:GOOGLE_TRANSLATE_API_KEY="..."  (PowerShell)'
    : '  Példa: $env:GEMINI_API_KEY="..."  (PowerShell)');
  process.exit(1);
}

let done = 0, failed = 0;
for (let i = 0; i < selected.length; i += BATCH) {
  const batch = selected.slice(i, i + BATCH);
  const label = `köteg ${Math.floor(i / BATCH) + 1}/${batches} (${batch[0].id}..${batch[batch.length - 1].id})`;
  try {
    const got = await retrying(() => translate(batch), label);
    if (!got || typeof got !== 'object') throw new Error('üres válasz');
    let applied = 0;
    for (const item of batch) {
      const entry = got[item.id];
      if (!entry) { failed += 1; continue; }
      apply(item.id, entry);
      applied += 1;
    }
    save();
    done += applied;
    console.log(`  ${label}: ${applied}/${batch.length} kész (összesen ${done})`);
  } catch (e) {
    failed += batch.length;
    console.error(`  ${label}: ELHASALT — ${e.message}`);
  }
  if (i + BATCH < selected.length) await sleep(PAUSE_MS);
}

console.log(`\n[fordítás] kész: ${done} bejegyzés, ${failed} kihagyva. Fájl: ${path.relative(root, HU_FILE)}`);
console.log('Következő lépés: node scripts/catalogue/build.mjs   (az app csomagjainak újragenerálása)');
console.log('Ellenőrzés:      node scripts/catalogue/validate.mjs');
