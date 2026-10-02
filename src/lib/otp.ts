/**
 * The OTP seam (ADR 0020 §5): one interface that sends and checks a code for a
 * phone, with the SMS provider chosen at deploy.
 *
 * A customer proves they hold a phone number by receiving a short code. The number
 * is the identity in this system, so this door is what lets a self-serving customer
 * ever *become* one, and what re-proves a number when it changes (ADR 0020 §5). The
 * *checking* half lives in `otp-store.ts`, because it needs the database; this file
 * is the policy, the provider seam, and the delivery — the pieces a test can drive
 * without a network.
 *
 * Three decisions are load-bearing here:
 *
 *   * **The provider is a seam, not a commitment.** Like `NOTIFY_CHANNEL`, the
 *     transport is chosen at deploy through `.env` (`OTP_CHANNEL=webhook` plus a URL
 *     and an optional secret). This repo does not talk to Twilio or anybody else
 *     directly; a shop points the URL at an SMS gateway or a script, exactly as it
 *     does for its own messages. Unconfigured is a real state, and the door refuses
 *     with a message rather than failing without a code.
 *   * **The code is a secret, not a number.** Six digits is one million values, so
 *     the code is hashed at rest and short-lived, and the attempt ceiling makes
 *     exhausting it cost more than guessing it (`otp-store.ts`).
 *   * **Delivery never leaks its gateway.** The URL can carry a token in its query
 *     string, so a failure names the host and nothing else.
 */
import { randomInt } from 'node:crypto';

import { optionalNumberEnv } from './env';
import { DomainError } from './errors';

/** Six digits: long enough to be a secret, short enough to read off a phone. */
export const OTP_CODE_LENGTH = 6;

/**
 * How many wrong codes one challenge tolerates before it is dead.
 *
 * Five, the same ceiling a supervisor PIN gets. A six-digit code has a million
 * values, and five guesses against it is a one-in-two-hundred-thousand chance — but
 * the ceiling is really about the *challenge*, not the odds: without it a code is as
 * good as forever while it lives.
 */
export const OTP_MAX_ATTEMPTS = 5;

/** How long a code stays valid, in minutes. */
export function otpTtlMinutes(): number {
  return optionalNumberEnv('OTP_TTL_MINUTES', 5);
}

/**
 * A fresh code, from a CSPRNG.
 *
 * `randomInt` rather than `Math.random`: this is a credential, and a predictable
 * code is no code at all.
 */
export function generateOtpCode(): string {
  return randomInt(0, 10 ** OTP_CODE_LENGTH)
    .toString()
    .padStart(OTP_CODE_LENGTH, '0');
}

/** Whether a string is the shape of a code — checked before a hash compare. */
export function isOtpCodeShaped(value: string): boolean {
  return new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`).test(value.trim());
}

/** The instant a code issued at `now` stops being valid. */
export function otpCodeExpiry(now: Date = new Date(), minutes: number = otpTtlMinutes()): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/** The transport an OTP goes out on, or null when none is configured. */
export interface OtpChannelConfig {
  channel: 'webhook';
  /** The shop's gateway URL, or null when the channel is named but the URL is not. */
  url: string | null;
  /** Optional shared secret, sent so the gateway can refuse strangers. */
  secret: string | null;
}

/**
 * Reads the transport's configuration, or null when no channel is named.
 *
 * The shape of `readChannelConfig` for notifications, on purpose: a shop learns one
 * convention for pointing this system at something it already runs.
 */
export function readOtpChannelConfig(
  env: Record<string, string | undefined> = process.env,
): OtpChannelConfig | null {
  const channel = env.OTP_CHANNEL?.trim().toLowerCase();
  if (channel !== 'webhook') {
    return null;
  }
  return {
    channel: 'webhook',
    url: env.OTP_WEBHOOK_URL?.trim() ?? null,
    secret: env.OTP_WEBHOOK_SECRET?.trim() ?? null,
  };
}

/** Raised when the OTP door is reached on a deployment that has no provider set. */
export class OtpNotConfiguredError extends DomainError {
  constructor(
    message = 'ระบบยืนยันเบอร์ยังไม่ได้ตั้งค่า — กรุณาติดต่อร้าน',
  ) {
    super(message, 'OTP_NOT_CONFIGURED', 503);
  }
}

/** Raised when a code could not be handed to the gateway. */
export class OtpDeliveryError extends DomainError {
  constructor(message = 'ส่งรหัสยืนยันไม่สำเร็จ กรุณาลองใหม่อีกครั้ง') {
    super(message, 'OTP_DELIVERY_FAILED', 502);
  }
}

/** How long to wait on a gateway before giving up. */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Hands one code to the shop's gateway.
 *
 * The payload carries readymade `text` as well as the bare `to` and `code`, because
 * a gateway that only relays an SMS should not have to know how to phrase one. The
 * shaping of the message is a Thai sentence, which is what the customer reads.
 */
export async function deliverOtpCode(
  phone: string,
  code: string,
  config: OtpChannelConfig | null = readOtpChannelConfig(),
): Promise<void> {
  const url = config?.channel === 'webhook' ? config.url : null;
  if (!url) {
    throw new OtpDeliveryError();
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config?.secret ? { 'x-otp-secret': config.secret } : {}),
      },
      body: JSON.stringify({
        to: phone,
        code,
        kind: 'otp',
        text: `รหัสยืนยันของคุณคือ ${code}`,
      }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      report(url, `gateway answered ${response.status}`);
      throw new OtpDeliveryError();
    }
  } catch (error) {
    if (error instanceof OtpDeliveryError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    report(url, reason);
    throw new OtpDeliveryError();
  }
}

/**
 * Writes the technical reason where an operator can find it, and nowhere the
 * customer can see it: the URL routinely carries the gateway's own credential, so
 * only its host is named.
 */
function report(url: string, reason: string): void {
  console.error(`[otp] could not deliver a code via ${hostOf(url)}: ${reason}`);
}

/** The host alone, so a failure cannot log a token-bearing URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the gateway';
  }
}
