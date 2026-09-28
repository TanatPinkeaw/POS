/**
 * Supervisor approval for a gated till action.
 *
 * `GET` answers who *can* approve — the active admins holding a PIN — so the
 * dialog can offer a name instead of asking the cashier to guess. `POST` takes
 * that admin's PIN and returns a short-lived token bound to the action, the
 * target and this cashier (see `src/lib/supervisor.ts`).
 *
 * Both directions require a signed-in staff member, and neither is admin-only:
 * the person asking for approval is by definition the cashier, who could not
 * approve their own request anyway.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { approvalRequestSchema } from '@/lib/schemas';
import { listSupervisors, requestApproval } from '@/lib/supervisor';

export async function GET(): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);
    return { supervisors: await listSupervisors() };
  });
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const body = await readJson(request, approvalRequestSchema);

    return requestApproval({
      actorId: session.id,
      supervisorId: body.supervisorId,
      pin: body.pin,
      action: body.action,
      targetId: body.targetId,
    });
  });
}
