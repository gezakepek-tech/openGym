/* Single-process entry point for hosts that run one Node app per website
   (e.g. Hostinger Node.js hosting). It serves the built SPA from frontend/dist and mounts the
   API's request handler in the same process (see deploy/mount-api.mjs), so one listen() serves
   both — which is all a Passenger-style wrapper allows.

   Docker installs and the NixOS module do not use this file: they keep the two-container setup
   from docker-compose.yml / nix/.

   Environment:
     PORT       the port the host wants the app on (falls back to 3000 when the wrapper supplies none)
     DATA_DIR   writable directory for users, passkeys and per-user state (default ./data)
     RP_ID      passkey hostname, e.g. active.example.com
     ORIGIN     public origin, e.g. https://active.example.com
     RP_NAME    display name in the passkey prompt (default openGym)
     SITE_USER + SITE_PASS  close the whole site behind one password
     MEDIA_TOKEN  a key for /t/<token>/still|clip/<id>.* — what a packaged app uses to reach the
                  media without the site password (see MEDIA below)
     MEDIA_OPEN 1  serve the media openly on a public instance instead (default: only when closed)
*/
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mountApi } from './mount-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DIST = path.join(root, 'frontend', 'dist');
// The exercise stills and animations the repository carries (180 px — the size its licence allows
// on a website or a self-hosted server, scripts/catalogue/stage-media.mjs) are served straight from
// catalogue/media: staging them into dist first would put a second 190 MB copy in every build
// without changing a byte of what the app asks for (/exercise-media/still|clip/<id>.*).
const MEDIA = path.join(root, 'catalogue', 'media');

// Optional whole-site password: SITE_USER and SITE_PASS together close the instance to everybody
// else — the media licence asks for a closed instance when the 180 px set must not be public, and
// the app itself still works as a guest without any account, so closing registration alone would
// not keep strangers out. Off unless BOTH are set, so an install that wants to be public is silent.
const SITE_USER = process.env.SITE_USER || '';
const SITE_PASS = process.env.SITE_PASS || '';
const GATE = !!(SITE_USER && SITE_PASS);
// The exercise media is served only when the instance is either closed (the gate above) or openly
// declared public (MEDIA_OPEN=1, the arrangement scripts/catalogue/stage-media.mjs describes for a
// website). Unset on both counts it answers 404, so a deploy that forgets the setting never
// publishes the 180 px set by accident.
const MEDIA_PUBLIC = /^(1|true|yes|on)$/i.test(process.env.MEDIA_OPEN || '');
const MEDIA_ON = GATE || MEDIA_PUBLIC;
// A packaged app cannot answer the site's password prompt (a WebView has no dialog for it) and may
// not carry the media inside the package (catalogue/media/NOTICE.md: a third party may not ship
// them), so it holds a key to this server instead: /t/<token>/still|clip/<id>.* is served without
// the password, to whoever presents the token. Unset, those URLs do not exist.
const MEDIA_TOKEN = process.env.MEDIA_TOKEN || '';

function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorized(req) {
  if (!GATE) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const raw = Buffer.from(m[1], 'base64').toString('utf8');
  const cut = raw.indexOf(':');
  if (cut < 0) return false;
  const user = sameSecret(raw.slice(0, cut), SITE_USER);
  const pass = sameSecret(raw.slice(cut + 1), SITE_PASS);
  return user && pass;
}
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
// The API reads its configuration at import time, so the resolved directory has to be in place
// before mountApi() imports it.
process.env.DATA_DIR = DATA_DIR;

// A host wrapper may pass a non-numeric PORT; a NaN would make listen() throw instead of serving.
function resolvePort(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}
const PORT = resolvePort(process.env.PORT);

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`[deploy] no built frontend at ${DIST} — run "npm run build" first`);
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

const mounted = await mountApi();
const apiServer = mounted?.server ?? http.createServer();
const apiHandlers = mounted?.handlers ?? [];
if (mounted) {
  console.log(`[deploy] api mounted in this process (${apiHandlers.length} request listener(s)), data ${DATA_DIR}`);
} else {
  console.error('[deploy] the API never called listen(); /api/* will answer 503');
}

