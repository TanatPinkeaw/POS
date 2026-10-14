/**
 * The transport the outbox sends through.
 *
 * Two channels, and both are a `fetch` to something the shop already has. That is
 * the same trade the bank bridge makes: no subscription, no account with a company
 * that can change its pricing or shut down, and a shop can point the URL at
 * whatever it likes — Twilio, a Thai SMS gateway, or a twelve-line script that
 * forwards to a Telegram bot.
 *
 * The LINE channel is a first-class citizen rather than an afterthought because
 * LINE is where Thai shops actually talk to their staff. It addresses a LINE user
 * id or group id, which is why the planner refuses to put a customer's collection
 * code through it (`notify-message.ts`).
 *
 * Every failure is an exception with a message worth reading, because the message
 * is what gets stored on the row as `last_error` and what a shop will see when its
 * gateway was never configured properly. Nothing here decides whether to retry —
 * that is the outbox's schedule.
 */
import { lineApiBaseUrl } from './line-quota';
import type { QueuedNotification } from './notify-outbox';

/** Raised when a message could not be handed to the channel. */
export class NotificationDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationDeliveryError';
  }
}

/**
 * How long to wait on a gateway before giving up.
 *
 * Ten seconds, because a shop's worker is a script somebody runs and watches: a
 * gateway that has stopped answering must fail that message — and move on to the
 * next, which may well be fine — rather than holding the whole queue behind a
 * socket that will never close.
 */
const DELIVERY_TIMEOUT_MS = 10_000;

interface ChannelConfig {
  channel: 'line' | 'webhook';
  /** Present for `webhook`; the worker fails loudly when it is missing. */
  webhookUrl: string | null;
  /** Present for `line`. */
  lineToken: string | null;
  /** Optional shared secret, sent so the shop's gateway can refuse strangers. */
  webhookSecret: string | null;
}

/**
 * The shop's own channel access token, whatever the outbox's channel setting is.
 *
 * Deliberately its own reader rather than a field of `readChannelConfig`, because the two
 * questions are different and a shop can answer them differently: `NOTIFY_CHANNEL` decides
 * where *the shop's own alerts* go (a LINE group, an SMS gateway, nowhere at all), while
 * `NOTIFY_LINE_TOKEN` is what lets this deployment talk to LINE at all — which is what a
 * **campaign** needs, since a promotion goes to customers' LINE rather than to the shop's
 * group (ADR 0032 §6). A shop whose alerts go to a webhook can still send promotions on LINE,
 * and one that has turned its own alerts off can too.
 */
export function readLineChannelToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const token = env.NOTIFY_LINE_TOKEN?.trim();
  return token ? token : null;
}

/** Reads the transport's configuration, or null when no channel is configured. */
export function readChannelConfig(
  env: Record<string, string | undefined> = process.env,
): ChannelConfig | null {
  const channel = env.NOTIFY_CHANNEL?.trim().toLowerCase();
  if (channel === 'line') {
    return {
      channel: 'line',
      webhookUrl: null,
      lineToken: readLineChannelToken(env),
      webhookSecret: null,
    };
  }
  if (channel === 'webhook') {
    return {
      channel: 'webhook',
      webhookUrl: env.NOTIFY_WEBHOOK_URL?.trim() ?? null,
      lineToken: null,
      webhookSecret: env.NOTIFY_WEBHOOK_SECRET?.trim() ?? null,
    };
  }
  return null;
}

/**
 * Hands one message to the channel, or throws with the reason it could not.
 *
 * The row's own `channel` is what is used rather than the environment's: a message
 * queued yesterday under a LINE configuration is still a LINE message, and sending
 * it through a gateway configured since would deliver it to the wrong place — or
 * to nobody, while reporting success.
 */
export async function deliverNotification(
  notification: QueuedNotification,
  config: ChannelConfig | null = readChannelConfig(),
): Promise<void> {
  if (notification.channel === 'line') {
    await deliverToLine(notification, config);
    return;
  }
  await deliverToWebhook(notification, config);
}

async function deliverToLine(
  notification: QueuedNotification,
  config: ChannelConfig | null,
): Promise<void> {
  const token = config?.channel === 'line' ? config.lineToken : null;
  if (!token) {
    throw new NotificationDeliveryError(
      'NOTIFY_LINE_TOKEN is not set, so a LINE message cannot be sent',
    );
  }

  // The base URL is `line-quota.ts`'s, so one function decides where this server sends the
  // shop's channel token — the same recorded trade `LINE_TOKEN_URL` and `LINE_JWKS_URL` make
  // (ADR 0030 §6), and what lets the acceptance run stand a stub in LINE's place.
  const response = await post(
    `${lineApiBaseUrl()}/v2/bot/message/push`,
    { to: notification.recipient, messages: [{ type: 'text', text: notification.body }] },
    { authorization: `Bearer ${token}` },
  );

  if (!response.ok) {
    throw new NotificationDeliveryError(
      `LINE refused the push (${response.status}): ${await bodySnippet(response)}`,
    );
  }
}

