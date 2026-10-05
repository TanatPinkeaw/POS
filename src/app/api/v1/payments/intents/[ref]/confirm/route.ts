/**
 * Confirming that the money arrived.
 *
 * Two callers, one destination, and they are told apart by what they present:
 *
 *   * **A machine** — a bank-notification bridge on the shop's own network, or a
 *     payment provider — presents `PAYMENT_WEBHOOK_SECRET` in the
 *     `x-payment-secret` header. This is the path that makes auto-close genuinely
 *     automatic, and it is the shop's choice whether anything is on the other end
 *     of it. Compared with a constant-time check, because a secret that can be
 *     discovered one byte at a time is not a secret.
 *   * **A person** — the cashier, having looked at the shop's banking app —
 *     presents a session *and* a supervisor approval bound to this reference. That
 *     is the fallback when the shop has no bridge, and the PIN is what keeps it
 *     from being a cashier's private ability to mark bills paid.
 *
 * A webhook has no user behind it, so the trail records `confirmed_by_user_id` as
 * null and the intent's own row carries the amount and time. A person's
 * confirmation writes an audit row naming both the cashier and the approver.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastPaymentPaid } from '@/lib/display-broadcast';
import { ConflictError, ForbiddenError } from '@/lib/errors';
import { confirmIntent } from '@/lib/payment-intents';
import { requireApproval } from '@/lib/supervisor';
import { requestHasPaymentSecret } from '@/lib/webhook-secret';

type RouteContext = { params: Promise<{ ref: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const { ref } = await context.params;

    if (requestHasPaymentSecret(request)) {
      if (!process.env.PAYMENT_WEBHOOK_SECRET) {
        throw new ConflictError('ยังไม่ได้ตั้งค่าการยืนยันผ่าน Webhook', 'NO_WEBHOOK_SECRET');
      }
      const intent = await confirmIntent({ ref, confirmedByUserId: null });
      if (intent.status === 'paid' || intent.status === 'consumed') {
        broadcastPaymentPaid(intent);
      }
      return intent;
    }

    /*
     * No secret, so this is a person: the approval is bound to the reference, so
     * an approval to confirm one bill cannot confirm another.
     */
    const approval = await requireApproval(request, 'manual_payment_confirm', ref);
    void approval.actor;

    const intent = await confirmIntent({
      ref,
      confirmedByUserId: approval.approverId,
      actorUserId: approval.actor.id,
      authorizedByUserId: approval.approverId,
    });

    if (intent.status === 'paid' || intent.status === 'consumed') {
      broadcastPaymentPaid(intent);
    }
    return intent;
  });
}

/** Never reached: kept so a browser that navigates here gets a clear refusal. */
export async function GET(): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);
    throw new ForbiddenError('ต้องส่งคำยืนยันด้วยวิธี POST เท่านั้น');
  });
}
