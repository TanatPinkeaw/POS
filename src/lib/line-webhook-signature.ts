/**
 * Verifying the signature a LINE platform webhook arrives with (ADR 0030 §4).
 *
 * The Messaging API signs every webhook POST with an HMAC-SHA256 of the **raw
 * request body** under the channel secret, base64-encoded, in `x-line-signature`.
 * Verifying the transformed body — the parsed object re-stringified, the buffer
 * decoded — is the classic way this door fails: two JSONs that mean the same thing
 * are not two strings that hash the same, so the check runs over the bytes that
 * arrived and nothing else.
 *
 * `node:crypto` rather than `jose`, and that is not habit: jose speaks JWS, and
 * LINE's signature is not a JWS — it is a bare HMAC over the body with no header,
 * no payload framing and nothing to wrap. Forcing it into a JWS-shaped envelope to
 * keep one import would be ceremony; the repository already reaches for
 * `node:crypto` where the primitive is plain (the random password hash in
 * `identity.ts`). `timingSafeEqual` is the comparison, because a signature check
 * that leaks how much of the guess was right is a guessing aid.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The signature LINE sent, as it arrived. */
export const LINE_SIGNATURE_HEADER = 'x-line-signature';

/** Raised when the signature header is missing or does not match the body. */
export class InvalidLineSignatureError extends Error {
  constructor(message = 'LINE webhook signature did not verify') {
    super(message);
    this.name = 'InvalidLineSignatureError';
  }
}

/** The Messaging API channel secret, or null when the webhook is unconfigured. */
export function readLineChannelSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const secret = env.LINE_MESSAGING_CHANNEL_SECRET?.trim();
  return secret && secret.length > 0 ? secret : null;
}

/** What verifying produces: the HMAC itself, for the one caller that compares it. */
function expectedSignature(rawBody: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest();
}

/**
 * Checks a webhook request, or refuses it.
 *
 * `signature` may be null — a request without the header is a request nobody
 * vouched for, which is the case worth refusing, not the case worth tolerating.
 * The comparison is over the decoded bytes rather than the strings, because a
 * base64 re-encoding can differ in padding and still name the same HMAC.
 *
 * `secret` is injectable so tests drive this without `.env`.
 */
export function verifyLineWebhookSignature(input: {
  /** The exact text the request body arrived as. */
  rawBody: string;
  /** The `x-line-signature` value, or null when the header is absent. */
  signature: string | null;
  /** The channel secret; injectable so tests drive it without `.env`. */
  secret?: string;
}): void {
  const secret = input.secret ?? readLineChannelSecret();
  if (!secret) {
    throw new InvalidLineSignatureError('LINE_MESSAGING_CHANNEL_SECRET is not set');
  }
  if (!input.signature) {
    throw new InvalidLineSignatureError('the request carried no x-line-signature');
  }

  const expected = expectedSignature(input.rawBody, secret);
  const provided = Buffer.from(input.signature, 'base64');

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new InvalidLineSignatureError('the signature did not match the body');
  }
}
