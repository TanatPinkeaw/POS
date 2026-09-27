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
} as const;

export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];
