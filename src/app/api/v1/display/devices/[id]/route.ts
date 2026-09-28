/**
 * Cutting a screen off.
 *
 * Revoked rather than deleted: the audit trail should still be able to say the
 * screen existed and who added it. The effect is immediate at the next reconnect,
 * because every socket handshake re-verifies the token against this table.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { revokeDisplayDevice } from '@/lib/display-devices';

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const { id } = await context.params;
    return revokeDisplayDevice({ id, actorId: session.id });
  });
}
