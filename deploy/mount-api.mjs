/* Mounts the API inside this process instead of spawning it.

   Why: Hostinger's Node.js hosting runs one app process per website behind Passenger, and
   Passenger replaces http.Server.prototype.listen with its own (measured: patching only
   net.Server.prototype.listen had no effect, the API's call still bound, and the app's own
   listen was refused with "http.Server.listen() was called more than once, ignore."). A spawned
   API child is not an option either: the app process cannot reach it over loopback.

   So this file takes over the API's listen() call: the server object is captured and never binds,
   a stand-in address is supplied for the callback that logs server.address().port, and the API's
   request listener is detached so the caller can route /api/* to it from the one server that does
   listen. api/ itself is imported unchanged, so this survives upstream updates; docker-compose.yml
   and the NixOS module never load this file. */
import http from 'node:http';
import net from 'node:net';

const savedHttpListen = http.Server.prototype.listen;
const savedNetListen = net.Server.prototype.listen;
let captured = null;

function intercept(...args) {
  const [first] = args;
  const port = typeof first === 'number' ? first
    : first && typeof first === 'object' && typeof first.port === 'number' ? first.port : null;

  // A Unix socket path or a handle is not something this file takes over.
  if (port === null) return savedHttpListen.apply(this, args);

  if (!captured) captured = this;

  const callback = args.find(a => typeof a === 'function');
  if (callback) {
    const realAddress = this.address.bind(this);
    this.address = () => ({ address: '127.0.0.1', family: 'IPv4', port });
    try { callback(); } finally { this.address = realAddress; }
  }
  return this;
}

export async function mountApi() {
  http.Server.prototype.listen = intercept;
  net.Server.prototype.listen = intercept;
  try {
    await import('../api/server.js');
  } finally {
    http.Server.prototype.listen = savedHttpListen;
    net.Server.prototype.listen = savedNetListen;
  }
  if (!captured) return null;

  const handlers = captured.rawListeners('request');
  captured.removeAllListeners('request');
  return { server: captured, handlers };
}
