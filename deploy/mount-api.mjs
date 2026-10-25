/* Mounts the API inside this process instead of spawning it.

   Hostinger's Node.js hosting runs one app process per website behind Passenger, which honours a
   single listen() per process, and its loopback is not reachable between processes: a spawned API
   child logged "gym-api on :PORT" while this process got ECONNREFUSED on every address family.
   So the API is not proxied at all — its request handler is mounted directly.

   api/server.js ends with `server.listen(PORT, cb)` and the callback logs `server.address().port`.
   That call is intercepted here (it never binds), and a stand-in address is provided for the
   duration of the callback. Everything else in api/ runs unchanged, so this survives upstream
   updates; docker-compose.yml and the NixOS module never load this file. */
import net from 'node:net';

const originalListen = net.Server.prototype.listen;
let apiServer = null;

net.Server.prototype.listen = function listen(...args) {
  const [first] = args;
  const port = typeof first === 'number' ? first
    : first && typeof first === 'object' && typeof first.port === 'number' ? first.port : null;

  // A Unix socket path or a handle is not something this file takes over.
  if (port === null) return originalListen.apply(this, args);

  if (!apiServer) apiServer = this;

  const callback = args.find(a => typeof a === 'function');
  if (callback) {
    const realAddress = this.address.bind(this);
    this.address = () => ({ address: '127.0.0.1', family: 'IPv4', port });
    try { callback(); } finally { this.address = realAddress; }
  }
  return this;
};

export async function mountApi() {
  try {
    await import('../api/server.js');
  } finally {
    // Restored before the caller creates the public server, so that one listen() is a real bind.
    net.Server.prototype.listen = originalListen;
  }
  return apiServer;
}
