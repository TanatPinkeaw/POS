// Seam under test: the signature a LINE webhook arrives with.
//
// The webhook is an unauthenticated door that writes rows, so the signature is
// the whole of its authentication. The cases worth pinning are the ones a real
// deployment meets: the honest request, a tampered body, a missing header, a
// wrong secret, and — the classic failure of this check — verifying the
// re-serialized body instead of the bytes that arrived.
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  InvalidLineSignatureError,
  readLineChannelSecret,
  verifyLineWebhookSignature,
} from '@/lib/line-webhook-signature';

const SECRET = 'a-channel-secret-of-line-s proportions';

/** The signature LINE would send for this body. */
function sign(rawBody: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

const BODY = JSON.stringify({
  destination: 'U1234',
  events: [{ type: 'follow', source: { userId: 'Uabc' } }],
});

describe('a LINE webhook signature', () => {
  it('accepts the honest request', () => {
    expect(() =>
      verifyLineWebhookSignature({ rawBody: BODY, signature: sign(BODY), secret: SECRET }),
    ).not.toThrow();
  });

  it('refuses a body that was tampered with after signing', () => {
    // One character different in the body is a different HMAC — the check that
    // makes "record a friend nobody added" impossible.
    const tampered = BODY.replace('follow', 'unfollow');
    expect(() =>
      verifyLineWebhookSignature({ rawBody: tampered, signature: sign(BODY), secret: SECRET }),
    ).toThrow(InvalidLineSignatureError);
  });

  it('refuses a request with no signature header', () => {
    expect(() =>
      verifyLineWebhookSignature({ rawBody: BODY, signature: null, secret: SECRET }),
    ).toThrow(InvalidLineSignatureError);
  });

  it('refuses a signature made under another secret', () => {
    expect(() =>
      verifyLineWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY, 'another-shop-secret'),
        secret: SECRET,
      }),
    ).toThrow(InvalidLineSignatureError);
  });

  it('refuses a signature that is not base64 at all', () => {
    expect(() =>
      verifyLineWebhookSignature({ rawBody: BODY, signature: 'not-a-signature', secret: SECRET }),
    ).toThrow(InvalidLineSignatureError);
  });

  it('is exact about the bytes: a differently-spelled body does not match', () => {
    /*
     * The same JSON spelled differently — spaces added, the way a proxy or a
     * debugging tool reprints it — means the same thing and hashes differently.
     * That is the reason the route reads the raw text once and signs exactly
     * those bytes: any transform between arrival and verification breaks the
     * check in both directions.
     */
    const respaced = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(respaced).not.toBe(BODY);
    expect(() =>
      verifyLineWebhookSignature({ rawBody: respaced, signature: sign(BODY), secret: SECRET }),
    ).toThrow(InvalidLineSignatureError);
  });

  it('refuses to verify when no channel secret is configured', () => {
    expect(() =>
      verifyLineWebhookSignature({ rawBody: BODY, signature: sign(BODY), secret: '' }),
    ).toThrow(InvalidLineSignatureError);
  });
});

describe('the configured channel secret', () => {
  it('is nothing when unset or blank', () => {
    expect(readLineChannelSecret({})).toBeNull();
    expect(readLineChannelSecret({ LINE_MESSAGING_CHANNEL_SECRET: '   ' })).toBeNull();
  });

  it('is trimmed when set', () => {
    expect(readLineChannelSecret({ LINE_MESSAGING_CHANNEL_SECRET: ' abc ' })).toBe('abc');
  });
});
