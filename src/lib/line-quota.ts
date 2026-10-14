/**
 * How much of the month's messaging allowance is left (ADR 0032 §6).
 *
 * LINE counts **per recipient**, and Thailand's free plan is 300 messages a month, so a
 * campaign to 250 customers spends 250 of it. Two endpoints answer the question:
 * `GET /v2/bot/message/quota` returns `{ type, value }` — `type: 'none'` meaning no limit at
 * all — and `GET /v2/bot/message/quota/consumption` returns `{ totalUsage }`.
 *
 * **This is a courtesy, not the authority.** LINE's own documentation warns that a send can
 * be refused with `429 You have reached your monthly limit.` while the console still shows
 * messages remaining, which is why the refusal recorded on a batch is what a later reader
 * trusts and this read only fills in the composer's number.
 *
 * The base URL is `LINE_API_BASE_URL`, defaulting to LINE's own host — the same recorded
 * trade `LINE_TOKEN_URL` and `LINE_JWKS_URL` make for the token exchange (ADR 0030 §6):
 * whoever sets it moves where this server sends the shop's own channel token, so it is set
 * from the same `.env` that already holds that secret, and the acceptance run is what uses it
 * to stand a stub in LINE's place.
 */
import { DomainError } from './errors';

/** LINE's own API host, used whenever `LINE_API_BASE_URL` is unset. */
export const LINE_API_DEFAULT_BASE_URL = 'https://api.line.me';

/** Where the shop's channel token is sent. Overridable, and warned about in `.env.example`. */
export function lineApiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = env.LINE_API_BASE_URL?.trim();
  if (!configured) {
    return LINE_API_DEFAULT_BASE_URL;
  }
  return configured.replace(/\/+$/, '');
}

/**
 * LINE could not be asked, or answered something unreadable.
 *
 * A `DomainError` rather than a bare `Error` for the reason `withApi` documents: anything
 * else becomes a 500 and "something went wrong on our side", while this is a fact the shop
 * can act on — the token, the address, or LINE's own availability.
 */
export class LineQuotaUnavailableError extends DomainError {
  constructor(message: string, detail?: string) {
    super(message, 'LINE_QUOTA_UNAVAILABLE', 502, undefined, detail);
  }
}

/** The month's allowance as LINE reports it, in whole messages. */
export interface LineQuota {
  /** False when LINE reports no limit at all (`type: 'none'`). */
  limited: boolean;
  /** The month's cap, or null when there is none. */
  limit: number | null;
  /** What has been spent this month. */
  consumed: number;
  /** What is left, or null when there is no limit to be left of. */
  remaining: number | null;
}

/** How long to wait on LINE before giving up: the shop is watching a screen. */
const QUOTA_TIMEOUT_MS = 8_000;

/**
 * Reads the month's allowance, or null when no channel token is configured.
 *
 * Null and *unreadable* are different answers and are kept apart: null means "this shop has
 * not turned LINE on", which the screen says in its own words, while a failure to read a
 * configured channel throws — a number nobody could read must not be rendered as a number.
 */
export async function readLineQuota(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LineQuota | null> {
  const token = env.NOTIFY_LINE_TOKEN?.trim();
  if (!token) {
    return null;
  }

  const base = lineApiBaseUrl(env);
  const headers = { authorization: `Bearer ${token}` };

  const [quotaBody, usageBody] = await Promise.all([
    getJson(`${base}/v2/bot/message/quota`, headers, fetchImpl),
    getJson(`${base}/v2/bot/message/quota/consumption`, headers, fetchImpl),
  ]);

  const type = typeof quotaBody.type === 'string' ? quotaBody.type : null;
  const rawValue = quotaBody.value;
  const limit = type === 'none' ? null : Number(rawValue);
  if (limit !== null && !Number.isFinite(limit)) {
    throw new LineQuotaUnavailableError(
      'อ่านโควตาข้อความของ LINE ไม่ได้ — ลองอีกครั้ง หรือส่งแบบไม่ดูยอดคงเหลือ',
      `quota.value was ${String(rawValue)}`,
    );
  }

  const consumed = Number(usageBody.totalUsage);
  if (!Number.isFinite(consumed)) {
    throw new LineQuotaUnavailableError(
      'อ่านยอดใช้ข้อความของเดือนนี้จาก LINE ไม่ได้ — ลองอีกครั้ง',
      `consumption.totalUsage was ${String(usageBody.totalUsage)}`,
    );
  }

  return {
    limited: limit !== null,
    limit,
    consumed,
    // Never negative: a shop whose consumption has overshot its cap (a plan changed
    // mid-month) must not be shown a negative remainder, which reads as a credit.
    remaining: limit === null ? null : Math.max(0, limit - consumed),
  };
}

/** One LINE `GET`, with every failure turned into a sentence a screen can show. */
async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LineQuotaUnavailableError(
      'ติดต่อ LINE ไม่ได้ — ตรวจการเชื่อมต่อของเซิร์ฟเวอร์แล้วลองใหม่',
      `${hostOf(url)}: ${reason}`,
    );
  }

  if (!response.ok) {
    throw new LineQuotaUnavailableError(
      'LINE ไม่ตอบคำถามเรื่องโควตาข้อความ — ตรวจโทเคนของช่องทางแล้วลองใหม่',
      `${response.status}: ${(await snippet(response)) || 'no response body'}`,
    );
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new LineQuotaUnavailableError(
      'LINE ตอบกลับในรูปแบบที่อ่านไม่ได้ — ลองอีกครั้ง',
      'response was not JSON',
    );
  }
}

/** The host alone, so an error message cannot leak a token-bearing address. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'LINE';
  }
}

async function snippet(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
  } catch {
    return 'no response body';
  }
}
