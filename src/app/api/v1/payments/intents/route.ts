/**
 * Issuing a PromptPay QR for the amount currently due.
 *
 * Staff-only, and it needs an open drawer: a transfer that cannot be reconciled
 * against a shift is a transfer the owner finds out about at closing time.
 *
 * The intent is created *before* the sale exists, which is not an accident of
 * implementation — the customer scans while the cashier still has a basket open,
 * so there is no order to attach it to yet. The `ref` is what joins them later.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastIntent } from '@/lib/display-broadcast';
import { createIntent } from '@/lib/payment-intents';
import { createIntentSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const body = await readJson(request, createIntentSchema);

    const intent = await createIntent({
      shiftId: body.shiftId,
      cashierId: session.id,
      amountThb: body.amountThb,
    });

    // The customer display is the point of the QR, so it is told immediately
    // rather than waiting for the till to poll.
    broadcastIntent(intent);

    return intent;
  });
}
