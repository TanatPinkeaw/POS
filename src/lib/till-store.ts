/**
 * The till store — the one seam between the counter and the shop's server (ADR 0019).
 *
 * Every write the till makes goes through here so that exactly one file answers one
 * question: **is this a server call, or a device call?** Above it, `useTill` and the panes
 * are unchanged; below it, the repository's rule holds without exception — the decisions
 * are pure modules (`offline-sale-rules.ts`, `number-block.ts`, `sync-plan.ts`) and this
 * file asks them and then keeps the answer.
 *
 * Three decisions it makes once rather than at every call site:
 *
 * 1. **One identity for prepared cash.** A prepared till commits cash on the device
 *    before replay even online. Pending stock/number promises cannot be rebased.
 *    The old injected no-transport seam retains its legacy fallback for tests only.
 * 2. **A refusal from the server is never quietly re-done offline.** An `ApiError` means
 *    the server answered: "สต็อกไม่พอ" is the truth about the shop, and selling round it
 *    would invent a sale the shop refused. A failed POST is uncertain, never proof
 *    that the shop did not record it; the shipped transport path does not fall back.
 * 3. **What "spend" means for a number.** Whether the number goes out through an online
 *    sale or an offline one, the device's own copy of the block moves forward, because the
 *    device is what proposes the next number — and a device that forgot it had just used
 *    12 would propose 12 again and be refused.
 *
 * Prepared cash is committed locally before transport, even online, and sent through
 * replay with one stable identity. An uncertain response never creates a second sale.
 * Borrow reservations are persisted before HTTP so a lost response can be recovered.
 */
import { addBangkokDays, bangkokDateString, bangkokParts } from './bangkok-time';
import { ApiError } from './client-api';
import { formatThb, roundThb } from './money';
import { nextValue, openBlockFor, remaining, type NumberBlock } from './number-block';
import {
  decideOfflineSale,
  priceOfflineSale,
  type OfflineBasket,
  type OfflineCatalogueEntry,
  type OfflineRefusal,
  type OfflineSaleContext,
  type OfflineWarning,
} from './offline-sale-rules';
import { formatQueueNumber } from './queue-number';
import {
  mayUseServer,
  nextSequence,
  offlineOrderLabel,
  pendingSummary,
  dueForReplay,
  recordFailure,
  replayOrder,
  type QueuedBill,
} from './sync-plan';

import type { OfflineSyncResult, OfflineBillRequest, OfflineReportRequest } from './offline-sales';

export interface TillTransport {
  borrow(input: { id: string; series: 'receipt' | 'queue'; day: string | null; size: number; deviceLabel: string }): Promise<NumberBlock & { id: string; openedAt?: Date | string }>;
  sync(input: { shiftId: number; bills: OfflineBillRequest[]; reports: OfflineReportRequest[] }): Promise<OfflineSyncResult>;
}

/** The shop's tax and discount settings, as the device last saw them. */
export interface OfflineShopSettings {
  readonly isVatRegistered: boolean;
  readonly vatRatePercent: number;
  readonly pricesIncludeVat: boolean;
  readonly receiptPrefix: string;
  readonly supervisorDiscountLimitThb: number;
}

/**
 * A block as the *device* holds it: the pure block plus the loan's own id.
 *
 * The id cannot live in `NumberBlock`, which is pure and knows nothing about rows — but
 * without it the device could not tell the server which loan a printed number came from,
 * and a bare `12` is not something the server can judge (`claimNumberFromBlock`).
 */
export interface HeldBlock {
  readonly id: string;
  readonly block: NumberBlock;
  readonly receiptYear?: number;
}

/**
 * The open drawer as the device remembers it.
 *
 * Carries the takings and the opening time beside the id, because a till opened with no
 * network still has to *say* what the shift is worth: the cashier is told the drawer is
 * open, and a drawer described only by its id would leave them wondering which one, and
 * the shift's own figures would have to be blanked. Every figure here is as of
 * `capturedAt` — a snapshot, not a live balance, and the screen says so.
 *
 * Deliberately absent: the closing figures (`actualCashThb`, the discrepancy), because a
 * device never closes a drawer. Inventing them would be inventing the one thing only a
 * person standing at the drawer can know.
 */
export interface DeviceShift {
  readonly id: number;
  readonly initialCashThb: number;
  readonly openedAt: string;
  readonly cashSalesThb: number;
  readonly cashPayoutsThb: number;
  readonly expectedCashThb: number;
  readonly orderCount: number;
}

