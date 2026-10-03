/**
 * `npm run otp:gateway` — a local stand-in for the SMS provider behind the OTP door.
 *
 * The sign-in OTP goes out through a *seam* (ADR 0020 §5, `src/lib/otp.ts`): the app
 * POSTs `{ to, code, kind, text }` to whatever `OTP_WEBHOOK_URL` names, and any 2xx
 * means it was delivered. In production that URL points at an SMS gateway. On a
 * developer's machine it can point here, and the code is printed instead of texted —
 * which is what lets a first Google sign-in be walked through end to end without a
 * provider account or a real phone.
 *
 * It is deliberately dumb: no storage, no checking (the app does that, in
 * `otp-store.ts`), no provider SDK. It holds the shared secret only so that the
 * header the app sends is exercised the same way a real gateway would check it.
 *
 * Usage:
 *   npm run otp:gateway                 listen on OTP_GATEWAY_PORT, or 4100
 *   npm run otp:gateway -- --port 4200  listen somewhere else
 *
 * Then point the app at it in `.env` and restart it:
 *   OTP_CHANNEL="webhook"
 *   OTP_WEBHOOK_URL="http://localhost:4100/otp"
 *   OTP_WEBHOOK_SECRET=""            leave empty to accept any caller
 *
 * This is a development convenience and never runs in a shop: it writes a one-time
 * code to a terminal, which is fine on your own machine and nowhere else.
 */
import { createServer } from 'node:http';

import { loadEnv } from './harness';

loadEnv();

const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const port = portIndex === -1 ? Number(process.env.OTP_GATEWAY_PORT ?? '4100') : Number(argv[portIndex + 1]);

/** The same secret the app sends in `x-otp-secret`, or null to accept any caller. */
const secret = process.env.OTP_WEBHOOK_SECRET?.trim() || null;

interface OtpBody {
  to?: string;
  code?: string;
  text?: string;
  kind?: string;
}

function json(response: import('node:http').ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const server = createServer((request, response) => {
  // A browser can hit this to check the gateway is the one running.
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('OTP gateway is up. The app posts codes to POST /otp.\n');
    return;
  }

  if (request.method !== 'POST') {
    json(response, 405, { error: 'method not allowed' });
    return;
  }

  if (secret !== null && request.headers['x-otp-secret'] !== secret) {
    console.warn('[otp-gateway] refused a request whose x-otp-secret did not match');
    json(response, 401, { error: 'bad secret' });
    return;
  }

  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    let body: OtpBody = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtpBody;
    } catch {
      // A gateway that fails the app is worse than one that logs junk.
    }

    const to = body.to ?? '(no number)';
    const code = body.code ?? '(no code)';
    /* The one line that matters: the code, readable off the screen. */
    console.log(`[otp-gateway] → ${to}   รหัสยืนยัน: ${code}`);

    json(response, 200, { ok: true });
  });
});

server.listen(port, () => {
  console.log(`[otp-gateway] listening on http://localhost:${port}/otp`);
  console.log(`[otp-gateway] secret: ${secret === null ? 'not required' : 'required'}`);
  console.log('[otp-gateway] every code the app sends will be printed below.');
});
