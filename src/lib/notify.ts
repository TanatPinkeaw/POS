/**
 * Realtime notifications.
 *
 * Routes call these after a domain operation succeeds, never before: a socket
 * event telling the till that an order was confirmed must not be sent for a
 * transaction that then rolled back.
 *
 * Kept apart from the domain modules so that `orders.ts` has no dependency on
 * the transport — which is what lets the order logic be tested without a socket
 * server running.
 */
import {
  REALTIME_EVENTS,
  type OrderEventPayload,
  type StockEventPayload,
  emitToAdmins,
  emitToEveryone,
  emitToStaff,
  emitToUser,
} from './realtime';

/** SRS §3 Phase 1: a new pre-order lands — staff get a badge and a chime. */
export function notifyNewPreOrder(
  payload: OrderEventPayload & { customerId: string | null },
): void {
  emitToStaff(REALTIME_EVENTS.orderCreated, payload);
  emitToAdmins(REALTIME_EVENTS.orderCreated, payload);
}

/** Any status change, so every open board re-renders. */
export function notifyOrderUpdated(
  payload: OrderEventPayload & { customerId?: string | null },
): void {
  emitToStaff(REALTIME_EVENTS.orderUpdated, payload);
  if (payload.customerId) {
    emitToUser(payload.customerId, REALTIME_EVENTS.orderUpdated, payload);
  }
}

/** A product's counters moved; customers see availability change live. */
export function notifyStockChanged(payload: StockEventPayload): void {
  emitToEveryone(REALTIME_EVENTS.stockUpdated, payload);
}

/** A customer's point balance changed. */
export function notifyPointsChanged(userId: string, pointsBalance: number): void {
  emitToUser(userId, REALTIME_EVENTS.pointsUpdated, { pointsBalance });
}

/**
 * A clock-in/out or a roster change.
 *
 * Goes to the admin room only: the manager's board should live-update as the
 * shift changes hands, while a cashier has no reason to watch the whole floor's
 * timesheet. The employee who made the change already has the result in the HTTP
 * response, so they need no push back.
 */
export function notifyAttendanceChanged(payload: AttendanceEventPayload): void {
  emitToAdmins(REALTIME_EVENTS.attendanceUpdated, payload);
}

export interface AttendanceEventPayload {
  employeeId: string;
  employeeName: string;
  action: 'check_in' | 'check_out' | 'manual_log' | 'log_removed' | 'schedule_set' | 'schedule_removed';
  /** The Bangkok day the change touches, `YYYY-MM-DD`. */
  day: string;
}
