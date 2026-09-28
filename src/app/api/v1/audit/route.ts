/**
 * The audit trail (Phase F).
 *
 * Admin-only, and read-only by construction: the table refuses UPDATE and DELETE
 * at the database level and this module has no writer, so there is nothing here
 * that could rewrite history even if a caller asked for it.
 *
 * The filter set is deliberately small — an action, a person, a page — because a
 * trail is read by scrolling the recent past, not by composing queries. A date
 * range with a free-text search would be the screen an owner *says* they want and
 * then never opens.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { countAuditLogs, listAuditLogs } from '@/lib/audit';
import { auditQuerySchema } from '@/lib/schemas';

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);

    const params = new URL(request.url).searchParams;
    const query = auditQuerySchema.parse({
      action: params.get('action') ?? undefined,
      userId: params.get('userId') ?? undefined,
      limit: params.get('limit') ?? undefined,
      beforeId: params.get('beforeId') ?? undefined,
    });

    // The count ignores `beforeId` on purpose: it answers "how many rows match
    // this filter", which is what the screen says, while the page answers "what
    // am I looking at right now".
    return {
      entries: await listAuditLogs(query),
      total: await countAuditLogs(query),
    };
  });
}