/**
 * Everything the device needs to keep selling with no connection.
 *
 * The customer list is deliberately absent, as are points and pre-orders: the cheapest
 * answer to the privacy question in `CONTEXT.md` item 9 is that customer data never leaves
 * the server.
 */
export interface TillSnapshot {
  /** ISO instant of the sync this snapshot came from — what the till shows as its age. */
  readonly capturedAt: string;
  readonly deviceLabel: string;
  readonly cashierId?: string;
  readonly shop: OfflineShopSettings;
  readonly catalogue: readonly OfflineCatalogueEntry[];
  /** The open drawer. Offline a drawer cannot be opened, only spent from. */
  readonly shift: DeviceShift | null;
  readonly heldBlocks: readonly HeldBlock[];
}

/** What the device keeps between page loads. */
export interface PersistedTill {
  readonly snapshot: TillSnapshot | null;
  readonly queue: readonly QueuedBill[];
  readonly lastSequence?: number;
  readonly reservations?: readonly { id: string; series: 'receipt' | 'queue'; day: string | null; size: number; deviceLabel: string }[];
}

/**
 * The port. `offline-db.ts` is the shipped implementation; tests inject memory.
 *
 * `persists` is how a till learns whether it may claim it can sell offline at all: a
 * browser that fell back to memory keeps nothing across a reload, and a shop told it could
 * sell with no network and then losing the bills to an accidental refresh would be the
 * worst possible failure of this feature.
 */
export interface TillStorage {
  readonly persists: boolean;
  read(): Promise<PersistedTill | null>;
  write(state: PersistedTill): Promise<void>;
}

/** What the device printed, in the shape `Receipt` already renders. */
export interface TillReceipt {
  /**
   * The server's order id, when the bill has reached the shop.
   *
   * Absent on a device sale, and that is the fact the till needs: a bill the server has never
   * seen has nothing to refund, reprint or open in the back office until the queue is sent.
   */
  readonly orderId?: string | null;
  readonly orderNumber: string;
  readonly receiptNumber: string | null;
  readonly queueNumber: string | null;
  readonly isVatInvoice: boolean;
  readonly vatRatePercent: number | null;
  readonly subtotalThb: number;
  readonly discountThb: number;
  readonly finalAmountThb: number;
  readonly netThb: number;
  readonly vatThb: number;
  readonly tenders: { method: string; amountThb: number; receivedThb: number | null }[];
  readonly changeThb: number;
  readonly pointsEarned: number;
  readonly pointsRedeemed: number;
  readonly lines: { name: string; quantity: number; unitPrice: number; totalPrice: number }[];
}

export interface TillStoreState {
  readonly loaded: boolean;
  /** Whether the device keeps anything across a reload. See `TillStorage.persists`. */
  readonly canKeep: boolean;
  /** `null` until the till has had one answer from either side. */
  readonly online: boolean | null;
  readonly snapshot: TillSnapshot | null;
  readonly queue: readonly QueuedBill[];
  /** What the till's banner says: how many bills are waiting, and how long. */
  readonly pending: ReturnType<typeof pendingSummary>;
  /** Thai, when the device must not use the server for a sale yet. Null when it may. */
  readonly queueBlocksServer: string | null;
  readonly lastSyncMessage?: string | null;
}

export type TillSaleOutcome =
  | {
      readonly ok: true;
      readonly where: 'server' | 'device';
      readonly receipt: TillReceipt;
      /** Empty on a server sale; the offline path's warnings are the till's to show. */
      readonly warnings: readonly OfflineWarning[];
    }
  | { readonly ok: false; readonly refusals: readonly OfflineRefusal[] };

/** The numbers a device printed, as the sale endpoint takes them. */
export interface DeviceNumbers {
  readonly receipt?: { readonly blockId: string; readonly value: number };
  readonly call?: { readonly blockId: string; readonly value: number };
}