async function serveStatic(req, res, pathname) {
  const urlPath = decodeURIComponent(pathname);
  const rel = urlPath.replace(/^\/+/, '');
  // /exercise-media/<still|clip>/<id>.<ext> comes from catalogue/media, everything else from dist.
  // /t/<token>/<still|clip>/<id>.<ext> is the same tree for a packaged app that holds the token.
  let mediaRel = rel.startsWith('exercise-media/') ? rel.slice('exercise-media/'.length) : null;
  const tokenPath = /^t\/([^/]+)\/(.+)$/.exec(rel);
  if (tokenPath) {
    if (!MEDIA_TOKEN || !sameSecret(tokenPath[1], MEDIA_TOKEN)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    mediaRel = tokenPath[2];
    // A packaged app runs on its own origin (capacitor://localhost), so its media fetch is
    // cross-origin; without this the prefetch and the clip-in-memory read would be blocked.
    res.setHeader('access-control-allow-origin', '*');
  }
  if (mediaRel !== null && !MEDIA_ON && !tokenPath) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const mediaRoot = mediaRel === null ? DIST : MEDIA;
  let file = path.resolve(mediaRoot, mediaRel === null ? rel : mediaRel);
  if (file !== mediaRoot && !file.startsWith(mediaRoot + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let stat = null;
  try { stat = await fsp.stat(file); } catch {}
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = await fsp.stat(file).catch(() => null);
  }
  const hasExt = path.extname(urlPath) !== '';
  if (!stat?.isFile()) {
    if (hasExt) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
    file = path.join(DIST, 'index.html');           // SPA route
    stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) { res.writeHead(404).end('not found'); return; }
  }
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);
  const immutable = urlPath.startsWith('/assets/');
  res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
  res.setHeader('content-length', stat.size);
  res.setHeader('cache-control', immutable
    ? 'public, max-age=31536000, immutable'
    : base === 'sw.js' ? 'no-cache, no-store, must-revalidate'
      : base === 'index.html' || base === 'manifest.json' ? 'no-cache'
        : 'public, max-age=3600');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('accept-ranges', 'bytes');
  if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
  // A phone's video element fetches one byte range at a time, and iOS plays nothing from a server
  // that answers 200 to a Range request, so the clips are streamed as 206.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.setHeader('content-range', `bytes */${stat.size}`);
      res.writeHead(416).end();
      return;
    }
    res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('content-length', end - start + 1);
    res.writeHead(206);
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    return;
  }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function route(req, res) {
  const pathname = (req.url || '/').split('?')[0];
  // The token path carries its own credential and is checked in serveStatic.
  if (!authorized(req) && !pathname.startsWith('/t/')) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="openGym", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end('authentication required');
    return;
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    if (!apiHandlers.length) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'api unavailable', code: 'api-not-mounted' }));
      return;
    }
    // The API's own handler: same request and response objects, so cookies, uploads and streaming
    // behave exactly as they do behind nginx.
    for (const handler of apiHandlers) handler.call(apiServer, req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }).end('method not allowed');
    return;
  }
  serveStatic(req, res, pathname).catch((e) => {
    console.error('[deploy] static error:', e);
    if (!res.headersSent) res.writeHead(500).end('internal error');
  });
}

// One server object for both halves: a Passenger-style wrapper binds only the server it sees
// listen(), so serving static files from a second one would leave them unreachable.
apiServer.on('request', route);
apiServer.keepAliveTimeout = 65_000;
apiServer.headersTimeout = 70_000;
apiServer.on('error', (e) => console.error('[deploy] public server error:', e));

console.log(`[deploy] PORT env=${JSON.stringify(process.env.PORT)} -> listening on ${PORT}`);
apiServer.listen(PORT, () => console.log(`[deploy] web on :${PORT}, serving ${DIST}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[deploy] ${sig}: shutting down`);
    apiServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
