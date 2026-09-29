/**
 * Realtime event names.
 *
 * Split out of `realtime.ts` because that module imports `socket.io` (a Node
 * package) and this file is imported by client components. Keeping the names in
 * a dependency-free module means the browser never pulls the server transport
 * into its bundle just to learn the event strings.
 */

export const REALTIME_EVENTS = {
  /** A Phase 1 pre-order arrived: staff see a badge and hear a chime. */
  orderCreated: 'order:created',
  /** Any status change, so every open board re-renders. */
  orderUpdated: 'order:updated',
  /** A Phase 1 order hit its confirmation deadline and released its stock. */
  orderExpired: 'order:expired',
  /** A product's stock counters moved. */
  stockUpdated: 'stock:updated',
  /** A customer's point balance changed. */
  pointsUpdated: 'points:updated',
  /** A closed drawer did not reconcile; admins need to review it. */
  shiftDiscrepancy: 'shift:discrepancy',
  /** Someone clocked in or out, or a roster row changed. */
  attendanceUpdated: 'attendance:updated',

  /**
   * The bill being rung up, sent to the customer display.
   *
   * A snapshot rather than a delta, so a screen that reconnects does not have to
   * replay anything: the next tap sends the whole cart again.
   */
  displayCart: 'display:cart',
  /** A QR was issued for this amount. Both the till and the display need it. */
  paymentIntent: 'payment:intent',
  /** The money arrived. This is what closes the bill without anyone tapping. */
  paymentPaid: 'payment:paid',
  /** The QR stopped being payable: paid, cancelled, or out of time. */
  paymentClosed: 'payment:closed',
  /** A pre-order became collectable, for the board on the customer screen. */
  displayReady: 'display:ready',
  /**
   * A call ticket appeared or moved, for the bar's screen at the till.
   *
   * A bare nudge rather than the board itself: unlike a customer display, the till
   * holds a session and can read the board again, and a screen built from an event
   * payload drifts the first time one event is missed.
   */
  queueUpdated: 'queue:updated',
} as const;

export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];
