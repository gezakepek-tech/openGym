/* Single-process entry point for hosts that run one Node app per website
   (e.g. Hostinger Node.js hosting). It serves the built SPA from frontend/dist and
   reverse-proxies /api/* to the API, which it starts as a child process on a loopback port.

   Docker installs and the NixOS module do not use this file: they keep the two-container
   setup from docker-compose.yml / nix/.

   Environment:
     PORT       the port the platform gave this app (required; the child API gets its own free one)
     DATA_DIR   writable directory for users, passkeys and per-user state (default ./data)
     RP_ID      passkey hostname, e.g. active.example.com
     ORIGIN     public origin, e.g. https://active.example.com
     RP_NAME    display name in the passkey prompt (default openGym)
*/
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DIST = path.join(root, 'frontend', 'dist');
// A host wrapper may pass a non-numeric PORT; a NaN would make listen() throw instead of serving.
function resolvePort(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}
const PORT = resolvePort(process.env.PORT);
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');

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

function pickApiPort(start) {
  return new Promise((resolve, reject) => {
    let port = start;
    const attempt = () => {
      if (port >= start + 20) return reject(new Error(`no free loopback port in ${start}..${start + 19}`));
      // An outgoing connect, never listen(): Passenger-like wrappers allow only one listen() per
      // process, and that one belongs to the public server below.
      const sock = net.connect({ host: '127.0.0.1', port });
      const settle = (free) => {
        sock.removeAllListeners();
        sock.destroy();
        if (free) resolve(port);
        else { port += 1; attempt(); }
      };
      sock.setTimeout(400, () => settle(true));
      sock.once('connect', () => settle(false));
      sock.once('error', () => settle(true));
    };
    attempt();
  });
}

let child = null;
let childPort = 0;
let stopping = false;
let nextApiPort = +(process.env.API_PORT || 3901);

async function startApi() {
  childPort = await pickApiPort(nextApiPort);
  nextApiPort = childPort + 1;

  // A wrapper such as Passenger exports its own loader and socket details; a grandchild must not
  // inherit them, or its listen() is intercepted too.
  const env = { ...process.env, PORT: String(childPort), DATA_DIR };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('passenger_')) delete env[key];
  }
  if (env.NODE_OPTIONS && /passenger/i.test(env.NODE_OPTIONS)) {
    const stripped = env.NODE_OPTIONS.replace(/\S*passenger\S*/gi, '').trim();
    console.log(`[deploy] child node options: ${JSON.stringify(stripped)}`);
    if (stripped) env.NODE_OPTIONS = stripped; else delete env.NODE_OPTIONS;
  }

  child = spawn(process.execPath, [path.join(root, 'api', 'server.js')], {
    env,
    cwd: path.join(root, 'api'),
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    console.error(`[deploy] api exited (code=${code} signal=${signal}); restarting in 1s`);
    setTimeout(() => { startApi().catch(e => console.error('[deploy] api restart failed:', e)); }, 1000);
  });
  console.log(`[deploy] api on 127.0.0.1:${childPort}, data ${DATA_DIR}`);
}

function clientIp(req) {
  // Behind the platform's own proxy the first X-Forwarded-For entry is the real client.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function proxy(req, res) {
  if (!child) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'api starting', code: 'api-unavailable' }));
    return;
  }
  const headers = { ...req.headers };
  headers['x-forwarded-for'] = clientIp(req);
  headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
  const up = http.request(
    { host: '127.0.0.1', port: childPort, method: req.method, path: req.url, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'api unreachable', code: 'api-unreachable', detail: e.code }));
    } else {
      res.destroy();
    }
  });
  req.on('aborted', () => up.destroy());
  req.pipe(up);
}

async function staticFile(req, res, pathname) {
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

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];
  if (pathname === '/api' || pathname.startsWith('/api/')) return proxy(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }).end('method not allowed');
    return;
  }
  staticFile(req, res, pathname).catch((e) => {
    console.error('[deploy] static error:', e);
    if (!res.headersSent) res.writeHead(500).end('internal error');
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

await startApi();
server.on('error', (e) => console.error('[deploy] public server error:', e));
console.log(`[deploy] PORT env=${JSON.stringify(process.env.PORT)} -> listening on ${PORT}`);
server.listen(PORT, () => console.log(`[deploy] web on :${PORT}, serving ${DIST}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    console.log(`[deploy] ${sig}: shutting down`);
    child?.kill(sig);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
