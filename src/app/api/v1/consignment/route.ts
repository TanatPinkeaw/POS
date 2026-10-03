/**
 * `GET /api/v1/consignment` — the signed-in member's own consignment position
 * (ADR 0023, ADR 0020).
 *
 * Members only, and scoped by the session's own id: there is no query parameter
 * naming a consignor, because the one thing this door must not allow is reading
 * somebody else's balance. The admin's `/admin/consignors` screen is where staff see
 * balances; here it is a personal fact, like the points ledger beside it.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { loadCustomerConsignment } from '@/lib/consignment-portal';

export async function GET(): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member']);
    return loadCustomerConsignment(session.id);
  });
}
