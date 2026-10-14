/**
 * `POST /api/v1/line/webhook` — the Messaging API's webhook (ADR 0030 §4).
 *
 * LINE's platform POSTs every event the Official Account sees: a customer added
 * the shop as a friend (`follow`), removed it (`unfollow`), or sent a message.
 * Three events act, and the third is newer (ADR 0032 §3–4): the two halves of the
 * friend condition the customer planner checks (ADR 0030 §2), and a `message`,
 * which is now *recorded* rather than thrown away — one row per LINE message, and
 * one alert to the shop's own group per customer per quiet window, because a
 * customer who writes and is not heard is the gap this closes.
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
import { clearLineFriend, markLineFriend } from '@/lib/line-friends';
import { enqueueCustomerMessageFact } from '@/lib/line-message-alert';
import { readLineMessageEvent, recordInboundLineMessage } from '@/lib/line-messages';
import { readLineChannelSecret, verifyLineWebhookSignature } from '@/lib/line-webhook-signature';
import { chargeRateLimit } from '@/lib/rate-limit';

/**
 * The event shape this door reads; everything else is ignored by shape.
 *
 * `message` is optional and read as data rather than trusted: a webhook body is a stranger's
 * JSON until the signature has held, and even then the fields a record needs (an id, a type,
 * a text) may simply be absent. `readLineMessageEvent` is where that is decided.
 */
interface LineWebhookEvent {
  type: string;
  source?: { userId?: string };
  message?: { id?: string; type?: string; text?: string };
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
        // The shop's half of the consent pair (ADR 0030 §2), written by the module that owns
        // the table so the friend condition has one place to be asked and one to be changed.
        await markLineFriend(subject);
      } else if (event.type === 'unfollow') {
        await clearLineFriend(subject);
      } else if (event.type === 'message') {
        /*
         * Recorded, and — only when the row is new — the shop is told (ADR 0032 §3–4).
         *
         * The `recorded` flag is the whole reason this is one call and not two: LINE
         * redelivers a webhook it did not get a 2xx for, and a redelivery must not alert the
         * shop a second time about a message it was already told about. Writing first and
         * alerting second, in that order, is what makes the alert exactly-once per message
         * while the row itself is idempotent.
         */
        const message = readLineMessageEvent(event);
        if (message) {
          const { recorded } = await recordInboundLineMessage(message);
          if (recorded) {
            await enqueueCustomerMessageFact(message);
          }
        }
      }
      // Every other event type — and any message this door cannot make a row of — is
      // handled by answering: a non-200 makes LINE retry, and an event that was read and
      // deliberately ignored has been handled. Auto-answering customers stays the Official
      // Account's own setting in LINE's console, not this system's job.
    }

    return { received: events.length };
  });
}
