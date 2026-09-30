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
 * 1. **When the device sells instead of the server.** The device sells when the server
 *    cannot be used — either because the request did not arrive (`fetch` threw, so the
 *    shop has no connection) or because the device is holding bills it has not sent (see
 *    `mayUseServer` for why that one is arithmetic rather than caution).
 * 2. **A refusal from the server is never quietly re-done offline.** An `ApiError` means
 *    the server answered: "สต็อกไม่พอ" is the truth about the shop, and selling round it
 *    would invent a sale the shop refused. Only silence falls back.
 * 3. **What "spend" means for a number.** Whether the number goes out through an online
 *    sale or an offline one, the device's own copy of the block moves forward, because the
 *    device is what proposes the next number — and a device that forgot it had just used
 *    12 would propose 12 again and be refused.
 *
 * How a device comes by a block is deliberately *not* here yet. Phase 3 of the spec ends
 * with the till refusing to sell offline because it holds nothing, which is the safe half
 * of the feature; borrowing lands with the replay, because a loan the device cannot settle
 * (`mayUseServer`) is a shop that cannot sell online either.
 */
import { bangkokDateString } from './bangkok-time';
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
  type QueuedBill,
} from './sync-plan';

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
  readonly shop: OfflineShopSettings;
  readonly catalogue: readonly OfflineCatalogueEntry[];
  /** The open drawer. Offline a drawer cannot be opened, only spent from. */
  readonly shift: { readonly id: number; readonly initialCashThb: number } | null;
  readonly heldBlocks: readonly HeldBlock[];
}

/** What the device keeps between page loads. */
export interface PersistedTill {
  readonly snapshot: TillSnapshot | null;
  readonly queue: readonly QueuedBill[];
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
  let loaded = false;
  let online: boolean | null = null;

  function persist(): Promise<void> {
    return options.storage.write({ snapshot, queue });
  }

  function state(): TillStoreState {
    return {
      loaded,
      canKeep: options.storage.persists,
      online,
      snapshot,
      queue,
      pending: pendingSummary(queue, now()),
      queueBlocksServer: mayUseServer(queue).message,
    };
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
        : { id: entry.id, block: { ...entry.block, lastUsed: value } };
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
      return match ? { id: entry.id, block: match } : entry;
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
    const at = now();
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
    const sequence = nextSequence(queue);

    const bill: QueuedBill = {
      clientRef: newClientRef(),
      sequence,
      soldAt: at,
      soldDay,
      lines: pricing.lines,
      totalThb: pricing.finalAmountThb,
      attempts: 0,
      nextAttemptAt: at,
    };

    queue = [...queue, bill];
    if (snapshot) {
      snapshot = {
        ...snapshot,
        heldBlocks: adoptBlocks(snapshot.heldBlocks, decision.callBlocks, decision.receiptBlock),
      };
    }
    await persist();

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
      const stored = await options.storage.read();
      snapshot = stored?.snapshot ?? null;
      queue = stored ? [...stored.queue] : [];
      loaded = true;
    },

    setOnline(next: boolean): void {
      online = next;
    },

    async saveSnapshot(next: TillSnapshot): Promise<void> {
      snapshot = next;
      await persist();
    },

    async sell(input): Promise<TillSaleOutcome> {
      const at = now();

      if (mayUseServer(queue).allowed) {
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
          if (error instanceof ApiError) {
            // The server answered. Its refusal is the shop's answer, and this file's job
            // is not to route around it.
            throw error;
          }
          // The request never arrived: the shop has no connection, so the device sells.
          online = false;
        }
      }

      return sellOnDevice(input);
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
export function numbersRemaining(snapshot: TillSnapshot | null): {
  receipt: number | null;
  call: number | null;
} {
  const held = (kind: NumberBlock['kind']) => snapshot?.heldBlocks.find((e) => e.block.kind === kind);
  const receipt = held('receipt');
  const call = held('queue');
  return {
    receipt: receipt ? remaining(receipt.block) : null,
    call: call ? remaining(call.block) : null,
  };
}
