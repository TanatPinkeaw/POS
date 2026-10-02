// Seam under test: the link a customer carries a receipt away on (ADR 0021 §3).
//
// It is a bearer credential for somebody's tax document, so the tests are mostly
// about what must *not* work: a link from last week, a link with one character
// changed, the subject swapped for another order, and — the one that would let a
// signed-in customer or a parcel code open a receipt — a token of a different
// audience. Then the positive half: a fresh link per issue, and an expiry that can
// never outlive the month it was granted under.
import { describe, expect, it } from 'vitest';

import { DomainError } from '@/lib/errors';
import { createPickupToken } from '@/lib/pickup-token';
import {
  createReceiptLink,
  createReceiptToken,
  InvalidReceiptLinkError,
  receiptLinkExpiry,
  verifyReceiptToken,
} from '@/lib/receipt-link';
import { createSessionToken } from '@/lib/session-token';

const ORDER = '11111111-2222-3333-4444-555555555555';
const OTHER_ORDER = '99999999-8888-7777-6666-555555555555';
const DAY_MS = 24 * 60 * 60 * 1000;

function inMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

describe('a receipt link', () => {
  it('names the order it was issued for', async () => {
    const token = await createReceiptToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    expect(await verifyReceiptToken(token)).toEqual({ orderId: ORDER });
  });

  it('names only that order, so one link cannot show another receipt', async () => {
    const mine = await createReceiptToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    const theirs = await createReceiptToken({ orderId: OTHER_ORDER, expiresAt: inMinutes(30) });

    expect((await verifyReceiptToken(mine)).orderId).toBe(ORDER);
    expect((await verifyReceiptToken(theirs)).orderId).toBe(OTHER_ORDER);
  });

  it('stops working when it expires', async () => {
    const token = await createReceiptToken({ orderId: ORDER, expiresAt: inMinutes(-1) });
    await expect(verifyReceiptToken(token)).rejects.toBeInstanceOf(InvalidReceiptLinkError);
  });

  it('refuses a link with one character changed', async () => {
    const token = await createReceiptToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    const [header, payload, signature] = token.split('.');
    // Flipped rather than overwritten with a fixed character: replacing the last
    // character with an `X` would leave the token untouched whenever it already
    // ended in one, and the test would pass without testing anything.
    const flipped = signature!.startsWith('A') ? 'B' : 'A';
    const tampered = `${header}.${payload}.${flipped}${signature!.slice(1)}`;

    await expect(verifyReceiptToken(tampered)).rejects.toBeInstanceOf(InvalidReceiptLinkError);
  });

  it('refuses a payload that was swapped for another order', async () => {
    /*
     * The attack this exists for: keep the signature, replace the subject. It only
     * fails because the signature covers the payload — the entire reason this is a
     * signed token rather than an order id written in base64.
     */
    const mine = await createReceiptToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    const theirs = await createReceiptToken({ orderId: OTHER_ORDER, expiresAt: inMinutes(30) });
    const [header, , signature] = mine.split('.');
    const [, theirPayload] = theirs.split('.');

    await expect(verifyReceiptToken(`${header}.${theirPayload}.${signature}`)).rejects.toBeInstanceOf(
      InvalidReceiptLinkError,
    );
  });

  it('will not accept a session token, even though both are signed with one key', async () => {
    // Different audience on purpose: without that claim a signed-in customer could
    // present their own session where a receipt link is expected.
    const session = await createSessionToken({
      id: 'a-user',
      role: 'member',
      fullName: 'ลูกค้า',
      phone: '0900000001',
    });

    await expect(verifyReceiptToken(session)).rejects.toBeInstanceOf(InvalidReceiptLinkError);
  });

  it('will not accept a pickup code, though both are scoped tokens', async () => {
    // A parcel code names an order too, so the only thing separating the two is the
    // audience — which is exactly what this asserts.
    const pickup = await createPickupToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    await expect(verifyReceiptToken(pickup)).rejects.toBeInstanceOf(InvalidReceiptLinkError);
  });

  it('refuses junk without pretending to know what it was', async () => {
    for (const junk of ['', '1234', 'not.a.token', 'a.b.c', 'K7M2QX']) {
      await expect(verifyReceiptToken(junk), junk).rejects.toBeInstanceOf(InvalidReceiptLinkError);
    }
  });

  it('fails as a domain error a customer can act on, not a 500', async () => {
    const failure = await verifyReceiptToken('not.a.token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).httpStatus).toBe(422);
    expect((failure as DomainError).code).toBe('INVALID_RECEIPT_LINK');
  });

  it('reissues a fresh token each time rather than handing back a stable one', async () => {
    // The `jti`: two links for one order are never the same string, so one leaked
    // link does not become the permanent key to the order.
    const first = await createReceiptToken({ orderId: ORDER, expiresAt: inMinutes(30) });
    const second = await createReceiptToken({ orderId: ORDER, expiresAt: inMinutes(30) });

    expect(first).not.toBe(second);
    expect((await verifyReceiptToken(first)).orderId).toBe(ORDER);
    expect((await verifyReceiptToken(second)).orderId).toBe(ORDER);
  });
});

describe('when a link expires', () => {
  const now = new Date('2026-10-01T07:00:00.000Z');
  /** A sale completed 1 hour before `now`. */
  const soldAt = new Date(now.getTime() - 60 * 60 * 1000);

  it('uses the link\'s own short life when that comes first', () => {
    const expiry = receiptLinkExpiry({ soldAt, now, ttlMinutes: 60, days: 30 });
    expect(expiry?.getTime()).toBe(now.getTime() + 60 * 60 * 1000);
  });

  it('is capped by the window, so a long-lived link cannot outlive the month', () => {
    const ttlMinutes = 60 * 24 * 30 * 4; // four months, far past the window
    const expiry = receiptLinkExpiry({ soldAt, now, ttlMinutes, days: 30 });

    expect(expiry?.getTime()).toBe(soldAt.getTime() + 30 * DAY_MS);
    expect(expiry!.getTime()).toBeLessThan(now.getTime() + ttlMinutes * 60_000);
  });

  it('is nothing at all once the window has closed', () => {
    const old = new Date(now.getTime() - 40 * DAY_MS);
    expect(receiptLinkExpiry({ soldAt: old, now, ttlMinutes: 60, days: 30 })).toBeNull();
  });

  it('mints a working link inside the window and none outside it', async () => {
    // Minted against the real clock, because verification compares the token's `exp`
    // to `Date.now()` — a token minted "now" in a synthetic past would be born
    // expired. The pure expiry tests above keep their fixed instants.
    const live = await createReceiptLink({ orderId: ORDER, soldAt: new Date(Date.now() - 60_000) });
    expect(live).not.toBeNull();
    expect((await verifyReceiptToken(live!)).orderId).toBe(ORDER);

    const old = new Date(Date.now() - 40 * DAY_MS);
    expect(await createReceiptLink({ orderId: ORDER, soldAt: old })).toBeNull();
  });
});
