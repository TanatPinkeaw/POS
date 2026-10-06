/**
 * `POST /api/v1/line/webhook` — the Messaging API's webhook (ADR 0030 §4).
 *
 * LINE's platform POSTs every event the Official Account sees: a customer added
 * the shop as a friend (`follow`), removed it (`unfollow`), or sent a message.
 * The two events this system acts on are the two halves of the friend condition
 * the customer planner checks (ADR 0030 §2) — an unfollowed user's push is
 * refused with a 200 by LINE, so planning one would burn the outbox's whole
 * retry schedule against a door nobody is behind.
 *
 * The door is unauthenticated by nature — it is LINE's servers calling — and is
 * bounded the way every unauthenticated door here is: signature first (HMAC of
 * the **raw body** under the channel secret, verified over the bytes that
 * arrived, not the parsed object), then the limiter, then the work. Unconfigured,
 * the door answers 200 and records nothing, because a retrying platform
 * hammering a refusal is noise in both directions. Only the first refusal of a
 * burst is audited, by the limiter itself.
 *
 * Every request is answered 200 once the signature has held, even for events
 * this system does nothing with: a non-200 makes LINE retry, and an event that
 * was read and deliberately ignored has been handled.
 */
import { withApi } from '@/lib/api';
import { prisma } from '@/lib/db';
import { readLineChannelSecret, verifyLineWebhookSignature } from '@/lib/line-webhook-signature';
import { chargeRateLimit } from '@/lib/rate-limit';

/** The one event shape this door reads; everything else is ignored by shape. */
interface LineWebhookEvent {
  type: string;
  source?: { userId?: string };
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const secret = readLineChannelSecret();
    if (!secret) {
      // Unconfigured: a door that is not a door. LINE's retry schedule is its own.
      return { ignored: true };
    }

    /*
     * The raw body first, and only once: the signature is over the bytes that
     * arrived, and re-reading the stream after a transform is the failure this
     * order exists to prevent.
     */
    const rawBody = await request.text();
    const signature = request.headers.get('x-line-signature');
    verifyLineWebhookSignature({ rawBody, signature, secret });

    await chargeRateLimit(request, 'line_webhook');

    let events: LineWebhookEvent[] = [];
    try {
      const parsed = JSON.parse(rawBody) as { events?: LineWebhookEvent[] };
      events = Array.isArray(parsed.events) ? parsed.events : [];
    } catch {
      // A signature that held over junk is junk LINE signed; answer, record nothing.
      return { ignored: true };
    }

    for (const event of events) {
      const subject = event.source?.userId;
      if (!subject) {
        continue; // A group or room event has no user to record.
      }
      if (event.type === 'follow') {
        await prisma.line_friends.upsert({
          where: { line_subject: subject },
          create: { line_subject: subject },
          update: {},
        });
      } else if (event.type === 'unfollow') {
        await prisma.line_friends.deleteMany({ where: { line_subject: subject } });
      }
      // `message` and every other event type: handled by answering, nothing more.
      // Auto-answering customers is the Official Account's own setting in LINE's
      // console, not this system's job.
    }

    return { received: events.length };
  });
}
