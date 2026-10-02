/**
 * `POST /api/v1/auth/otp` — send a code to prove a phone number (ADR 0020 §5).
 *
 * The second credential a customer needs, and the first cost this system imposes on
 * itself: the door is unauthenticated by necessity (a first-time customer has no
 * session) and every call spends real money texting somebody. That is the exact
 * shape the limiter exists for, so **two buckets are spent before any work**:
 * `otp_send_number` keyed by the address *and* the number, so one victim is not
 * messaged repeatedly, and `otp_send_address` keyed by the address alone, so walking
 * a list of numbers spends that second bucket. Neither is a security boundary — the
 * code itself is what is checked later — but together they cap what an anonymous
 * caller can make the shop pay.
 *
 * The response never carries the code. It goes only to the gateway, and the caller is
 * told a code was sent (or an error explaining why it was not). Deliberately, this
 * door runs for *any* well-formed number, whether or not it already belongs to a
 * customer: refusing an unknown number would turn it into an account-enumeration
 * oracle, and proving a brand-new number is precisely what a first signup needs.
 */
import { readJson, withApi } from '@/lib/api';
import { deliverOtpCode, OtpNotConfiguredError, otpTtlMinutes, readOtpChannelConfig } from '@/lib/otp';
import { issueOtpChallenge } from '@/lib/otp-store';
import { chargeRateLimit } from '@/lib/rate-limit';
import { otpSendSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const { phone } = await readJson(request, otpSendSchema);

    // Both, before the code is minted or a message is paid for.
    await chargeRateLimit(request, 'otp_send_number', phone);
    await chargeRateLimit(request, 'otp_send_address');

    const config = readOtpChannelConfig();
    if (!config) {
      throw new OtpNotConfiguredError();
    }

    const code = await issueOtpChallenge(phone);
    await deliverOtpCode(phone, code, config);

    return { sent: true, expiresInMinutes: otpTtlMinutes() };
  });
}
