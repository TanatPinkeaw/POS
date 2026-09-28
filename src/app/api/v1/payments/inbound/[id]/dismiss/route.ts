/**
 * Closing a transfer as "not a sale of ours".
 *
 * Admin-only, and deliberately **without** a supervisor PIN — unlike a refund or
 * a manual confirmation, which both move money. This one moves nothing: the
 * transfer stays in the account exactly where it was, and all that changes is
 * that the system stops asking about it. What it does need is a reason and an
 * audit row, because the alternative to a written-off transfer is a support
 * conversation with the shop's bank, and whoever has it will want to know what
 * the shop decided and who decided it.
 */
import { withApi, readJson } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { dismissInboundTransfer } from '@/lib/inbound-payments';
import { dismissInboundSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const user = await requireRole(['admin']);
    const { id } = await context.params;
    const body = await readJson(request, dismissInboundSchema);

    return dismissInboundTransfer({ id, actorId: user.id, reason: body.reason });
  });
}
