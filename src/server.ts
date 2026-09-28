/**
 * Custom server.
 *
 * Next needs to share one HTTP listener with Socket.io so that the browser
 * talks to a single origin and the session cookie authenticates both the pages
 * and the websocket. `next dev` cannot host a second listener, so the server is
 * started programmatically instead.
 */
// Must come first: it populates process.env before ./lib/db reads DATABASE_URL
// at module scope, and installs the BigInt serialiser.
import './lib/env';

import { createServer } from 'node:http';

import next from 'next';

import { startExpirySweeper, stopExpirySweeper } from './lib/expiry';
import { attachRealtime, detachRealtime } from './lib/realtime';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
// `||`, not `??`: an empty PORT in the environment would otherwise become
// Number('') === 0, which silently binds a random port.
const port = Number(process.env.PORT) || 3000;

async function main(): Promise<void> {
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();

  await app.prepare();

  const httpServer = createServer((request, response) => {
    /*
     * The socket's own address, stamped onto the request before Next builds its
     * Web `Request`, so the rate limiter has something a caller cannot choose.
     *
     * Overwritten unconditionally rather than merged: a client that sends its own
     * `x-client-address` must not get to pick which bucket it spends, and the only
     * place that knows the peer is this one. `X-Forwarded-For` is deliberately
     * *not* trusted here or discarded here — `clientAddress` decides, and it
     * believes the header only when the socket is a private address, which is the
     * shape of a proxy we run ourselves.
     */
    request.headers['x-client-address'] = request.socket.remoteAddress ?? '';
    void handle(request, response);
  });

  attachRealtime(httpServer);
  const stopSweeper = startExpirySweeper();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[server] ${signal} received, shutting down`);
    stopSweeper();
    await detachRealtime();
    httpServer.close(() => process.exit(0));
    // Do not hang forever waiting on keep-alive connections.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  httpServer.listen(port, hostname, () => {
    // Read the port back from the socket rather than echoing the requested one:
    // PORT=0 asks the OS for any free port, and logging "0" would send whoever
    // is watching the console to the wrong URL.
    const address = httpServer.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;

    console.log(
      `[server] ready on http://${hostname}:${boundPort} (${dev ? 'development' : 'production'})  ·  realtime on /realtime`,
    );
  });
}

main().catch((error: unknown) => {
  console.error('[server] failed to start', error);
  process.exit(1);
});
