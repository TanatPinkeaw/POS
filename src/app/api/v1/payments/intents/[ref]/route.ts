/**
 * The state of one QR.
 *
 * The till subscribes to the realtime `payment:paid` event, but it also polls
 * this while a QR is on screen. That is not belt-and-braces for its own sake: the
 * realtime channel is a socket, and the moment a shop's wifi drops is the moment a
 * payment confirmation would be missed — and the failure mode of a missed
 * confirmation is a customer who has paid and a cashier who cannot see it.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { NotFoundError } from '@/lib/errors';
import { findIntent } from '@/lib/payment-intents';

type RouteContext = { params: Promise<{ ref: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);

    const { ref } = await context.params;
    const intent = await findIntent(ref);
    if (!intent) {
      throw new NotFoundError(`Payment intent ${ref}`);
    }
    return intent;
  });
}
