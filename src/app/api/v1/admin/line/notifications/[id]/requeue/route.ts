/**
 * `POST /api/v1/admin/line/notifications/:id/requeue` — put an abandoned message back in the
 * queue (ADR 0007, ADR 0032 §8).
 *
 * `requeueNotification` has existed since the outbox was built, with a comment calling itself
 * "the one repair a shop needs", and until now nothing called it: an abandoned row was a
 * permanent record of a mistake the shop had already corrected. This is that door, and it is
 * admin-only because the repair is a decision about the shop's own messaging rather than a
 * counter action.
 *
 * The refusal is Thai and it is the interesting half: `requeueNotification` throws a
 * `ConflictError` when the row is not abandoned, so pressing the button twice — or on a
 * message that is merely pending — answers "การแจ้งนี้ไม่ได้ค้างเสีย จึงไม่มีอะไรให้ส่งซ้ำ"
 * rather than silently doing nothing and looking like it worked.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { requeueNotification } from '@/lib/notify-outbox';
import { chargeRateLimit } from '@/lib/rate-limit';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    await chargeRateLimit(request, 'line_campaign', session.id);

    const { id } = await context.params;
    await requeueNotification(id);

    return { requeued: true, id };
  });
}
