// Seam under test: the privacy notice a customer is shown when they create an account.
//
// The shop's duty to inform is discharged by the customer actually being told, and this
// is the only moment a shop can be certain of that for a walk-in — an account created at
// the counter by a member of staff never sees a screen (ADR 0011). So these tests pin
// three things and nothing about identity, which `customer-signup.test.ts` already owns:
//
//   1. a signup that creates an account demands the notice;
//   2. a version that is not the current one is refused, so a stale browser is stopped
//      rather than allowed to acknowledge text that has been revised;
//   3. the customer and the acknowledgement land together, or neither does.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ValidationError } from '@/lib/errors';
import { completeCustomerGoogleSignIn, findCustomerByGoogleSubject } from '@/lib/identity';
import {
  CURRENT_CUSTOMER_NOTICE_VERSION,
  hasReachedNoticeEnd,
  isCurrentCustomerNotice,
  latestNoticeVersionFor,
  NOTICE_SCROLL_TOLERANCE_PX,
  noticeEffectiveDateLabel,
} from '@/lib/privacy-notice';

import { prisma, resetDatabase, seedPeople } from './helpers/test-db';

function google(subject: string) {
  return {
    subject,
    email: `${subject}@example.com`,
    emailVerified: true,
    fullName: 'สมชาย จากกูเกิล',
  };
}

