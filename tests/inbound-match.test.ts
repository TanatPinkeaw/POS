// Seam under test: deciding which bill a bank transfer pays.
//
// This is the one place in the automatic path where a mistake moves money onto
// the wrong bill, and it is a pure function precisely so that every way it can be
// wrong is enumerable here — no database, no clock, no socket. The cases that
// matter most are the refusals: an amount on its own, two candidates for one
// amount, and money that arrives after the QR it was meant for was withdrawn.
import { describe, expect, it } from 'vitest';

import {
  containsReference,
  matchInboundTransfer,
  type IntentCandidate,
} from '@/lib/inbound-match';

const AT = new Date('2026-09-28T10:00:00Z');

function candidate(overrides: Partial<IntentCandidate> = {}): IntentCandidate {
  return {
    ref: 'K7M2QX',
    amountThb: 107,
    status: 'pending',
    expiresAt: new Date('2026-09-28T10:05:00Z'),
    ...overrides,
  };
}

describe('matching a transfer to a bill', () => {
  it('answers the bill whose reference the notification names', () => {
    const match = matchInboundTransfer(
      { amountThb: 107, text: 'K7M2QX', receivedAt: AT },
      [candidate()],
    );
    expect(match).toEqual({ matched: true, ref: 'K7M2QX' });
  });

  it('reads the reference out of whatever prose the bank wrapped it in', () => {
    // Real notifications look like this: an amount, a payer's name, and the memo
    // the customer typed. The reference is in there, punctuated.
    const match = matchInboundTransfer(
      {
        amountThb: 107,
        text: 'รับเงินโอน 107.00 บาท จาก นายสมชาย (K7M2QX) วันที่ 28/09/2026',
        receivedAt: AT,
      },
      [candidate()],
    );
    expect(match).toEqual({ matched: true, ref: 'K7M2QX' });
  });

  it('does not care about case, because the reference alphabet has no vowels', () => {
    // The alphabet excludes A/E/I/O/U, 0/1/I/O, so folding case cannot make two
    // different references collide.
    const match = matchInboundTransfer(
      { amountThb: 107, text: 'memo: k7m2qx', receivedAt: AT },
      [candidate()],
    );
    expect(match).toEqual({ matched: true, ref: 'K7M2QX' });
  });

  it('compares money in satang, so a hundredth is a different bill', () => {
    const oneSatangShort = matchInboundTransfer(
      { amountThb: 106.99, text: 'K7M2QX', receivedAt: AT },
      [candidate()],
    );
    expect(oneSatangShort).toEqual({ matched: false, reason: 'no_amount_match', refs: [] });
  });

  it('refuses to close a bill when the notification does not say which one', () => {
    /*
     * An amount alone is not evidence. Two customers in one queue can owe 107.00,
     * and this is the case where guessing sends somebody home with somebody
     * else's receipt — so the money is recorded as unattributed instead.
     */
    const match = matchInboundTransfer(
      { amountThb: 107, text: 'รับเงินโอน 107.00 บาท', receivedAt: AT },
      [candidate(), candidate({ ref: 'P4NJ8T' })],
    );
    expect(match).toEqual({
      matched: false,
      reason: 'no_reference',
      refs: ['K7M2QX', 'P4NJ8T'],
    });
  });

  it('names the live candidates when it refuses, so a person can finish the job', () => {
    const match = matchInboundTransfer(
      { amountThb: 107, text: 'รับเงินโอน 107.00 บาท', receivedAt: AT },
      [candidate()],
    );
    expect(match).toEqual({ matched: false, reason: 'no_reference', refs: ['K7M2QX'] });
  });

  it('refuses when the notification quotes two references at once', () => {
    const match = matchInboundTransfer(
      { amountThb: 107, text: 'K7M2QX / P4NJ8T', receivedAt: AT },
      [candidate(), candidate({ ref: 'P4NJ8T' })],
    );
    expect(match).toEqual({
      matched: false,
      reason: 'ambiguous',
      refs: ['K7M2QX', 'P4NJ8T'],
    });
  });

  it('refuses money that arrives after the QR was withdrawn', () => {
    const match = matchInboundTransfer(
      { amountThb: 107, text: 'K7M2QX', receivedAt: AT },
      [candidate({ expiresAt: new Date('2026-09-28T09:59:59Z') })],
    );
    expect(match).toEqual({ matched: false, reason: 'not_payable', refs: ['K7M2QX'] });
  });

  it('draws the expiry line exactly where the database draws it', () => {
    // `payment_intents` is payable while `expires_at > now()`, and this has to be
    // the same inequality or a QR would be matchable for one instant after the
    // till had already stopped showing it.
    const atTheDeadline = matchInboundTransfer(
      { amountThb: 107, text: 'K7M2QX', receivedAt: new Date('2026-09-28T10:05:00Z') },
      [candidate()],
    );
    expect(atTheDeadline).toEqual({ matched: false, reason: 'not_payable', refs: ['K7M2QX'] });

    const oneMillisecondBefore = matchInboundTransfer(
      { amountThb: 107, text: 'K7M2QX', receivedAt: new Date('2026-09-28T10:04:59.999Z') },
      [candidate()],
    );
    expect(oneMillisecondBefore).toEqual({ matched: true, ref: 'K7M2QX' });
  });

  it('refuses a bill that was already closed', () => {
    // The second of two notifications for one transfer: the money is real and has
    // to be recorded, but the bill it names is paid, so it cannot pay another.
    const match = matchInboundTransfer(
      { amountThb: 107, text: 'K7M2QX', receivedAt: AT },
      [candidate({ status: 'consumed' })],
    );
    expect(match).toEqual({ matched: false, reason: 'not_payable', refs: ['K7M2QX'] });
  });

  it('matches on the amount before it looks at the reference', () => {
    // A notification that quotes a real reference for a different amount is a
    // mistyped transfer, not a payment: the amount is the thing the bank is
    // vouching for, so it decides first.
    const match = matchInboundTransfer(
      { amountThb: 200, text: 'K7M2QX', receivedAt: AT },
      [candidate()],
    );
    expect(match).toEqual({ matched: false, reason: 'no_amount_match', refs: [] });
  });
});

describe('finding a reference in a notification', () => {
  it('needs the whole reference, not a fragment of it', () => {
    expect(containsReference('memo K7M2Q', 'K7M2QX')).toBe(false);
    expect(containsReference('memo K7M2QXX', 'K7M2QX')).toBe(false);
  });

  it('accepts any punctuation the bank chose to put around it', () => {
    for (const text of ['K7M2QX', '(K7M2QX)', 'ref:K7M2QX', '[K7M2QX]', 'a.K7M2QX.b']) {
      expect(containsReference(text, 'K7M2QX'), text).toBe(true);
    }
  });

  it('will not read a reference out of the middle of a longer word or number', () => {
    // Joining a notification's tokens before searching would happily read
    // "0K7M2QX9" as a reference. It is not one, and this is what stops that.
    expect(containsReference('0K7M2QX9', 'K7M2QX')).toBe(false);
    expect(containsReference('XXK7M2QXXX', 'K7M2QX')).toBe(false);
  });

  it('finds a reference that is the entire notification', () => {
    expect(containsReference('K7M2QX', 'K7M2QX')).toBe(true);
  });
});
