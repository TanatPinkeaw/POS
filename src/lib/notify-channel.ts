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

/** Reads the transport's configuration, or null when no channel is configured. */
export function readChannelConfig(
  env: Record<string, string | undefined> = process.env,
): ChannelConfig | null {
  const channel = env.NOTIFY_CHANNEL?.trim().toLowerCase();
  if (channel === 'line') {
    return {
      channel: 'line',
      webhookUrl: null,
      lineToken: env.NOTIFY_LINE_TOKEN?.trim() ?? null,
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

  const response = await post(
    'https://api.line.me/v2/bot/message/push',
    { to: notification.recipient, messages: [{ type: 'text', text: notification.body }] },
    { authorization: `Bearer ${token}` },
  );

  if (!response.ok) {
    throw new NotificationDeliveryError(
      `LINE refused the push (${response.status}): ${await bodySnippet(response)}`,
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
