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
*/
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountApi } from './mount-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DIST = path.join(root, 'frontend', 'dist');
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
  let file = path.resolve(DIST, rel);
  if (file !== DIST && !file.startsWith(DIST + path.sep)) {
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
  if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function route(req, res) {
  const pathname = (req.url || '/').split('?')[0];
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
