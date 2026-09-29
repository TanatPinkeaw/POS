/**
 * The call board: which paid tickets are still waiting for their goods (ADR 0018).
 *
 * The decision of what may move is pure and lives in `fulfilment-state.ts`; every
 * read and write is here. The reads are here for the same reason the writes are:
 * "still waiting" has to mean one thing, and a screen, a query and a state machine
 * that each decide for themselves is how a board ends up disagreeing with itself.
 */
import { bangkokDateString, dateColumnFromDay } from './bangkok-time';
import { prisma } from './db';
import { ConflictError } from './errors';
import {
  canFulfil,
  nextFulfilment,
  type FulfilmentAction,
  type FulfilmentState,
} from './fulfilment-state';
import type { Db } from './inventory';
import { lockOrder, TRANSACTION_OPTIONS } from './orders';
import { formatQueueNumber } from './queue-number';

export interface QueueTicket {
  orderId: string;
  /** `037` — printed as it is called. */
  queueNumber: string;
  state: FulfilmentState;
  /**
   * When the ticket entered the state it is in, which is what the board counts
   * from: `completed_at` while it is being made, `ready_at` once it is waiting to
   * be collected. Null `ready_at` on a `ready` ticket would be a bug, so the
   * fallback keeps the screen honest rather than printing an epoch.
   */
  since: Date;
  /** What has to go on the tray: `กาแฟเย็น ×2`. */
  items: string[];
}

/**
 * Today's tickets, preparing first and oldest first within each column.
 *
 * **Today only**, and that is the rule rather than a filter of convenience. A bill
 * nobody ever tapped leaves the board when the Bangkok day turns over, so the
 * screen cannot accumulate yesterday's forgotten numbers in front of customers —
 * and the day a number belongs to is the `queue_day` the number was minted with
 * (ADR 0017), not the day the row happens to be read on.
 */
export async function listQueueTickets(now: Date = new Date()): Promise<QueueTicket[]> {
  const rows = await prisma.orders.findMany({
    where: {
      status: 'completed',
      fulfilment: { in: ['preparing', 'ready'] },
      queue_day: dateColumnFromDay(bangkokDateString(now)),
      // A ticket without a number cannot be called. Nothing writes one, and this
      // is what makes that a fact rather than a hope.
      queue_number: { not: null },
    },
    select: {
      id: true,
      queue_number: true,
      fulfilment: true,
      completed_at: true,
      ready_at: true,
      items: {
        select: { quantity: true, product: { select: { name: true } } },
        orderBy: { id: 'asc' },
      },
    },
  });

  return rows
    .map((row): QueueTicket => {
      const state = row.fulfilment ?? 'preparing';
      return {
        orderId: row.id,
        queueNumber: formatQueueNumber(row.queue_number ?? 0),
        state: state as FulfilmentState,
        since:
          (state === 'ready' ? row.ready_at : row.completed_at) ??
          row.completed_at ??
          new Date(0),
        items: row.items.map((item) => `${item.product.name} ×${item.quantity}`),
      };
    })
    .sort((a, b) => {
      if (a.state !== b.state) {
        return a.state === 'preparing' ? -1 : 1;
      }
      return a.since.getTime() - b.since.getTime();
    });
}

/**
 * Takes one ticket's next step, or refuses with a reason.
 *
 * The row is locked the way every other write to an order is — through `lockOrder`,
 * so the lock is taken in the same order and by the same rule as a refund or a
 * handover — and the current state is read *after* the lock, which is why the two
 * are separate queries rather than one. Two tablets at the bar tapping the same
 * ticket must not both write, and the second tap must fail loudly rather than
 * silently do nothing.
 */
async function advance(input: {
  orderId: string;
  action: FulfilmentAction;
  db?: Db;
}): Promise<{ orderId: string; state: FulfilmentState }> {
  const run = async (tx: Db) => {
    const locked = await lockOrder(tx, input.orderId);

    /*
     * The order's *money* status is checked first and separately, because it is the
     * one thing this machine must never override: a refunded bill's status is
     * `refunded`, and a refunded drink is not one to make. Without this a bar could
     * tap a ticket the shop had already given the money back for.
     */
    if (locked.status !== 'completed') {
      throw new ConflictError(
        `Order ${input.orderId} is ${locked.status}; only a completed sale has goods waiting`,
        'NOT_A_COMPLETED_SALE',
      );
    }

    const row = await tx.orders.findUniqueOrThrow({
      where: { id: input.orderId },
      select: { fulfilment: true },
    });

    // A pre-order, or a bill from before this board existed. Refused rather than
    // defaulted to `preparing`: inventing a state for a bill nobody minted a ticket
    // for would put a number on a screen that was never called.
    if (!row.fulfilment) {
      throw new ConflictError(
        `Order ${input.orderId} has no call ticket`,
        'NO_CALL_TICKET',
      );
    }

    if (!canFulfil(row.fulfilment, input.action)) {
      throw new ConflictError(
        `Order ${input.orderId} is "${row.fulfilment}" and cannot be ${input.action === 'mark_ready' ? 'made ready' : 'collected'} again`,
        'INVALID_FULFILMENT_TRANSITION',
      );
    }

    const state = nextFulfilment(row.fulfilment, input.action);

    await tx.orders.update({
      where: { id: input.orderId },
      data: {
        fulfilment: state,
        /*
         * `ready_at` is the same column a pre-order uses for the same fact — the
         * goods are on the shelf and waiting — so the two paths agree about when a
         * customer could have collected, and a report over waiting times does not
         * need to know which kind of order it is reading.
         */
        ...(state === 'ready' ? { ready_at: new Date() } : {}),
      },
    });

    return { orderId: input.orderId, state };
  };

  return input.db ? run(input.db) : prisma.$transaction(run, TRANSACTION_OPTIONS);
}

/** The drink is made and the number goes up on the board. */
export function markTicketReady(orderId: string): Promise<{ orderId: string; state: FulfilmentState }> {
  return advance({ orderId, action: 'mark_ready' });
}

/** Handed over: the number is retired and leaves the board. */
export function collectTicket(orderId: string): Promise<{ orderId: string; state: FulfilmentState }> {
  return advance({ orderId, action: 'collect' });
}
