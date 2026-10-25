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
const ONLY_DESC = has('only-descriptions');
// Re-translates steps that already exist; needed to redo a register or a bad batch, and it only
// ever replaces the steps of the entries actually selected.
const REDO_STEPS = has('redo-steps');
const PROVIDER = arg('provider', 'gemini');
// Fallback chain: a busy or retired model is not the end of the run. The first one that answers
// is remembered for the rest of the batches.
const MODEL_CANDIDATES = (() => {
  const explicit = arg('model', process.env.GEMINI_MODEL || '');
  if (explicit) return [explicit];
  return [
    'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite',
  ];
})();
let modelIndex = 0;
const currentModel = () => MODEL_CANDIDATES[modelIndex % MODEL_CANDIDATES.length];
const BATCH = Number(arg('batch', 20));
const CONCURRENCY = Math.max(1, Number(arg('concurrency', 5)) || 1);
const PAUSE_MS = Number(arg('pause', 4500));      // free tier is per-minute limited; be gentle
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 120_000;
const TEMPERATURE = 0.2;
// A key can come from the environment or from a .env file elsewhere on the machine. The file is
// opened read-only and never written; values are never printed, only the index that is in use.
const KEYS_FILE = arg('keys-file', process.env.GEMINI_KEYS_FILE || '');

function loadKeys() {
  if (process.env.GEMINI_API_KEY) return [process.env.GEMINI_API_KEY];
  if (!KEYS_FILE) return [];
  const text = fs.readFileSync(KEYS_FILE, 'utf8');
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, name, raw] = m;
    if (!/(GOOGLE_API_KEY|GEMINI)/i.test(name)) continue;
    const value = raw.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
    if (value && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

let keys = [];
let keyIndex = 0;
const currentKey = () => keys[keyIndex % keys.length];
function rotateKey(reason) {
  if (keys.length < 2) return;
  keyIndex = (keyIndex + 1) % keys.length;
  console.error(`  ~ kulcs váltás: ${keyIndex + 1}/${keys.length} (${reason})`);
}
const redact = (s) => keys.reduce((acc, k) => acc.split(k).join('***'), String(s));

let model = null;   // the model that answered last, tried first from then on
function noteModel(m) {
  if (model !== m) { model = m; console.error(`  ~ modell: ${m}`); }
}

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
  const need = { id, ex: e, name: !hasText(entry.name), steps: ONLY_DESC ? false : (REDO_STEPS ? hasSteps(entry) : !hasSteps(entry)) };
  need.desc = (WITH_DESC || ONLY_DESC) && !hasText(entry.description);
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
  if (ONLY_DESC) {
    return [
      `Translate these gym exercise descriptions from English to ${LANGS[LANG]}.`,
      'Rules:',
      '- One or two sentences, like the source. Describe what the movement is and what it trains.',
      '- Informal second person (tegezés), matching the app\'s other Hungarian text.',
      '- Never use em dashes or en dashes. No medical advice, no cautions.',
      '- Do not add steps. Answer with JSON only, no prose and no code fence, in exactly this shape:',
      '  {"<id>": {"description": "..."}}',
      '',
      'Entries:',
      JSON.stringify(batch.map(b => ({ id: b.id, name: b.ex.name, description: b.ex.description })), null, 1),
    ].join('\n');
  }
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
      // A free-tier 429 means the per-minute budget is spent: wait longer than a plain retry.
      // A timeout or a busy model is transient too, so it gets the same longer wait.
      const limited = /HTTP 429|HTTP 503|aborted|timeout|TimeoutError/i.test(e.message);
      const wait = (limited ? 15_000 : 2000) * attempt;
      console.error(`  ! ${label}: ${e.message.slice(0, 120)} (próbálkozás ${attempt}/${MAX_RETRIES}, várakozás ${wait} ms)`);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function gemini(batch) {
  const chosen = model || currentModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${chosen}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': currentKey() },
      // Without a deadline a stalled socket blocks the whole run forever.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptFor(batch) }] }],
        generationConfig: { temperature: TEMPERATURE, responseMimeType: 'application/json' },
      }),
    });
  } catch (e) {
    // A dead or throttled connection belongs to this key: next attempt starts on the following one.
    rotateKey(e.name || 'hálózati hiba');
    throw new Error(redact(`${e.name}: ${e.message}`));
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    // 429: this key's per-minute budget is spent. 503/404: this model is busy or gone.
    // 400/401/403: the key itself is not usable.
    if (res.status === 429) rotateKey('HTTP 429');
    else if (res.status === 503 || res.status === 404) {
      model = null;
      modelIndex = (modelIndex + 1) % MODEL_CANDIDATES.length;
      console.error(`  ~ modell váltás: ${currentModel()} (HTTP ${res.status})`);
    } else if ([400, 401, 403].includes(res.status)) rotateKey(`HTTP ${res.status}`);
    throw new Error(redact(`HTTP ${res.status} ${body}`));
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('a válasz nem érvényes JSON'); }
  noteModel(chosen);
  return parsed;
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

