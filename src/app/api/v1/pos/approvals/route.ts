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
import { ApprovalRejectedError } from '@/lib/errors';
import { chargeRateLimit } from '@/lib/rate-limit';
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

    try {
      return await requestApproval({
        actorId: session.id,
        supervisorId: body.supervisorId,
        pin: body.pin,
        action: body.action,
        targetId: body.targetId,
      });
    } catch (error) {
      /*
       * Four digits is ten thousand possibilities, and the database already stops
       * a caller walking one admin's PIN: five wrong tries and it is locked
       * (`supervisor.ts`). What that cannot see is the *list* of admins — five
       * tries each, across every supervisor on the screen — and that is what this
       * bucket is for. Charged per address rather than per admin, deliberately: a
       * per-admin limit is the lockout, and duplicating it here would only mean
       * two places to explain.
       *
       * On failure only. A busy Saturday spends approvals legitimately, and a
       * limiter a rush can trip is one the shop turns off before the next rush.
       */
      if (error instanceof ApprovalRejectedError) {
        await chargeRateLimit(request, 'approval_failure');
      }
      throw error;
    }
  });
}