export interface TillStore {
  getState(): TillStoreState;
  /** Reads what the device kept. Happens once, before the first sale. */
  load(): Promise<void>;
  /**
   * Learns the network's state from the browser.
   *
   * `navigator.onLine` is not the truth about the shop's connection — it reports the last
   * thing the operating system knew, and a wifi router with no uplink passes it — so it is
   * only ever a hint that flips the till back to "let us try the server". What actually
   * decides is a request that failed to arrive.
   */
  setOnline(online: boolean): void;
  /** Remembers the shop as the device just read it. Called after every good sync. */
  saveSnapshot(snapshot: TillSnapshot): Promise<void>;
  prepare(label: string, size?: number): Promise<void>;
  sync(manual?: boolean, release?: boolean): Promise<void>;
  markTicket(clientRef: string, state: 'ready' | 'collected'): Promise<void>;
  /**
   * Closes one bill: on the server when the shop has one, on the device when it does not.
   *
   * `serverSale` receives the numbers the device printed (null when it holds nothing), so
   * the caller never handles a loan id — that bookkeeping belongs to this file.
   */
  sell(input: {
    basket: OfflineBasket;
    receivedCash: number;
    serverSale: (deviceNumbers: DeviceNumbers | null) => Promise<TillReceipt>;
  }): Promise<TillSaleOutcome>;
}

