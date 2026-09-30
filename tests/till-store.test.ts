// Seam under test: the till store — the one file that decides server or device (ADR 0019).
//
// The decisions themselves are pure and tested next to their modules; what is tested here
// is the *seam*: that a silent network falls back and an answered refusal does not, that a
// number moves forward whichever door the sale went out of, and that a bill the device took
// money for is on the device's disk before the next customer is served.
//
// The storage is a double on purpose, and it is the one place in this repository where a
// double is the right call: IndexedDB does not exist in Node, the repository refuses the
// dependency that fakes it (rule 2), and `offline-db.ts` is kept free of decisions so that
// this is where the behaviour can be pinned. What is *not* covered here — that a real
// browser's IndexedDB keeps what it is given — is a stated gap in `README.md`.
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/client-api';
import type { OfflineBasket } from '@/lib/offline-sale-rules';
import {
  createTillStore,
  numbersRemaining,
  offlineNotice,
  type HeldBlock,
  type PersistedTill,
  type TillReceipt,
  type TillSnapshot,
  type TillStorage,
} from '@/lib/till-store';

/** 12:00 in Bangkok on the day these fixtures are written for. */
const AT = new Date('2026-09-29T05:00:00.000Z');
const TODAY = '2026-09-29';

function memoryStorage(persists = true): TillStorage & { state: PersistedTill | null } {
  const storage = {
    persists,
    state: null as PersistedTill | null,
    read: () => Promise.resolve(storage.state),
    write: (next: PersistedTill) => {
      storage.state = next;
      return Promise.resolve();
    },
  };
  return storage;
}

const RECEIPT_BLOCK: HeldBlock = {
  id: 'loan-receipt',
  block: { kind: 'receipt', day: null, from: 500, to: 549, lastUsed: null },
};

const CALL_BLOCK: HeldBlock = {
  id: 'loan-call',
  block: { kind: 'queue', day: TODAY, from: 1, to: 100, lastUsed: null },
};

function snapshot(overrides: Partial<TillSnapshot> = {}): TillSnapshot {
  return {
    capturedAt: AT.toISOString(),
    deviceLabel: 'แท็บเล็ตหน้าเคาน์เตอร์',
    shop: {
      isVatRegistered: true,
      vatRatePercent: 7,
      pricesIncludeVat: true,
      receiptPrefix: 'FR',
      supervisorDiscountLimitThb: 50,
    },
    catalogue: [
      { productId: 'p-coffee', name: 'กาแฟเย็น', priceThb: 45, available: 10, safetyQty: 0, isActive: true },
      { productId: 'p-cake', name: 'เค้กชิ้น', priceThb: 65, available: 4, safetyQty: 1, isActive: true },
    ],
    shift: { id: 7, initialCashThb: 2000 },
    heldBlocks: [RECEIPT_BLOCK, CALL_BLOCK],
    ...overrides,
  };
}

function basket(overrides: Partial<OfflineBasket> = {}): OfflineBasket {
  return {
    lines: [{ productId: 'p-coffee', quantity: 1 }],
    tender: 'cash',
    memberAttached: false,
    pointsRedeemed: 0,
    discountThb: 0,
    ...overrides,
  };
}

/** A store that has already read its device storage and synced once. */
async function readyStore(input: {
  storage?: TillStorage & { state: PersistedTill | null };
  state?: Partial<TillSnapshot>;
} = {}) {
  const storage = input.storage ?? memoryStorage();
  let nextRef = 0;
  const store = createTillStore({
    storage,
    deviceLabel: 'แท็บเล็ตหน้าเคาน์เตอร์',
    now: () => AT,
    newClientRef: () => `ref-${++nextRef}`,
  });
  await store.load();
  await store.saveSnapshot(snapshot(input.state));
  return { store, storage };
}

const SERVER_RECEIPT: TillReceipt = {
  orderNumber: 'PO-20260929-000001',
  receiptNumber: 'FR-2026-000500',
  queueNumber: '001',
  isVatInvoice: true,
  vatRatePercent: 7,
  subtotalThb: 45,
  discountThb: 0,
  finalAmountThb: 45,
  netThb: 42.06,
  vatThb: 2.94,
  tenders: [{ method: 'cash', amountThb: 45, receivedThb: 100 }],
  changeThb: 55,
  pointsEarned: 0,
  pointsRedeemed: 0,
  lines: [{ name: 'กาแฟเย็น', quantity: 1, unitPrice: 45, totalPrice: 45 }],
};

/** What `fetch` throws when the request never reached anybody. */
function noConnection(): never {
  throw new TypeError('Failed to fetch');
}

