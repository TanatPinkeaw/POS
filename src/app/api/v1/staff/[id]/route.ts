/**
 * Editing one staff account (ADR 0002).
 *
 * The two invariants that keep a shop from locking itself out — you cannot
 * demote yourself, and the last active admin cannot be removed — are enforced in
 * `updateStaff`, not here, because they are properties of the data rather than
 * of this route.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { staffUpdateSchema } from '@/lib/schemas';
import { updateStaff } from '@/lib/staff';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const { id } = await context.params;
    const body = await readJson(request, staffUpdateSchema);

    return updateStaff({ id, actorId: session.id, ...body });
  });
}
