// Seam under test: the code a customer shows to collect a parcel.
//
// It is a bearer credential for somebody's shopping, so the tests are mostly about
// what must *not* work: a code from last week, a code with one character changed,
// and — the one that would quietly turn every logged-in member into a parcel
// collector — an ordinary session token presented as a pickup code.
import { describe, expect, it } from 'vitest';

import { DomainError } from '@/lib/errors';
import { createPickupToken, InvalidPickupTokenError, verifyPickupToken } from '@/lib/pickup-token';
import { createSessionToken } from '@/lib/session-token';

const ORDER = '11111111-2222-3333-4444-555555555555';
const OTHER_ORDER = '99999999-8888-7777-6666-555555555555';

function inMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

describe('a pickup code', () => {
  it('names the order it was issued for', async () => {
    const token = await createPickupToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    expect(await verifyPickupToken(token)).toEqual({ orderId: ORDER });
  });

  it('names only that order, so one code cannot collect another parcel', async () => {
    // Two codes, side by side: the token carries the order, and it does not drift.
    const mine = await createPickupToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    const theirs = await createPickupToken({ orderId: OTHER_ORDER, expiresAt: inMinutes(30) });

    expect((await verifyPickupToken(mine)).orderId).toBe(ORDER);
    expect((await verifyPickupToken(theirs)).orderId).toBe(OTHER_ORDER);
  });

  it('stops working when the hold does', async () => {
    const token = await createPickupToken({ orderId: ORDER, expiresAt: inMinutes(-1) });
    await expect(verifyPickupToken(token)).rejects.toBeInstanceOf(InvalidPickupTokenError);
  });

  it('refuses a code with one character changed', async () => {
    const token = await createPickupToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    const [header, payload, signature] = token.split('.');
    // Flipped rather than overwritten with a fixed character: replacing the last
    // character with an `X` would leave the token untouched whenever it already
    // ended in one, and the test would pass without testing anything.
    const flipped = signature!.startsWith('A') ? 'B' : 'A';
    const tampered = `${header}.${payload}.${flipped}${signature!.slice(1)}`;

    await expect(verifyPickupToken(tampered)).rejects.toBeInstanceOf(InvalidPickupTokenError);
  });

  it('refuses a payload that was swapped for another order', async () => {
    /*
     * The attack this exists for: keep the signature, replace the subject. It only
     * fails because the signature covers the payload — which is the entire reason
     * this is a signed token rather than an id written in base64.
     */
    const mine = await createPickupToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    const theirs = await createPickupToken({ orderId: OTHER_ORDER, expiresAt: inMinutes(30) });
    const [header, , signature] = mine.split('.');
    const [, theirPayload] = theirs.split('.');

    await expect(verifyPickupToken(`${header}.${theirPayload}.${signature}`)).rejects.toBeInstanceOf(
      InvalidPickupTokenError,
    );
  });

  it('will not accept a session token, even though both are signed with one key', async () => {
    // Different audience, on purpose. Without that claim a signed-in member could
    // present their own session to the till and walk out with somebody else's bag.
    const session = await createSessionToken({
      id: 'a-user',
      role: 'member',
      fullName: 'ลูกค้า',
      phone: '0900000001',
    });

    await expect(verifyPickupToken(session)).rejects.toBeInstanceOf(InvalidPickupTokenError);
  });

  it('refuses junk without pretending to know what it was', async () => {
    for (const junk of ['', '1234', 'not.a.token', 'a.b.c', 'K7M2QX']) {
      await expect(verifyPickupToken(junk), junk).rejects.toBeInstanceOf(InvalidPickupTokenError);
    }
  });

  it('fails as a domain error, so the cashier is told rather than paged', async () => {
    /*
     * The status is part of the contract, not an implementation detail: `withApi`
     * maps `DomainError` onto HTTP and flattens everything else to a 500. A stale
     * QR is a 422 with words a person can act on ("use the PIN, reprint the code");
     * a 500 is a support call about a bug that does not exist.
     */
    const failure = await verifyPickupToken('not.a.token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).httpStatus).toBe(422);
    expect((failure as DomainError).code).toBe('INVALID_PICKUP_CODE');
  });
});