describe('when the shop has no connection', () => {
  it('closes the bill on the device, numbered from its own block', async () => {
    const { store } = await readyStore();

    const outcome = await store.sell({
      basket: basket(),
      receivedCash: 100,
      serverSale: noConnection,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.where).toBe('device');
    expect(outcome.receipt.receiptNumber).toBe('FR-2026-000500');
    expect(outcome.receipt.queueNumber).toBe('001');
    expect(outcome.receipt.changeThb).toBe(55);
    // The number is on paper, so the device's own copy has moved: the next bill is 2, not
    // a second 001 the server would refuse.
    expect(outcome.receipt.orderNumber).toBe('OFF-20260929-001');
    expect(numbersRemaining(store.getState().snapshot)).toEqual({ receipt: 49, call: 99 });
  });

  it('has the bill on the device before the customer leaves the counter', async () => {
    const { store, storage } = await readyStore();

    await store.sell({ basket: basket({ lines: [{ productId: 'p-coffee', quantity: 2 }] }), receivedCash: 100, serverSale: noConnection });

    const stored = storage.state;
    expect(stored?.queue).toHaveLength(1);
    const bill = stored!.queue[0]!;
    // Priced lines, not quantities: the figures the customer paid are the record.
    expect(bill.lines).toEqual([{ productId: 'p-coffee', quantity: 2, unitPrice: 45 }]);
    expect(bill.totalThb).toBe(90);
    expect(bill.attempts).toBe(0);
    expect(bill.clientRef).toBe('ref-1');
    expect(bill.soldDay).toBe(TODAY);
    // And the moved block went with it, or a reload would spend 001 twice.
    expect(stored?.snapshot?.heldBlocks.find((entry) => entry.id === 'loan-call')?.block.lastUsed).toBe(1);
  });

  it('survives a reload with what it was holding', async () => {
    const storage = memoryStorage();
    const first = await readyStore({ storage });
    await first.store.sell({ basket: basket(), receivedCash: 100, serverSale: noConnection });

    const second = createTillStore({ storage, deviceLabel: 'แท็บเล็ตหน้าเคาน์เตอร์', now: () => AT });
    await second.load();

    const state = second.getState();
    expect(state.queue).toHaveLength(1);
    expect(state.pending.count).toBe(1);
    expect(state.pending.totalThb).toBe(45);
    // A device that has bills it cannot send does not use the server for a sale, and says
    // so in Thai rather than making the cashier guess.
    expect(state.queueBlocksServer).toContain('ค้างส่ง');
  });

  it('keeps selling offline even though the network came back', async () => {
    /*
     * The rule that makes a report safe: the device may not let the server take a number
     * while a printed number is still unsent, so the second sale is a device sale too —
     * not because the connection is down, but because the queue is not empty.
     */
    const { store } = await readyStore();
    await store.sell({ basket: basket(), receivedCash: 100, serverSale: noConnection });

    const serverSale = vi.fn(async () => SERVER_RECEIPT);
    const second = await store.sell({ basket: basket(), receivedCash: 45, serverSale });

    expect(serverSale).not.toHaveBeenCalled();
    expect(second.ok && second.where).toBe('device');
    expect(store.getState().queue).toHaveLength(2);
    // Two bills, two call numbers: 001 and 002, and never the same one twice.
    const labels = store.getState().queue.map((bill) => bill.sequence);
    expect(labels).toEqual([1, 2]);
  });
});

describe('when the shop has a connection', () => {
  it('sells through the server and hands it the device’s own numbers', async () => {
    const { store } = await readyStore();
    const serverSale = vi.fn(async () => SERVER_RECEIPT);

    const outcome = await store.sell({ basket: basket(), receivedCash: 100, serverSale });

    expect(serverSale).toHaveBeenCalledWith({
      receipt: { blockId: 'loan-receipt', value: 500 },
      call: { blockId: 'loan-call', value: 1 },
    });
    expect(outcome.ok && outcome.where).toBe('server');
    expect(outcome.ok && outcome.receipt.orderNumber).toBe('PO-20260929-000001');
    // Nothing is queued — the money is already the shop's — but the device's copy of the
    // block moved, because it is the device that proposes the next number.
    expect(store.getState().queue).toHaveLength(0);
    expect(numbersRemaining(store.getState().snapshot)).toEqual({ receipt: 49, call: 99 });
  });

  it('asks for no numbers at all on a device that holds none', async () => {
    // Every shop on its first day, and the acceptance journey: the server allocates.
    const { store } = await readyStore({ state: { heldBlocks: [] } });
    const serverSale = vi.fn(async () => SERVER_RECEIPT);

    await store.sell({ basket: basket(), receivedCash: 100, serverSale });

    expect(serverSale).toHaveBeenCalledWith(null);
  });

  it('does not claim a receipt number at a shop that issues no tax invoice', async () => {
    const { store } = await readyStore({
      state: { shop: { ...snapshot().shop, isVatRegistered: false } },
    });
    const serverSale = vi.fn(async () => SERVER_RECEIPT);

    await store.sell({ basket: basket(), receivedCash: 100, serverSale });

    expect(serverSale).toHaveBeenCalledWith({ call: { blockId: 'loan-call', value: 1 } });
  });

  it('shows the shop’s refusal rather than quietly selling round it', async () => {
    /*
     * The server answered, so the answer is the shop's: a basket the shop will not sell
     * must not become a device sale just because the till could do it alone. This is the
     * difference between a network that is gone and a shop that said no.
     */
    const { store } = await readyStore();
    const serverSale = async (): Promise<TillReceipt> => {
      throw new ApiError('สินค้าไม่พอขาย', 409, 'INSUFFICIENT_STOCK');
    };

    await expect(store.sell({ basket: basket(), receivedCash: 100, serverSale })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(store.getState().queue).toHaveLength(0);
    // And nothing was spent: the block is exactly where it was.
    expect(numbersRemaining(store.getState().snapshot)).toEqual({ receipt: 50, call: 100 });
  });
});

describe('what the device refuses, in the till’s own words', () => {
  it('refuses a sale on a drawer that is not open', async () => {
    const { store } = await readyStore({ state: { shift: null } });

    const outcome = await store.sell({ basket: basket(), receivedCash: 100, serverSale: noConnection });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? [] : outcome.refusals.map((refusal) => refusal.code)).toContain(
      'no_open_shift',
    );
  });

  it('refuses a member, points, a transfer and a discount over the limit', async () => {
    const { store } = await readyStore();

    const outcome = await store.sell({
      basket: basket({ tender: 'promptpay', memberAttached: true, pointsRedeemed: 100, discountThb: 80 }),
      receivedCash: 100,
      serverSale: noConnection,
    });

    const codes = outcome.ok ? [] : outcome.refusals.map((refusal) => refusal.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'cash_only',
        'member_unavailable',
        'points_unavailable',
        'discount_needs_supervisor',
      ]),
    );
    // A refused sale burns nothing and queues nothing.
    expect(store.getState().queue).toHaveLength(0);
    expect(numbersRemaining(store.getState().snapshot)).toEqual({ receipt: 50, call: 100 });
  });

  it('stops at the safety quantity, which is the whole stock promise offline', async () => {
    const { store } = await readyStore();

    const allowed = await store.sell({
      basket: basket({ lines: [{ productId: 'p-cake', quantity: 3 }] }),
      receivedCash: 200,
      serverSale: noConnection,
    });
    const refused = await store.sell({
      basket: basket({ lines: [{ productId: 'p-cake', quantity: 1 }] }),
      receivedCash: 65,
      serverSale: noConnection,
    });

    expect(allowed.ok).toBe(true);
    // Three cakes are sellable; the fourth is the shop's reserve, and the device says so.
    const refusal = refused.ok ? null : refused.refusals[0];
    expect(refusal?.code).toBe('stock_below_safety');
    expect(refusal?.message).toContain('เค้กชิ้น');
  });

  it('refuses a product it has no price for', async () => {
    const { store } = await readyStore();

    const outcome = await store.sell({
      basket: basket({ lines: [{ productId: 'p-ghost', quantity: 1 }] }),
      receivedCash: 100,
      serverSale: noConnection,
    });

    expect(outcome.ok ? [] : outcome.refusals[0]?.code).toBe('product_unknown');
  });

  it('says so when the device has never synced, rather than pretending to sell', async () => {
    const storage = memoryStorage();
    const store = createTillStore({ storage, deviceLabel: 'เครื่องใหม่', now: () => AT });
    await store.load();

    const outcome = await store.sell({ basket: basket(), receivedCash: 100, serverSale: noConnection });

    expect(outcome.ok ? '' : outcome.refusals[0]?.message).toContain('ต่อเน็ตก่อนขาย');
    expect(store.getState().canKeep).toBe(true);
  });
});