export function createTillStore(options: {
  storage: TillStorage;
  deviceLabel: string;
  cashierId?: string;
  transport?: TillTransport;
  /** The clock. Injectable so a test can state the instant it means. */
  now?: () => Date;
  /** Injectable for the same reason: a test's bill reference should be readable. */
  newClientRef?: () => string;
}): TillStore {
  const now = options.now ?? (() => new Date());
  const newClientRef =
    options.newClientRef ?? (() => (typeof crypto === 'undefined' ? 'ref' : crypto.randomUUID()));

  let snapshot: TillSnapshot | null = null;
  let queue: QueuedBill[] = [];
  let lastSequence = 0;
  let loaded = false;
  let online: boolean | null = null;
  let reservations: NonNullable<PersistedTill['reservations']> = [];
  let lastSyncMessage: string | null = null;

  let storageHealthy = true;
  let operation = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = operation.then(run);
    operation = next.then(() => undefined, () => undefined);
    return next;
  }
  async function persist(): Promise<void> {
    try { await options.storage.write({ snapshot, queue, reservations, lastSequence }); }
    catch (error) { storageHealthy = false; throw error; }
  }

  function state(): TillStoreState {
    return {
      loaded,
      canKeep: options.storage.persists && storageHealthy,
      online,
      snapshot,
      queue,
      pending: pendingSummary(queue, now()),
      queueBlocksServer: mayUseServer(queue).message,
      lastSyncMessage,
    };
  }

  function sameCashier(): boolean {
    return !options.cashierId || snapshot?.cashierId === options.cashierId ||
      (!snapshot?.heldBlocks.length && !queue.length && !reservations.length);
  }

  function offlineContext(at: Date): OfflineSaleContext | null {
    if (!snapshot) {
      return null;
    }
    const blocks = snapshot.heldBlocks.map((held) => held.block);
    return {
      at,
      shiftOpen: snapshot.shift !== null,
      supervisorDiscountLimitThb: snapshot.shop.supervisorDiscountLimitThb,
      isVatRegistered: snapshot.shop.isVatRegistered,
      vatRatePercent: snapshot.shop.vatRatePercent,
      pricesIncludeVat: snapshot.shop.pricesIncludeVat,
      receiptPrefix: snapshot.shop.receiptPrefix,
      catalogue: snapshot.catalogue,
      callBlocks: blocks.filter((block) => block.kind === 'queue'),
      receiptBlock: openBlockFor(blocks, 'receipt', null),
      pending: queue,
    };
  }

  /**
   * The numbers this device would print for the sale it is about to send.
   *
   * Null on a device holding nothing, which is the path a shop that has never borrowed
   * keeps: the server allocates both series itself.
   */
  function pendingNumbers(at: Date): DeviceNumbers | null {
    if (!snapshot) {
      return null;
    }
    const numbers: {
      receipt?: { blockId: string; value: number };
      call?: { blockId: string; value: number };
    } = {};

    if (snapshot.shop.isVatRegistered) {
      const held = snapshot.heldBlocks.find((entry) => entry.block.kind === 'receipt');
      const value = held ? nextValue(held.block) : null;
      if (held && value !== null) {
        numbers.receipt = { blockId: held.id, value };
      }
    }

    // The call-number block that belongs to *today*: a device holds today's and
    // tomorrow's, and spending tomorrow's at 23:55 is what the day check on the server
    // exists to refuse.
    const day = bangkokDateString(at);
    const held = snapshot.heldBlocks.find(
      (entry) => entry.block.kind === 'queue' && entry.block.day === day,
    );
    const value = held ? nextValue(held.block) : null;
    if (held && value !== null) {
      numbers.call = { blockId: held.id, value };
    }

    return numbers.receipt || numbers.call ? numbers : null;
  }

  /** Moves the device's own copy of the blocks it just sent numbers from. */
  function spendLocally(numbers: DeviceNumbers): void {
    if (!snapshot) {
      return;
    }
    const claimed = new Map<string, number>();
    for (const claim of [numbers.receipt, numbers.call]) {
      if (claim) {
        claimed.set(claim.blockId, claim.value);
      }
    }
    const heldBlocks = snapshot.heldBlocks.map((entry) => {
      const value = claimed.get(entry.id);
      return value === undefined
        ? entry
        : { ...entry, block: { ...entry.block, lastUsed: value } };
    });
    snapshot = { ...snapshot, heldBlocks };
  }

  /** Puts the blocks the offline decision moved back into the device's bookkeeping. */
  function adoptBlocks(
    held: readonly HeldBlock[],
    callBlocks: readonly NumberBlock[],
    receiptBlock: NumberBlock | null,
  ): HeldBlock[] {
    const moved = [...callBlocks, ...(receiptBlock ? [receiptBlock] : [])];
    return held.map((entry) => {
      const match = moved.find(
        (block) =>
          block.kind === entry.block.kind &&
          block.day === entry.block.day &&
          block.from === entry.block.from,
      );
      return match ? { ...entry, block: match } : entry;
    });
  }

  /** The bill as the device recorded it: its own price, its own numbers, its own label. */
  function deviceReceipt(input: {
    pricing: ReturnType<typeof priceOfflineSale>;
    receiptNumber: string | null;
    callNumber: { value: number; day: string } | null;
    sequence: number;
    soldDay: string;
    catalogue: readonly OfflineCatalogueEntry[];
  }): TillReceipt {
    return {
      orderId: null,
      orderNumber: offlineOrderLabel(input.soldDay, input.sequence),
      receiptNumber: input.receiptNumber,
      queueNumber: input.callNumber ? formatQueueNumber(input.callNumber.value) : null,
      isVatInvoice: input.pricing.isVatInvoice,
      vatRatePercent: input.pricing.vatRatePercent,
      subtotalThb: input.pricing.subtotalThb,
      discountThb: input.pricing.discountThb,
      finalAmountThb: input.pricing.finalAmountThb,
      netThb: input.pricing.netThb,
      vatThb: input.pricing.vatThb,
      /*
       * Cash, and nothing else. The offline decision refuses every other tender, so a
       * second leg here would be a claim about money nobody handed over — and it is what
       * makes the drawer's arithmetic work at close: one cash line per offline bill, in
       * the till's own drawer.
       */
      tenders: [
        {
          method: 'cash',
          amountThb: input.pricing.finalAmountThb,
          receivedThb: input.pricing.receivedThb,
        },
      ],
      changeThb: input.pricing.changeThb,
      pointsEarned: 0,
      pointsRedeemed: 0,
      lines: input.pricing.lines.map((line) => {
        const entry = input.catalogue.find((candidate) => candidate.productId === line.productId);
        return {
          name: entry?.name ?? line.productId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          // `roundThb`, not an inline rounding: the slip's line totals have to be the same
          // arithmetic the online sale prints, or one bill has two sums.
          totalPrice: roundThb(line.unitPrice * line.quantity),
        };
      }),
    };
  }

  async function sellOnDevice(input: {
    basket: OfflineBasket;
    receivedCash: number;
  }): Promise<TillSaleOutcome> {
    if (!loaded || !storageHealthy || !options.storage.persists) {
      return { ok: false, refusals: [{ code: 'storage_unavailable', message: 'เก็บบิลถาวรในเครื่องไม่ได้ — ต่อเน็ตและตรวจเบราว์เซอร์ก่อนรับเงิน' }] };
    }
    if (!sameCashier()) return { ok: false, refusals: [{ code: 'wrong_cashier', message: 'ข้อมูลในเครื่องเป็นของบัญชีเดิม — เข้าระบบด้วยบัญชีเดิมก่อนส่งบิลหรือขาย' }] };
    if (options.transport && !snapshot?.heldBlocks.length) {
      return { ok: false, refusals: [{ code: 'not_prepared', message: 'ยังไม่ได้เตรียมเครื่องขายออฟไลน์ — ต่อเน็ตแล้วเตรียมเครื่องก่อนรับเงิน' }] };
    }
    const at = now();
    if (snapshot?.heldBlocks.some((held) => held.block.kind === 'receipt' && held.receiptYear !== undefined && held.receiptYear !== bangkokParts(at).year)) {
      return { ok: false, refusals: [{ code: 'no_receipt_numbers', message: 'ชุดใบกำกับเป็นของปีเก่า — ต่อเน็ต ส่งบิล คืนชุดเลข แล้วเตรียมใหม่ก่อนขาย' }] };
    }
    const context = offlineContext(at);
    if (!context) {
      /*
       * A device that has never synced is a setup problem rather than a business refusal,
       * but it is refused in the same shape because the person at the counter reads it
       * either way — and "ต่อเน็ตก่อนขาย" is the same next step as the refusals below.
       */
      return {
        ok: false,
        refusals: [
          {
            code: 'no_open_shift',
            message: 'เครื่องนี้ยังไม่เคยซิงค์กับร้าน — ต่อเน็ตก่อนขาย',
          },
        ],
      };
    }

    const decision = decideOfflineSale(input.basket, context);
    if (!decision.allowed) {
      return { ok: false, refusals: decision.refusals };
    }

    const pricing = priceOfflineSale(input.basket, context, input.receivedCash);
    const soldDay = bangkokDateString(at);
    const sequence = Math.max(lastSequence + 1, nextSequence(queue));
    /*
     * Which numbers *this* bill printed, read before the blocks move.
     *
     * The queue has to carry them, and that is a correction the phase-3 slice left open: a
     * bill whose printed tax-invoice number was not on the order would be a document and a
     * record that disagree about their own reference — the exact failure the whole numbering
     * protocol exists to prevent. `pendingNumbers` is the same function the online path uses
     * to propose its numbers, so the two cannot drift about which block comes next; the
     * values here and the ones `decideOfflineSale` spends are the same by construction (the
     * decision refuses a VAT bill with no number rather than spending none).
     */
    const printed = pendingNumbers(at) ?? undefined;

    const bill: QueuedBill = {
      clientRef: newClientRef(),
      shiftId: snapshot!.shift!.id,
      fulfilment: 'preparing',
      sequence,
      soldAt: at,
      soldDay,
      lines: pricing.lines,
      totalThb: pricing.finalAmountThb,
      receivedThb: pricing.receivedThb,
      ...(printed ? { numbers: printed } : {}),
      tax: {
        isVatInvoice: pricing.isVatInvoice,
        vatRatePercent: pricing.vatRatePercent,
        netThb: pricing.netThb,
        vatThb: pricing.vatThb,
      },
      attempts: 0,
      nextAttemptAt: at,
    };

    const previousSnapshot = snapshot;
    const previousQueue = queue;
    const previousSequence = lastSequence;
    lastSequence = sequence;
    queue = [...queue, bill];
    if (snapshot) {
      snapshot = {
        ...snapshot,
        heldBlocks: adoptBlocks(snapshot.heldBlocks, decision.callBlocks, decision.receiptBlock),
      };
    }
    try { await persist(); } catch (error) {
      snapshot = previousSnapshot;
      queue = previousQueue;
      lastSequence = previousSequence;
      throw error;
    }

    return {
      ok: true,
      where: 'device',
      warnings: decision.warnings,
      receipt: deviceReceipt({
        pricing,
        receiptNumber: decision.receiptNumber,
        callNumber: decision.callNumber,
        sequence,
        soldDay,
        catalogue: context.catalogue,
      }),
    };
  }

  return {
    getState: state,

    async load(): Promise<void> {
      if (loaded) return;
      try {
        const stored = await options.storage.read();
        snapshot = stored?.snapshot ?? null;
        queue = stored ? stored.queue.map((bill) => ({ ...bill, soldAt: new Date(bill.soldAt), nextAttemptAt: new Date(bill.nextAttemptAt), shiftId: bill.shiftId ?? stored.snapshot?.shift?.id })) : [];
        reservations = stored?.reservations ?? [];
        lastSequence = Math.max(stored?.lastSequence ?? 0, nextSequence(queue) - 1);
      } catch { storageHealthy = false; }
      loaded = true;
    },

    setOnline(next: boolean): void {
      online = next;
    },

    saveSnapshot(next: TillSnapshot): Promise<void> {
      return serial(async () => {
        if (!sameCashier()) throw new Error('ข้อมูลในเครื่องเป็นของบัญชีเดิม — เข้าระบบด้วยบัญชีเดิมก่อน');
        if (!loaded || !storageHealthy) throw new Error('อ่านข้อมูลเดิมไม่ได้ — ห้ามเขียนทับหรือล้างข้อมูลเครื่อง');
        if ((snapshot?.heldBlocks.length || reservations.length) && snapshot?.shift?.id !== next.shift?.id) {
          throw new Error('คืนชุดเลขด้วยลิ้นชักเดิมก่อนเปลี่ยนกะหรือผู้ใช้');
        }
        // Never rebase a pending stock promise or its drawer on an unrelated refresh.
        if (queue.length > 0) return;
        const previous = snapshot;
        snapshot = { ...next, cashierId: options.cashierId ?? next.cashierId, heldBlocks: snapshot?.heldBlocks ?? next.heldBlocks };
        try { await persist(); } catch (error) { snapshot = previous; throw error; }
      });
    },

    prepare(label, size = 200): Promise<void> {
      return serial(async () => {
        if (!sameCashier()) throw new Error('ข้อมูลในเครื่องเป็นของบัญชีเดิม — เข้าระบบด้วยบัญชีเดิมก่อนเตรียม');
        if (!options.transport || !loaded || !snapshot?.shift || !state().canKeep || queue.length) throw new Error('เปิดลิ้นชักและส่งบิลให้ครบก่อนเตรียมเครื่อง');
        if (!label.trim() || label.length > 60 || size < 1 || size > 2000) throw new Error('ชื่อเครื่องหรือจำนวนเลขไม่ถูกต้อง');
        const day = bangkokDateString(now());
        const wanted = [
          ...(snapshot.shop.isVatRegistered ? [{ series: 'receipt' as const, day: null }] : []),
          { series: 'queue' as const, day }, { series: 'queue' as const, day: addBangkokDays(day, 1) },
        ];
        for (const part of wanted) {
          if (snapshot.heldBlocks.some((entry) => entry.block.kind === part.series && entry.block.day === part.day)) continue;
          let request = reservations.find((entry) => entry.series === part.series && entry.day === part.day);
          if (!request) {
            request = { id: newClientRef(), ...part, size, deviceLabel: label.trim() };
            const previousReservations = reservations;
            reservations = [...reservations, request];
            try { await persist(); } catch (error) { reservations = previousReservations; throw error; }
          }
          const block = await options.transport.borrow(request);
          const previousSnapshot = snapshot;
          const previousReservations = reservations;
          snapshot = { ...snapshot, deviceLabel: label.trim(), heldBlocks: [...snapshot.heldBlocks, { id: block.id, block, ...(block.kind === 'receipt' ? { receiptYear: bangkokParts(block.openedAt ? new Date(block.openedAt) : now()).year } : {}) }] };
          reservations = reservations.filter((entry) => entry.id !== request!.id);
          try { await persist(); } catch (error) { snapshot = previousSnapshot; reservations = previousReservations; throw error; }
        }
        online = true;
      });
    },

    sync(manual = false, release = false): Promise<void> {
      return serial(async () => {
        if (!sameCashier()) throw new Error('ข้อมูลในเครื่องเป็นของบัญชีเดิม — เข้าระบบด้วยบัญชีเดิมก่อนส่งบิล');
        if (!options.transport || !loaded || !storageHealthy) throw new Error('ส่งบิลไม่ได้ — ตรวจการเก็บข้อมูลของเครื่อง');
        // Recover a borrow whose response was lost before releasing anything.
        for (const request of [...reservations]) {
          if (!snapshot) throw new Error('ไม่พบข้อมูลเครื่องที่ยืมเลข — ห้ามล้างข้อมูล');
          const block = await options.transport.borrow(request);
          const previousSnapshot = snapshot;
          const previousReservations = reservations;
          if (!snapshot.heldBlocks.some((entry) => entry.id === block.id)) snapshot = { ...snapshot, heldBlocks: [...snapshot.heldBlocks, { id: block.id, block, ...(block.kind === 'receipt' ? { receiptYear: bangkokParts(block.openedAt ? new Date(block.openedAt) : now()).year } : {}) }] };
          reservations = reservations.filter((entry) => entry.id !== request.id);
          try { await persist(); } catch (error) { snapshot = previousSnapshot; reservations = previousReservations; throw error; }
        }
        while (queue.length > 0) {
          const eligible = manual ? replayOrder(queue) : dueForReplay(queue, now());
          const head = eligible[0];
          if (!head) return;
          const shiftId = head.shiftId;
          if (!shiftId) throw new Error('บิลเก่าไม่มีลิ้นชัก — ให้ผู้ดูแลตรวจ ห้ามล้างข้อมูล');
          const batch: QueuedBill[] = [];
          for (const bill of eligible.slice(0, 500)) { if (bill.shiftId !== shiftId) break; batch.push(bill); }
          let result: OfflineSyncResult;
          try {
            result = await options.transport.sync({ shiftId, reports: [], bills: batch.map((bill) => ({ ...bill, soldAt: bill.soldAt.toISOString() })) });
            online = true;
          } catch (error) {
            if (!(error instanceof ApiError)) online = false;
            queue = queue.map((bill) => bill.clientRef === head.clientRef ? recordFailure(bill, now()) : bill);
            lastSyncMessage = error instanceof Error ? error.message : 'ส่งบิลไม่สำเร็จ';
            await persist();
            throw error;
          }
          const attemptedRefs = new Set(batch.map((bill) => bill.clientRef));
          const accepted = new Set(result.bills.filter((bill) => attemptedRefs.has(bill.clientRef) && (bill.status === 'recorded' || bill.status === 'duplicate')).map((bill) => bill.clientRef));
          const previousQueue = queue;
          const previousSnapshot = snapshot;
          // Keep remaining availability conservative until a fresh server snapshot arrives.
          if (snapshot) snapshot = { ...snapshot, catalogue: snapshot.catalogue.map((product) => ({ ...product, available: product.available - batch.filter((bill) => accepted.has(bill.clientRef)).reduce((sum, bill) => sum + bill.lines.filter((line) => line.productId === product.productId).reduce((qty, line) => qty + line.quantity, 0), 0) })) };
          queue = queue.filter((bill) => !accepted.has(bill.clientRef)).map((bill) => {
            const refused = result.bills.find((entry) => entry.clientRef === bill.clientRef && entry.status === 'refused');
            return refused ? { ...recordFailure(bill, now()), refusal: refused.message } : bill;
          });
          lastSyncMessage = result.bills.flatMap((bill) => [bill.message, ...bill.warnings]).filter(Boolean).join(' · ') || 'ส่งบิลครบแล้ว';
          try { await persist(); } catch (error) { queue = previousQueue; snapshot = previousSnapshot; throw error; }
          if (result.notAttempted || result.bills.some((bill) => bill.status === 'refused')) throw new Error(lastSyncMessage);
          if (accepted.size === 0) throw new Error('เซิร์ฟเวอร์ไม่ยืนยันบิล — ห้ามล้างข้อมูล');
        }
        if (release && snapshot?.heldBlocks.length) {
          const shiftId = snapshot.shift?.id;
          if (!shiftId) throw new Error('ไม่พบลิ้นชักที่ยืมเลข');
          const reports: OfflineReportRequest[] = snapshot.heldBlocks.map((held) => ({ blockId: held.id, mode: held.block.lastUsed === null ? 'cancel' : 'report', ...(held.block.lastUsed === null ? {} : { lastUsed: held.block.lastUsed }) }));
          const result = await options.transport.sync({ shiftId, bills: [], reports });
          const closed = new Set(result.reports.filter((report) => report.status !== 'refused').map((report) => report.blockId));
          const previousSnapshot = snapshot;
          snapshot = { ...snapshot, heldBlocks: snapshot.heldBlocks.filter((held) => !closed.has(held.id)) };
          try { await persist(); } catch (error) { snapshot = previousSnapshot; throw error; }
          if (snapshot.heldBlocks.length) throw new Error(result.reports.find((report) => report.message)?.message ?? 'คืนชุดเลขไม่ครบ');
        }
      });
    },

    markTicket(clientRef, fulfilment): Promise<void> {
      return serial(async () => {
        if (!loaded || !storageHealthy) throw new Error('เก็บสถานะคิวไม่ได้ — ตรวจข้อมูลเครื่อง');
        const previousQueue = queue;
        queue = queue.map((bill) => bill.clientRef === clientRef ? { ...bill, fulfilment } : bill);
        try { await persist(); } catch (error) { queue = previousQueue; throw error; }
      });
    },

    sell(input): Promise<TillSaleOutcome> {
      return serial(async () => {
      const at = now();
      if (options.transport && snapshot?.heldBlocks.length && (input.basket.tender !== 'cash' || input.basket.memberAttached || input.basket.pointsRedeemed > 0)) {
        return { ok: false, refusals: [{ code: 'cash_only', message: 'เครื่องที่ถือชุดเลขรับเฉพาะเงินสดไม่ผูกสมาชิก — ส่งบิลและคืนชุดเลขก่อนใช้สมาชิก แต้ม หรือพร้อมเพย์' }] };
      }
      // Prepared cash is durable BEFORE any transport, and uses one replay identity even online.
      if (options.transport && snapshot?.heldBlocks.length && input.basket.tender === 'cash' && !input.basket.memberAttached) return sellOnDevice(input);

      if (mayUseServer(queue).allowed && online !== false) {
        const numbers = pendingNumbers(at);
        try {
          const receipt = await input.serverSale(numbers);
          online = true;
          if (numbers) {
            spendLocally(numbers);
            await persist();
          }
          return { ok: true, where: 'server', receipt, warnings: [] };
        } catch (error) {
          if (error instanceof ApiError || !storageHealthy || options.transport) {
            // The server answered. Its refusal is the shop's answer, and this file's job
            // is not to route around it.
            throw error;
          }
          // The request never arrived: the shop has no connection, so the device sells.
          online = false;
        }
      }

      return sellOnDevice(input);
      });
    },
  };
}

