/**
 * Editing one customer account (ADR 0010).
 *
 * Admin-only, and the refusals that matter are in `updateMember` rather than
 * here: this surface cannot touch a staff account, and a phone number already in
 * use cannot be taken from whoever owns it. Both are properties of the data, so
 * they are enforced where the data is.
 *
 * A `PATCH` with no password leaves the password alone — there is no way to
 * express "no password" through this route, and that is deliberate: an account
 * with no credential is an account whose phone number is the only thing anyone
 * would need to sign in as them.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { updateMember } from '@/lib/members';
import { memberUpdateSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const { id } = await context.params;
    const body = await readJson(request, memberUpdateSchema);

    return updateMember({ id, actorId: session.id, ...body });
  });
}
