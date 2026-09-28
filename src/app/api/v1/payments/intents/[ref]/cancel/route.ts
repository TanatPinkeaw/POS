/**
 * Giving up on a QR.
 *
 * The cashier has decided to take cash instead, or the customer's app is not
 * cooperating. No PIN: this *removes* a way to be paid rather than performing
 * anything, so the worst a mistake here can do is make the till ask for the money
 * another way. The QR stops being payable and the customer screen stops showing
 * it, which is the part that matters — a live QR left on the counter is a QR the
 * next customer scans.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastPaymentClosed } from '@/lib/display-broadcast';
import { cancelIntent } from '@/lib/payment-intents';

type RouteContext = { params: Promise<{ ref: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const { ref } = await context.params;

    const intent = await cancelIntent({ ref, actorId: session.id });
    broadcastPaymentClosed(intent);
    return intent;
  });
}