export type OfflineNoticeTone = 'info' | 'warning' | 'danger';

/**
 * What the till tells the operator about its own state — one notice, or none.
 *
 * Here rather than in the screen for the reason every refusal is a typed thing in this
 * repository: the till's state has *four* independent facts (a stale browser, bills it
 * cannot send, no network, and numbers running out) and a counter is told about them in one
 * place or it is told about them inconsistently. The tone is the decision that matters — a
 * browser that cannot keep anything is the only one of the four that can lose money
 * outright, so it is the only one that shouts.
 *
 * `numbersLow` comes from the last sale's warnings rather than from this state, because a
 * device that has not sold anything yet has not needed a number yet; the till passes it in.
 */
export function offlineNotice(state: TillStoreState): {
  tone: OfflineNoticeTone;
  title: string;
  body: string;
} | null {
  const parts: string[] = [];

  if (!state.canKeep) {
    parts.push(
      'เบราว์เซอร์นี้เก็บข้อมูลในเครื่องไม่ได้ — ถ้ารีเฟรชหน้าหรือปิดแท็บ ใบที่ค้างส่งจะหายไป',
    );
  }
  if (state.pending.count > 0) {
    const oldest =
      state.pending.oldestMinutes === null ? '' : ` · เก่าสุดรอมา ${state.pending.oldestMinutes} นาที`;
    parts.push(
      `ค้างส่ง ${state.pending.count} ใบ รวม ${formatThb(state.pending.totalThb)}${oldest}`,
    );
  }
  if (state.online === false) {
    parts.push(
      'ตอนนี้ออฟไลน์ — ขายได้เฉพาะเงินสด ไม่รับพร้อมเพย์ ไม่ใช้สมาชิกหรือแต้ม ' +
        'และขออนุมัติส่วนลดเกินวงเงินไม่ได้',
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return {
    tone: !state.canKeep ? 'danger' : 'warning',
    title: state.online === false ? 'โหมดออฟไลน์' : 'บิลที่ยังไม่ส่ง',
    body: parts.join(' · '),
  };
}

/**
 * How many numbers the device can still print, per series — today's call numbers, and the
 * receipts when the shop issues tax invoices.
 *
 * Null means the device holds no block for that series at all, which the till words
 * differently from "none left": one is a shop that never borrowed, the other is a shop
 * whose last numbers are about to run out and needs somebody to connect it.
 */
export function numbersRemaining(snapshot: TillSnapshot | null, at = new Date()): {
  receipt: number | null;
  call: number | null;
} {
  const held = (kind: NumberBlock['kind']) => snapshot?.heldBlocks.find((e) => e.block.kind === kind && (kind !== 'queue' || e.block.day === bangkokDateString(at)));
  const receipt = held('receipt');
  const call = held('queue');
  return {
    receipt: receipt ? remaining(receipt.block) : null,
    call: call ? remaining(call.block) : null,
  };
}