/** One campaign batch: everything LINE's multicast needs, and nothing about the outbox. */
export interface CampaignBatchDelivery {
  recipientIds: string[];
  body: string;
  /** An image *link*, validated when the campaign was written (ADR 0014). */
  imageUrl: string | null;
}

/**
 * Sends one batch of a campaign through LINE's multicast (ADR 0032 §7).
 *
 * The multipart body is LINE's own shape: a `messages` array of `text` (and optionally
 * `image`) objects, and **no recipient list in the body** — the ids are a JSON array in a
 * `to` part, because that is what LINE's endpoint takes. At most 500 ids, which the planner
 * and the database CHECK both enforce before this is ever called.
 *
 * It lives here rather than in the campaign module because this is the one file that knows
 * how to talk to LINE, and a second one would be a second place for the token to be read
 * wrong. It throws with LINE's own words, exactly like the push above: `429 You have reached
 * your monthly limit.` is a sentence the shop has to be able to read, and it is recorded on
 * the batch rather than retried — LINE's multicast takes no idempotency key, so a retry cannot
 * be told apart from a fresh send.
 */
export async function deliverCampaignBatch(
  batch: CampaignBatchDelivery,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const token = readLineChannelToken(env);
  if (!token) {
    throw new NotificationDeliveryError(
      'NOTIFY_LINE_TOKEN is not set, so a campaign cannot be sent on LINE',
    );
  }
  if (batch.recipientIds.length === 0) {
    throw new NotificationDeliveryError('The batch has no recipients, so nothing was sent');
  }

  const messages: Record<string, unknown>[] = [{ type: 'text', text: batch.body }];
  if (batch.imageUrl !== null) {
    messages.push({
      type: 'image',
      originalContentUrl: batch.imageUrl,
      previewImageUrl: batch.imageUrl,
    });
  }

  const form = new FormData();
  form.append('messages', JSON.stringify(messages));
  form.append('to', JSON.stringify(batch.recipientIds));

  const response = await postForm(`${lineApiBaseUrl()}/v2/bot/message/multicast`, form, {
    authorization: `Bearer ${token}`,
  });

  if (!response.ok) {
    throw new NotificationDeliveryError(
      `LINE refused the campaign (${response.status}): ${await bodySnippet(response)}`,
    );
  }
}

async function deliverToWebhook(
  notification: QueuedNotification,
  config: ChannelConfig | null,
): Promise<void> {
  const url = config?.channel === 'webhook' ? config.webhookUrl : null;
  if (!url) {
    throw new NotificationDeliveryError(
      'NOTIFY_WEBHOOK_URL is not set, so a webhook message has nowhere to go',
    );
  }

  const response = await post(
    url,
    { to: notification.recipient, text: notification.body, kind: notification.kind },
    config?.webhookSecret ? { 'x-notify-secret': config.webhookSecret } : {},
  );

  if (!response.ok) {
    throw new NotificationDeliveryError(
      `The gateway refused it (${response.status}): ${await bodySnippet(response)}`,
    );
  }
}

/**
 * A multipart POST, for the two LINE endpoints that take `FormData` rather than JSON.
 *
 * Deliberately does **not** set `content-type`: the boundary is the runtime's to pick, and
 * setting it by hand is how a multipart body arrives as an unparseable one.
 */
async function postForm(
  url: string,
  form: FormData,
  headers: Record<string, string>,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new NotificationDeliveryError(`Could not reach ${hostOf(url)}: ${reason}`);
  }
}

/**
 * A POST that fails as an exception rather than as a bad status code.
 *
 * A DNS failure, a refused connection and a timeout all have to reach the caller
 * as *this message did not go out*, because the alternative — an unhandled
 * rejection inside a worker loop — is a queue that stops with no reason recorded.
 */
async function post(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new NotificationDeliveryError(`Could not reach ${hostOf(url)}: ${reason}`);
  }
}

/** The host alone, so an error message cannot leak a gateway's token-bearing URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the gateway';
  }
}

/** A short quote of a gateway's own words, trimmed to fit in a column. */
async function bodySnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200).replace(/\s+/g, ' ').trim() || 'no response body';
  } catch {
    return 'no response body';
  }
}
