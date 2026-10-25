/* Starts api/server.js with its HTTP listener pinned to the IPv4 loopback.

   Why: `server.listen(port)` with no host binds the wildcard address of the address family Node
   prefers. On hosts where IPv6 is enabled but bindv6only=1, that becomes [::] and nothing answers
   on 127.0.0.1 — the parent process then sees ECONNREFUSED for an API that is demonstrably up.
   Patching the prototype here keeps api/server.js untouched, so this stays valid across upstream
   updates; docker-compose.yml and the NixOS module never load this file.

   The overridden listen keeps the caller's callback and any other arguments. */
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.API_BIND_HOST || '127.0.0.1';

const original = net.Server.prototype.listen;

net.Server.prototype.listen = function listen(...args) {
  const [first, second, third] = args;

  if (typeof first === 'number') {
    // listen(port[, cb]) / listen(port, host[, cb])
    const callback = typeof second === 'function' ? second : third;
    return callback ? original.call(this, first, HOST, callback) : original.call(this, first, HOST);
  }

  if (first && typeof first === 'object' && typeof first.port === 'number') {
    // listen({ port, host, … }[, cb])
    const options = { ...first, host: HOST };
    return typeof second === 'function' ? original.call(this, options, second) : original.call(this, options);
  }

  // A Unix socket path or a handle: left exactly as the caller asked for it.
  return original.apply(this, args);
};

await import('../api/server.js');
