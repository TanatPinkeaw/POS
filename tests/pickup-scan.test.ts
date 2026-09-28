// Seam under test: the one box at the handover counter, and what the cashier put in
// it.
//
// This decision used to be a ternary inside a screen, where the only way to test it
// was to render the screen and the only people who could get it wrong were the ones
// typing at it. It is a shape rule with three outcomes, so it is a pure function.
import { describe, expect, it } from 'vitest';

import { createPickupToken } from '@/lib/pickup-token';
import { handoverLookupBody, looksLikePickupToken, PIN_PATTERN } from '@/lib/pickup-scan';

const ORDER = '11111111-2222-3333-4444-555555555555';

describe('a term scanned or typed at the counter', () => {
  it('routes a signed code to the code field', async () => {
    const token = await createPickupToken({
      orderId: ORDER,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });

    expect(looksLikePickupToken(token)).toBe(true);
    expect(handoverLookupBody(token)).toEqual({ pickupToken: token });
  });

  it('routes four digits to the PIN field, not to the phone field', () => {
    // A four-digit PIN is also a plausible-looking number, so the PIN wins: it is
    // the stricter shape, and a four-digit "phone number" is nobody's.
    expect(handoverLookupBody('7391')).toEqual({ pin: '7391' });
  });

  it('treats everything else as a phone number', () => {
    for (const phone of ['0812345678', '081-234-5678', '+66812345678', '02 123 4567']) {
      expect(handoverLookupBody(phone)).toEqual({ phone });
    }
  });

  it('ignores whitespace a scanner or a paste leaves behind', () => {
    expect(handoverLookupBody('  7391  ')).toEqual({ pin: '7391' });
    expect(handoverLookupBody(' 0812345678 ')).toEqual({ phone: '0812345678' });
  });

  it('never mistakes a PIN or a phone number for a code', () => {
    /*
     * The dangerous direction. Anything sent to the verifier as a code comes back
     * as "that code is not valid", so a phone number misfiled as a token sends the
     * cashier hunting for a wrong QR instead of a mistyped digit.
     */
    for (const term of ['7391', '0812345678', '081-234-5678', '', '  ', 'ก']) {
      expect(looksLikePickupToken(term), term).toBe(false);
      expect(handoverLookupBody(term), term).not.toHaveProperty('pickupToken');
    }
  });

  it('sends JWS-shaped junk to the code field, where it is refused as a code', () => {
    /*
     * `1.2.3` is three dot-separated runs of base64url characters, so by shape it is
     * a compact JWS and there is nothing in the shape to say otherwise. It is not a
     * phone number either, so the honest route is the verifier — which answers "that
     * code is not valid" rather than "no order found" for a number nobody typed.
     */
    expect(handoverLookupBody('1.2.3')).toEqual({ pickupToken: '1.2.3' });
  });

  it('does not accept a shape that only looks like a token', () => {
    // Four segments is two JWTs glued together, not a code; a lone segment is a
    // word. Both are refused by the shape test rather than by a failed verification.
    expect(looksLikePickupToken('a.b.c.d')).toBe(false);
    expect(looksLikePickupToken('eyJhbGciOiJIUzI1NiJ9')).toBe(false);
    expect(looksLikePickupToken('a.b.c')).toBe(true);
  });

  it('agrees with the schema about what a PIN is', () => {
    for (const term of ['0000', '9999', '7391']) {
      expect(PIN_PATTERN.test(term), term).toBe(true);
    }
    for (const term of ['739', '73911', '739a', '']) {
      expect(PIN_PATTERN.test(term), term).toBe(false);
    }
  });
});
