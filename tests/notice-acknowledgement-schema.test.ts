// Seam under test: the `notice_acknowledgements` table as *database* rules.
//
// A notice acknowledgement is the shop's evidence that it told a customer what it does
// with their data, so the rules protecting it belong in the database rather than in the
// code path that happens to write it. Every future caller — the counter flow, a hosted
// deployment, an admin tool — inherits these, and none of them has to remember them.
//
// The two rules that are load-bearing:
//   * the version is an ISO date, because the stored value is what the shop compares
//     against the current notice to answer "were they told the text we show now?";
//   * the row outlives the account, because a shop that cannot produce the evidence
//     after the customer closed their account cannot produce it at all.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_CUSTOMER_NOTICE_VERSION } from '@/lib/privacy-notice';

import { prisma, resetDatabase, seedPeople } from './helpers/test-db';

let memberId: string;

beforeEach(async () => {
  await resetDatabase();
  const people = await seedPeople();
  memberId = people.memberId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('what a customer was told', () => {
  it('round-trips the version, the path and the instant', async () => {
    const row = await prisma.notice_acknowledgements.create({
      data: { customer_user_id: memberId, notice_version: '2026-10-03' },
    });

    expect(row.notice_version).toBe('2026-10-03');
    expect(row.notice_url).toBe('/privacy');
    expect(row.acknowledged_at).toBeInstanceOf(Date);
  });

  it('refuses a version that is not a date', async () => {
    // The reason the version *is* the effective date rather than a counter: `v2` and
    // `2` are both meaningless next to `2026-10-03` and neither sorts with it. A CHECK
    // is what stops a refactor quietly changing the format and leaving the shop holding
    // a mix of two that still looks sortable.
    await expect(
      prisma.notice_acknowledgements.create({
        data: { customer_user_id: memberId, notice_version: 'v2' },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.notice_acknowledgements.create({
        data: { customer_user_id: memberId, notice_version: '2569-10-03' },
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses an instant from the future', async () => {
    // A browser clock is a number the customer chose. The row is the shop's record, so
    // it takes the server's — and the tolerance is minutes, not days, because a clock
    // an hour wrong is a clock worth investigating rather than absorbing.
    await expect(
      prisma.notice_acknowledgements.create({
        data: {
          customer_user_id: memberId,
          notice_version: CURRENT_CUSTOMER_NOTICE_VERSION,
          acknowledged_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      }),
    ).rejects.toThrow();
  });

  it('survives the account it is about', async () => {
    await prisma.notice_acknowledgements.create({
      data: { customer_user_id: memberId, notice_version: CURRENT_CUSTOMER_NOTICE_VERSION },
    });

    // RESTRICT, unlike every other table pointing at a person. The row holds an id, a
    // version and a date — nothing about the customer — so it can outlive the profile,
    // and a shop asked to prove it informed somebody months later can still do it.
    // This is also the honest answer to a deletion request that reaches this far: the
    // proof outlives the account, not the other way round.
    await expect(prisma.users.delete({ where: { id: memberId } })).rejects.toThrow();
  });

  it('keeps every acknowledgement, so a revised notice does not rewrite the past', async () => {
    await prisma.notice_acknowledgements.create({
      data: { customer_user_id: memberId, notice_version: '2026-09-01' },
    });
    await prisma.notice_acknowledgements.create({
      data: { customer_user_id: memberId, notice_version: CURRENT_CUSTOMER_NOTICE_VERSION },
    });

    const rows = await prisma.notice_acknowledgements.findMany({
      where: { customer_user_id: memberId },
      orderBy: { acknowledged_at: 'asc' },
    });

    // Append-only, like `audit_logs`. The notice will be edited; a record the next
    // signup overwrites is not evidence, and a customer who acknowledged September's
    // text keeps that answer after the shop moves to October's.
    expect(rows.map((row) => row.notice_version)).toEqual([
      '2026-09-01',
      CURRENT_CUSTOMER_NOTICE_VERSION,
    ]);
  });

  it('answers "what did they last see" from the newest row', async () => {
    /*
     * Both rows are stamped by the fixture rather than by the column default.
     * Two writes back to back can land inside the same millisecond, and rows that
     * share an instant have no order the database is obliged to keep — the index
     * scan is free to return either, so this assertion used to fail on the clock's
     * luck under a loaded machine rather than on the ordering it is about. The
     * question here is "which row does newest-first read", so the fixture states
     * the order instead of waiting for it.
     */
    await prisma.notice_acknowledgements.create({
      data: {
        customer_user_id: memberId,
        notice_version: '2026-09-01',
        acknowledged_at: new Date('2026-09-01T09:00:00.000Z'),
      },
    });
    await prisma.notice_acknowledgements.create({
      data: {
        customer_user_id: memberId,
        notice_version: '2026-10-03',
        acknowledged_at: new Date('2026-10-03T09:00:00.000Z'),
      },
    });

    const newest = await prisma.notice_acknowledgements.findFirstOrThrow({
      where: { customer_user_id: memberId },
      orderBy: { acknowledged_at: 'desc' },
    });

    // The only question ever asked of this table, and the reason the index is on
    // (person, newest first) rather than on the version.
    expect(newest.notice_version).toBe('2026-10-03');
  });

  it('refuses an acknowledgement about a customer that does not exist', async () => {
    await expect(
      prisma.notice_acknowledgements.create({
        data: {
          customer_user_id: '00000000-0000-4000-8000-000000000000',
          notice_version: CURRENT_CUSTOMER_NOTICE_VERSION,
        },
      }),
    ).rejects.toThrow();
  });
});