beforeEach(async () => {
  await resetDatabase();
  await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the notice a signup must acknowledge', () => {
  it('refuses to make a customer when none was acknowledged', async () => {
    const failure = (await completeCustomerGoogleSignIn({
      identity: google('silent'),
      phone: '0892223333',
    }).catch((error: unknown) => error)) as ValidationError;

    expect(failure.code).toBe('VALIDATION_ERROR');
    expect(failure.message).toContain('นโยบาย');
    // The refusal must be total, not a warning: the account is the thing that makes the
    // shop liable, so a customer who skipped the notice and got one anyway would be the
    // exact state this gate exists to prevent.
    expect(await findCustomerByGoogleSubject('silent')).toBeNull();
  });

  it('refuses a version the shop has since revised', async () => {
    const failure = (await completeCustomerGoogleSignIn({
      identity: google('stale'),
      phone: '0892223334',
      noticeVersion: '2026-01-01',
    }).catch((error: unknown) => error)) as ValidationError;

    expect(failure.code).toBe('VALIDATION_ERROR');
    expect(await findCustomerByGoogleSubject('stale')).toBeNull();
  });

  it('refuses an empty version, because trim() would otherwise turn a blank into one', async () => {
    const failure = (await completeCustomerGoogleSignIn({
      identity: google('blank'),
      phone: '0892223335',
      noticeVersion: '   ',
    }).catch((error: unknown) => error)) as ValidationError;

    expect(failure.code).toBe('VALIDATION_ERROR');
  });

  it('makes the customer and records the version they read', async () => {
    const customer = await completeCustomerGoogleSignIn({
      identity: google('reading'),
      phone: '0892223336',
      noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
    });

    expect(customer.created).toBe(true);
    expect(await latestNoticeVersionFor(prisma, customer.id)).toBe(
      CURRENT_CUSTOMER_NOTICE_VERSION,
    );
  });

  it('keeps the version where the shop can read it back', async () => {
    const customer = await completeCustomerGoogleSignIn({
      identity: google('auditable'),
      phone: '0892223337',
      noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
    });

    const row = await prisma.notice_acknowledgements.findFirstOrThrow({
      where: { customer_user_id: customer.id },
    });

    // The path, not a copy of the text: the notice is rendered from the shop's own row
    // and will change, and a stored second copy is how two retention promises start
    // disagreeing.
    expect(row.notice_url).toBe('/privacy');
    expect(row.notice_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.acknowledged_at.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
  });

  it('writes the version into the member_created audit row too', async () => {
    const customer = await completeCustomerGoogleSignIn({
      identity: google('trailed'),
      phone: '0892223338',
      noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
    });

    const audit = await prisma.audit_logs.findFirstOrThrow({
      where: { action: 'member_created', target_id: customer.id },
    });
    const detail = audit.detail as { noticeVersion?: string } | null;

    // The trail and the evidence must not be readable as saying different things: an
    // owner auditing "was this person told?" reads the trail first.
    expect(detail?.noticeVersion).toBe(CURRENT_CUSTOMER_NOTICE_VERSION);
  });

  it('does not demand a notice from a customer who already has one', async () => {
    const first = await completeCustomerGoogleSignIn({
      identity: google('returning'),
      phone: '0892223339',
      noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
    });
    expect(first.created).toBe(true);

    // A returning customer was told when they arrived. Asking again would ask a shop to
    // re-collect what it already holds, and would refuse every account that predates
    // this table — including the seeded ones.
    const second = await completeCustomerGoogleSignIn({ identity: google('returning') });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });
});

describe('the scroll gate that unlocks the tick', () => {
  // A box 200px tall showing 600px of notice — the shape a phone actually produces.
  const client = 200;
  const scroll = 600;

  it('starts locked, so the tick cannot be taken before the notice is read', () => {
    expect(hasReachedNoticeEnd(0, client, scroll)).toBe(false);
  });

  it('stays locked one pixel short of the end', () => {
    const short = scroll - client - NOTICE_SCROLL_TOLERANCE_PX - 1;
    expect(hasReachedNoticeEnd(short, client, scroll)).toBe(false);
  });

  it('opens at the bottom, and a pixel before it thanks to the tolerance', () => {
    const exact = scroll - client;
    expect(hasReachedNoticeEnd(exact, client, scroll)).toBe(true);
    expect(hasReachedNoticeEnd(exact - NOTICE_SCROLL_TOLERANCE_PX, client, scroll)).toBe(true);
  });

  it('opens for a notice short enough to have no scroll at all', () => {
    // Otherwise the gate is unreachable on a short notice — a customer can see the
    // whole thing and still be refused the tick, with nothing to do about it.
    expect(hasReachedNoticeEnd(0, 400, 400)).toBe(true);
    expect(hasReachedNoticeEnd(0, 400, 399)).toBe(true);
  });

  it('opens on a bounce past the end, which a phone will do on its own', () => {
    // Rubber-banding reports a scrollTop beyond the real maximum on iOS. A gate that
    // stayed shut there would be a gate that never opened on the device most likely to
    // overscroll.
    expect(hasReachedNoticeEnd(500, client, scroll)).toBe(true);
  });

  it('forgives a partial last paragraph but not a whole one', () => {
    // The tolerance is small on purpose: big enough for a finger to overshoot by, far
    // smaller than a line, so it cannot open while a paragraph is still off screen.
    expect(NOTICE_SCROLL_TOLERANCE_PX).toBeLessThan(40);
  });
});

describe('the version itself', () => {
  it('is the effective date, so the page and the signup cannot name different days', () => {
    // One value, not two: a version bumped without a new date produces acknowledgements
    // that look current and are not.
    expect(CURRENT_CUSTOMER_NOTICE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isCurrentCustomerNotice(CURRENT_CUSTOMER_NOTICE_VERSION)).toBe(true);
    expect(isCurrentCustomerNotice(undefined)).toBe(false);
    expect(isCurrentCustomerNotice('')).toBe(false);
    expect(isCurrentCustomerNotice('2026-10-04')).toBe(false);
  });

  it('reads as a Buddhist-era date, because the shop\'s tax documents are', () => {
    expect(noticeEffectiveDateLabel('2026-10-03')).toBe('3 ตุลาคม 2569');
    expect(noticeEffectiveDateLabel('2026-01-01')).toBe('1 มกราคม 2569');
  });

  it('refuses a Buddhist-era year written where a Gregorian one belongs', () => {
    // `2569-10-03` is a well-formed ISO date, so nothing about its shape gives it away.
    // It is the mistake somebody editing this constant actually makes, because every
    // date a Thai person writes down is in BE — and converting it would print
    // "3 ตุลาคม 3112", which reads like a real date rather than like a bug.
    expect(() => noticeEffectiveDateLabel('2569-10-03')).toThrow(/Buddhist-era/);
  });

  it('refuses a malformed date rather than printing one nobody can read', () => {
    expect(() => noticeEffectiveDateLabel('2026-10')).toThrow(/ISO/);
    expect(() => noticeEffectiveDateLabel('3 ตุลาคม 2569')).toThrow(/ISO/);
    expect(() => noticeEffectiveDateLabel('2026-13-01')).toThrow(/month/);
  });
});