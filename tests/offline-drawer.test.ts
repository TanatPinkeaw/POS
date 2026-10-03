/**
 * What a till may remember about its own drawer when the network is gone — ADR 0024.
 *
 * Every test here is a test of a *refusal*. The one way this module can hurt anybody is by
 * answering when it should not: a drawer remembered from yesterday, or one this device was
 * never equipped to sell on, would be a till taking money against a shift the server never
 * confirmed. The permissions are therefore the interesting behaviour, and each case below
 * is one of the ways the module is allowed to say "no".
 *
 * The storage adapter is stubbed rather than driven: `offline-db.ts` speaks IndexedDB,
 * which Node does not have, and `scripts/offline-browser.ts` already proves the adapter
 * itself against a real database in a real browser. What is under test here is the rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HeldBlock, PersistedTill } from '@/lib/till-store';

const stored = vi.hoisted(() => ({ state: null as PersistedTill | null, fails: false }));

vi.mock('@/lib/offline-db', () => ({
  createIndexedDbStorage: () => ({
    persists: true,
    read: async () => {
      if (stored.fails) throw new Error('database unavailable');
      return stored.state;
    },
    write: async () => {},
  }),
}));

const { readDeviceDrawer } = await import('@/lib/offline-drawer');

const SHIFT = {
  id: 7,
  initialCashThb: 2000,
  openedAt: '2026-10-03T09:00:00.000Z',
  cashSalesThb: 450,
  cashPayoutsThb: 0,
  expectedCashThb: 2450,
  orderCount: 3,
};

/** One borrowed number range — the thing only a prepared device holds. */
const BLOCK: HeldBlock = { id: 'b-1', block: { kind: 'receipt', day: '2026-10-03', from: 1, to: 100, lastUsed: null } };

const snapshot = (overrides: Partial<NonNullable<PersistedTill['snapshot']>> = {}) => ({
  capturedAt: '2026-10-03T10:00:00.000Z',
  deviceLabel: 'เครื่องหน้าร้าน',
  shop: {
    isVatRegistered: true,
    vatRatePercent: 7,
    pricesIncludeVat: true,
    receiptPrefix: 'LN',
    supervisorDiscountLimitThb: 50,
  },
  catalogue: [],
  shift: SHIFT,
  heldBlocks: [BLOCK],
  ...overrides,
});

describe('the drawer this device remembers', () => {
  beforeEach(() => {
    stored.state = null;
    stored.fails = false;
  });

  it('answers with the whole drawer, and when it was captured', async () => {
    stored.state = { snapshot: snapshot(), queue: [] };
    expect(await readDeviceDrawer()).toEqual({
      shift: SHIFT,
      capturedAt: '2026-10-03T10:00:00.000Z',
      deviceLabel: 'เครื่องหน้าร้าน',
    });
  });

  it('refuses a till that was never prepared', async () => {
    // Preparation is what borrows number ranges and what proves this device can keep a
    // bill. A till without it was never allowed to take offline money, so it is not allowed
    // to claim it is mid-shift now either.
    stored.state = { snapshot: snapshot({ heldBlocks: [] }), queue: [] };
    expect(await readDeviceDrawer()).toBeNull();
  });

  it('refuses a drawer that has been closed', async () => {
    // A normal close releases every loan, so a closed drawer leaves no block behind.
    stored.state = { snapshot: snapshot({ shift: null }), queue: [] };
    expect(await readDeviceDrawer()).toBeNull();
  });

  it('refuses when this device has never seen the shop', async () => {
    stored.state = { snapshot: null, queue: [] };
    expect(await readDeviceDrawer()).toBeNull();
  });

  it('answers "no" rather than throwing when the store is broken', async () => {
    // The storage contract is that a failed read must not take the till screen down with
    // it — there is simply nothing to remember, and the till then says so in its own words.
    stored.fails = true;
    await expect(readDeviceDrawer()).resolves.toBeNull();
  });
});