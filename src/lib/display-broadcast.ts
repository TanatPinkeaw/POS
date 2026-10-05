/**
 * What the till tells the customer display.
 *
 * Every write to the display room goes through this module, so the set of facts a
 * screen standing in the middle of the shop may receive is one file rather than
 * every call site that happens to have a socket. The payload shapes live in
 * `display-view.ts` and are deliberately narrow: names, quantities and money, and
 * no identifiers beyond an order number and a first name.
 */
import { prisma } from './db';
import {
  DISPLAY_CALL_LIMIT,
  initialOf,
  type DisplayCartPayload,
  type DisplayIdlePayload,
  type DisplayReadyOrder,
  type DisplayReadyPayload,
  type DisplayReceiptLink,
} from './display-view';
import { listQueueTickets } from './fulfilment';
import { listOrderViews } from './order-view';
import { emitToDisplays } from './realtime';
import { REALTIME_EVENTS } from './realtime-events';
import type { PaymentIntentView } from './payment-intents-view';

/**
 * The bill as it stands. Sent on every change, replacing whatever the screen had.
 *
 * `receivedThb`/`changeThb` are only ever set once the cashier has started
 * counting the money in — showing a change figure while the notes are still being
 * counted is how a customer ends up arguing about a number that was never final.
 */
export function broadcastCart(payload: DisplayCartPayload): void {
  emitToDisplays(REALTIME_EVENTS.displayCart, payload);
}

/** A QR was issued. Both screens show it; the customer's is the one they scan. */
export function broadcastIntent(intent: PaymentIntentView): void {
  emitToDisplays(REALTIME_EVENTS.paymentIntent, intent);
}

/**
 * A receipt link was minted at the till, and the customer asked for the screen.
 *
 * Re-emitted by the server rather than built here: the till posts what it was
 * given by the receipt-link route, and this trims it to the fields a queue may
 * see. Ephemeral by design — like the cart snapshot it is replaced by the next
 * sale, never stored, and clearing it is a second call with `null`.
 */
export function broadcastReceiptLink(link: DisplayReceiptLink | null): void {
  emitToDisplays(REALTIME_EVENTS.displayReceipt, link);
}

/** The money arrived — the event that closes a bill without anybody tapping. */
export function broadcastPaymentPaid(intent: PaymentIntentView): void {
  emitToDisplays(REALTIME_EVENTS.paymentPaid, intent);
}

/**
 * The QR is no longer payable.
 *
 * Sent for a cancellation and for an expiry as well as after a payment, because a
 * stale QR left on a customer screen is a QR the next customer will try to scan.
 */
export function broadcastPaymentClosed(intent: PaymentIntentView): void {
  emitToDisplays(REALTIME_EVENTS.paymentClosed, intent);
}

/**
 * The collection board: pre-orders that are packed and waiting.
 *
 * Read from the orders table rather than assembled from the event that triggered
 * it, so the board is always the truth — an event-derived list drifts the first
 * time one is missed, and a board that shows a collected order teaches customers
 * to ignore it.
 */
export async function broadcastReadyBoard(): Promise<void> {
  emitToDisplays(REALTIME_EVENTS.displayReady, await buildReadyPayload());
}

/**
 * The board itself, without the sending.
 *
 * Split from the broadcast because two callers need the same list for different
 * reasons: the event that fires when an order becomes collectable, and a screen
 * that has just connected and was not there to hear it. Both must produce the
 * identical payload — a screen that joins late and sees a differently-shaped
 * board would be a second implementation of the same thing.
 */
export async function buildReadyPayload(): Promise<DisplayReadyPayload> {
  const ready = await listOrderViews({ statuses: ['ready_for_pickup'], limit: 20 });

  const orders: DisplayReadyOrder[] = ready.map((order) => ({
    orderNumber: order.orderNumber,
    // An initial, not the name: this board faces a queue. `customerName` is the
    // only identity the list view carries, and the list view is where it stops.
    customerInitial: order.customerName ? initialOf(order.customerName) : null,
    readyAt: (order.readyAt ?? order.createdAt).toISOString(),
  }));

  /*
   * The walk-in calls, read from the same board the bar works off and filtered to
   * what is actually collectable. Newest first, because a customer who has just
   * heard their number looks for it at the top, and capped, because a screen in the
   * middle of a room has to stay readable from the far side of it (ADR 0018).
   */
  const calls = (await listQueueTickets())
    .filter((ticket) => ticket.state === 'ready')
    .slice(-DISPLAY_CALL_LIMIT)
    .reverse()
    .map((ticket) => ticket.queueNumber);

  return { orders, calls };
}

/** The shop's own name and a couple of best sellers, for an idle screen. */
export async function buildIdlePayload(): Promise<DisplayIdlePayload> {
  const [shop, popular, openShifts] = await Promise.all([
    prisma.shops.findUnique({
      where: { id: 1 },
      select: { name: true, logo_url: true },
    }),
    bestSellers(),
    // Not "is the shop open" — the shop has no opening hours in this system. It
    // is "is a drawer open", and a screen that says the shop is closed when the
    // till is in fact running would be worse than saying nothing.
    prisma.cash_shifts.count({ where: { status: 'open' } }),
  ]);

  return {
    shopName: shop?.name ?? 'ร้านของฉัน',
    logoUrl: shop?.logo_url ?? null,
    popular,
    sessionOpen: openShifts > 0,
  };
}

/**
 * Everything a screen needs that is not an event.
 *
 * The socket carries facts as they happen; this carries the facts that were
 * already true when the screen arrived. A display is plugged in, reloaded and
 * reconnected at arbitrary times, and none of those moments produce an event —
 * without this, a screen that came online between two sales would sit on an
 * empty welcome for the rest of the day.
 */
export async function buildDisplayState(): Promise<{
  idle: DisplayIdlePayload;
  ready: DisplayReadyPayload;
}> {
  const [idle, ready] = await Promise.all([buildIdlePayload(), buildReadyPayload()]);
  return { idle, ready };
}

/**
 * The shop's best sellers, by units sold.
 *
 * Deliberately not a promotions engine: this is the idle board, and a board that
 * names what the shop actually sells is useful on the first day rather than after
 * somebody has configured a campaign. Real promotions are a separate feature.
 */
async function bestSellers(limit = 6): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT p."name" AS name
      FROM "order_items" oi
      JOIN "products" p ON p."id" = oi."product_id"
      JOIN "orders" o ON o."id" = oi."order_id"
     WHERE o."status" IN ('completed', 'refunded')
     GROUP BY p."name"
     ORDER BY SUM(oi."quantity") DESC
     LIMIT ${limit}
  `;
  return rows.map((row) => row.name);
}