describe('what the till tells the operator about its numbers', () => {
  it('warns before the last numbers are gone, on the slip and in the outcome', async () => {
    // A block with three left: the till says so while there is still room to do something.
    const nearlySpent: HeldBlock = {
      id: 'loan-call',
      block: { kind: 'queue', day: TODAY, from: 1, to: 100, lastUsed: 97 },
    };
    const { store } = await readyStore({ state: { heldBlocks: [RECEIPT_BLOCK, nearlySpent] } });

    const outcome = await store.sell({ basket: basket(), receivedCash: 100, serverSale: noConnection });

    expect(outcome.ok && outcome.warnings.map((warning) => warning.code)).toContain('numbers_low');
    expect(outcome.ok && outcome.receipt.queueNumber).toBe('098');
  });

  it('sells with no call number rather than refusing the money', async () => {
    const { store } = await readyStore({ state: { heldBlocks: [RECEIPT_BLOCK] } });

    const outcome = await store.sell({ basket: basket(), receivedCash: 100, serverSale: noConnection });

    expect(outcome.ok && outcome.receipt.queueNumber).toBeNull();
    expect(outcome.ok && outcome.warnings.map((warning) => warning.code)).toContain(
      'no_call_number',
    );
  });

  it('refuses a tax invoice when the receipts in the device have run out', async () => {
    // The one thing that must never be improvised: a tax invoice with an invented number.
    const spent: HeldBlock = {
      id: 'loan-receipt',
      block: { kind: 'receipt', day: null, from: 500, to: 549, lastUsed: 549 },
    };
    const { store } = await readyStore({ state: { heldBlocks: [spent, CALL_BLOCK] } });

    const outcome = await store.sell({ basket: basket(), receivedCash: 100, serverSale: noConnection });

    expect(outcome.ok ? [] : outcome.refusals.map((refusal) => refusal.code)).toContain(
      'no_receipt_numbers',
    );
    expect(store.getState().queue).toHaveLength(0);
  });

  it('reports storage that cannot keep anything, so a shop is never told otherwise', async () => {
    const storage = memoryStorage(false);
    const store = createTillStore({ storage, deviceLabel: 'เบราว์เซอร์ส่วนตัว', now: () => AT });
    await store.load();

    expect(store.getState().canKeep).toBe(false);
  });
});

