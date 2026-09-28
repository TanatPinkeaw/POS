/**
 * Money the bank says arrived, from two sides of the same table.
 *
 *   * **POST** is machine-only, and it is the whole automatic path: a bridge
 *     (`scripts/bank-bridge.ts`) or a payment provider posts a notification, the
 *     matcher decides whether it names a bill, and a matched QR is confirmed —
 *     which is what the till is polling for, so the bill closes itself.
 *   * **GET** is the other half, and it is admin-only: the notifications that
 *     could *not* be attributed. Without this screen the feature would be a way
 *     to silently lose money that arrived.
 *
 * The secret is the same one the confirmation endpoint takes, and deliberately
 * so: both endpoints can mark money as received, so they are one trust boundary
 * rather than two. A shop that has configured neither gets neither — the person at
 * the till confirms transfers with a PIN instead.
 */
import { withApi, readJson } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { ConflictError } from '@/lib/errors';
import { broadcastPaymentPaid } from '@/lib/display-broadcast';
import { listInboundTransfers, recordInboundTransfer } from '@/lib/inbound-payments';
import { findIntent } from '@/lib/payment-intents';
import { inboundTransferSchema } from '@/lib/schemas';
import { requestHasPaymentSecret } from '@/lib/webhook-secret';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    if (!requestHasPaymentSecret(request)) {
      /*
       * One refusal for both "wrong secret" and "no secret configured", because
       * telling them apart would say whether the shop has a bridge — and there is
       * nothing the caller can do with the difference that they cannot find in
       * their own configuration. A 409 with a code, matching how the confirmation
       * endpoint answers the same condition, so a bridge has one thing to check
       * in its logs whichever endpoint it called.
       */
      throw new ConflictError(
        'การแจ้งเงินโอนอัตโนมัติยังไม่ได้ตั้งค่า หรือรหัสไม่ถูกต้อง',
        'INBOUND_NOT_AUTHORISED',
      );
    }

    const body = await readJson(request, inboundTransferSchema);

    const record = await recordInboundTransfer({
      amountThb: body.amountThb ?? null,
      text: body.text,
      source: body.source,
      receivedAt: body.receivedAt,
      externalId: body.externalId ?? null,
    });

    /*
     * The customer screen is told the moment a QR is paid, and it is told from
     * here rather than from the confirmation endpoint because this is now the
     * path that gets there first. The event is idempotent for a display that has
     * already shown it — a screen is redrawn, not reconciled.
     */
    if (record.intentRef) {
      const intent = await findIntent(record.intentRef);
      if (intent) {
        broadcastPaymentPaid(intent);
      }
    }

    return record;
  });
}

/** What still needs somebody: the transfer was real, the bill is not yet known. */
export async function GET(): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);

    const transfers = await listInboundTransfers();
    return { transfers };
  });
}