// Hungarian article agreement: "a" takes its linking form "az" before a vowel. A model writing
// thousands of sentences gets this wrong often enough to be worth one pass.
const VOWELS = 'aáeéiíoóöőuúüű';
function cleanHu(text) {
  return String(text)
    .replace(new RegExp(`\\ba ([${VOWELS}])`, 'g'), 'az $1')
    .replace(/[—–]/g, '-')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function apply(id, got) {
  const entry = hu[id] || (hu[id] = {});
  if (!hasText(entry.name) && hasText(got.name)) entry.name = got.name.trim().toLowerCase();
  // In description-only mode the steps are never touched: the request did not carry them, so
  // anything the model sent back under that key is not a translation of them.
  if (!ONLY_DESC) {
    const steps = Array.isArray(got.instructions) ? got.instructions.filter(hasText) : [];
    if (steps.length && (REDO_STEPS || !hasSteps(entry))) entry.instructions = steps.map(s => cleanHu(s));
  }
  if ((WITH_DESC || ONLY_DESC) && !hasText(entry.description) && hasText(got.description)) {
    entry.description = cleanHu(got.description);
  }
}

function save() {
  const sorted = Object.fromEntries(Object.keys(hu).sort().map(k => [k, hu[k]]));
  const tmp = HU_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n');
  fs.renameSync(tmp, HU_FILE);
}

/* ------------------------------------------------------------------- run -- */

console.log(`[fordítás] ${LANG}: ${selected.length} bejegyzés kiválasztva (összesen várakozik: ${todo.length})`);
console.log(`  név: ${todo.filter(t => t.name).length} · lépések: ${todo.filter(t => t.steps).length} · leírás: ${todo.filter(t => t.desc).length}`);
console.log(`  karakter: név ${chars.name.toLocaleString('hu-HU')} · lépések ${chars.instructions.toLocaleString('hu-HU')} · leírás ${chars.description.toLocaleString('hu-HU')} · összesen ${totalChars.toLocaleString('hu-HU')}`);
const batches = Math.ceil(selected.length / BATCH);
console.log(`  kötegek: ${batches} (${BATCH} bejegyzés/köteg, ${CONCURRENCY} párhuzamos), szolgáltató: ${PROVIDER}${PROVIDER === 'gemini' ? '/' + MODEL_CANDIDATES.join(' → ') : ''}`);
if (PROVIDER === 'translate') {
  console.log(`  Cloud Translation: a karakterek száma a díjazás alapja -> ${totalChars.toLocaleString('hu-HU')} karakter`);
}
console.log(`  becsült futásidő: ${Math.ceil(batches * PAUSE_MS / 1000)} mp (${PAUSE_MS} ms szünet kötegenként)`);

if (DRY) {
  console.log('\n[dry-run] nem történt hívás és nem írtunk fájlt.');
  process.exit(0);
}

const keyVar = PROVIDER === 'translate' ? 'GOOGLE_TRANSLATE_API_KEY' : 'GEMINI_API_KEY';
keys = PROVIDER === 'translate' ? [] : loadKeys();
if (PROVIDER === 'translate' && !process.env[keyVar]) {
  console.error(`\n[fordítás] ${keyVar} nincs beállítva — a futás nem indul.`);
  process.exit(1);
}
if (PROVIDER === 'gemini' && !keys.length) {
  console.error('\n[fordítás] nincs Gemini-kulcs: sem GEMINI_API_KEY, sem --keys-file.');
  console.error('  Példa: node scripts/catalogue/translate-hu.mjs --keys-file <útvonal>/.env');
  process.exit(1);
}
if (PROVIDER === 'gemini') console.log(`  kulcsok: ${keys.length} (csak a darabszám jelenik meg, az érték soha)`);

let done = 0, failed = 0;

// Batches run concurrently (each request goes out on whichever key is current), while apply() and
// save() stay synchronous, so one worker's result can never interleave with another's write.
async function runBatch(batch, label) {
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
}

const work = [];
for (let i = 0; i < selected.length; i += BATCH) {
  const batch = selected.slice(i, i + BATCH);
  work.push({ batch, label: `köteg ${Math.floor(i / BATCH) + 1}/${batches} (${batch[0].id}..${batch[batch.length - 1].id})` });
}

let cursor = 0;
async function worker() {
  while (cursor < work.length) {
    const item = work[cursor];
    cursor += 1;
    await runBatch(item.batch, item.label);
    if (cursor < work.length) await sleep(PAUSE_MS);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));

console.log(`\n[fordítás] kész: ${done} bejegyzés, ${failed} kihagyva. Fájl: ${path.relative(root, HU_FILE)}`);
console.log('Következő lépés: node scripts/catalogue/build.mjs   (az app csomagjainak újragenerálása)');
console.log('Ellenőrzés:      node scripts/catalogue/validate.mjs');