describe('what the till tells the operator about itself', () => {
  it('says nothing at all on a device that is online with nothing waiting', async () => {
    const { store } = await readyStore();
    store.setOnline(true);

    expect(offlineNotice(store.getState())).toBeNull();
  });

  it('names the bills it cannot send, with how much and how long', async () => {
    const { store } = await readyStore();
    await store.sell({ basket: basket(), receivedCash: 100, serverSale: noConnection });
    store.setOnline(true);

    const notice = offlineNotice(store.getState());
    expect(notice?.tone).toBe('warning');
    expect(notice?.title).toBe('บิลที่ยังไม่ส่ง');
    expect(notice?.body).toContain('ค้างส่ง 1 ใบ');
    expect(notice?.body).toContain('45.00');
  });

  it('separates being offline from having something to send', async () => {
    // Two different facts with two different next steps: one is "wait", the other is
    // "send what you have". A single message would make a cashier guess which.
    const { store } = await readyStore();
    store.setOnline(false);

    const notice = offlineNotice(store.getState());
    expect(notice?.title).toBe('โหมดออฟไลน์');
    expect(notice?.body).toContain('เงินสด');
    expect(notice?.body).not.toContain('ค้างส่ง');
  });

  it('shouts only when the browser cannot keep the bills at all', async () => {
    const storage = memoryStorage(false);
    const store = createTillStore({ storage, deviceLabel: 'เบราว์เซอร์ส่วนตัว', now: () => AT });
    await store.load();

    const notice = offlineNotice(store.getState());
    expect(notice?.tone).toBe('danger');
    expect(notice?.body).toContain('หายไป');
  });
});

describe('the numbers a snapshot reports', () => {
  it('is null for a series the device holds no block for', async () => {
    const { store } = await readyStore({ state: { heldBlocks: [CALL_BLOCK] } });

    expect(numbersRemaining(store.getState().snapshot)).toEqual({ receipt: null, call: 100 });
  });

  it('is null across the board before the first sync', () => {
    expect(numbersRemaining(null)).toEqual({ receipt: null, call: null });
  });

  it('counts what is left after spending, per series', async () => {
    const { store } = await readyStore();

    await store.sell({ basket: basket({ lines: [{ productId: 'p-coffee', quantity: 3 }] }), receivedCash: 200, serverSale: noConnection });

    const remaining = numbersRemaining(store.getState().snapshot);
    expect(remaining.call).toBe(99);
    expect(remaining.receipt).toBe(49);
  });
});
