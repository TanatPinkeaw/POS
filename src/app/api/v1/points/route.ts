/**
 * `GET /api/v1/points` — the signed-in customer's own ledger (ADR 0020).
 *
 * Members only, and scoped by the session's own id: there is no query parameter
 * naming a customer, because the one thing this door must not allow is reading
 * somebody else's balance. Staff have the members screen for that, where the point
 * ledger is a shop fact rather than a personal one.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { listCustomerPoints } from '@/lib/customer-portal';

export async function GET(): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member']);
    return listCustomerPoints(session.id);
  });
}
