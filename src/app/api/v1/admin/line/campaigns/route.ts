/**
 * `POST /api/v1/admin/line/campaigns` — send a promotion to the shop's own customers
 * (ADR 0032 §6–7).
 *
 * **Admin only, and that is the whole authorisation story**: a campaign is the one act in
 * this system that reaches every customer at once and cannot be taken back, so it is not a
 * thing a cashier does between two bills. The audit row is written in the same transaction as
 * the campaign, and the limiter counts the *account* rather than the address — two admins on
 * the shop's one wifi are two people, the shape `member_create` established.
 *
 * **Nothing is sent inside this request.** The campaign and its batches are written, and the
 * shop's own worker delivers them (`npm run notify:worker`), which is the same decision the
 * outbox makes: a `fetch` in the handler loses the shop's work when the connection drops, and
 * the response has already told the admin it went out.
 *
 * The refusals are Thai and each says what to do, because every one of them is a sentence an
 * admin is standing in front of a screen to read:
 *
 *   * LINE is not configured → the composer was rendered without a channel to send on;
 *   * nobody is eligible → with the counts that produced it, which is the number that tells
 *     the shop whether to ask more customers for consent rather than to rewrite the message;
 *   * the month's allowance cannot pay for it → with both numbers;
 *   * the image link is not drawable → the same reader a product photo goes through
 *     (ADR 0014), so a Nextcloud share link keeps working.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { renderableImageUrl } from '@/lib/image-url';
import { planCampaign, createCampaign } from '@/lib/line-campaigns';
import { campaignAffordable } from '@/lib/line-campaign-rules';
import { readLineChannelToken } from '@/lib/notify-channel';
import { readLineQuota } from '@/lib/line-quota';
import { chargeRateLimit } from '@/lib/rate-limit';
import { campaignSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    await chargeRateLimit(request, 'line_campaign', session.id);

    const body = await readJson(request, campaignSchema);

    /*
     * The precondition is a **token**, not the outbox's own channel: those are two questions,
     * and a shop's alerts can go to a webhook while its promotions go out on LINE (ADR 0032
     * §6). `readLineChannelToken` is the one reader of it.
     */
    if (readLineChannelToken() === null) {
      return {
        ok: false,
        reason: 'channel_not_line',
        message:
          'ร้านนี้ยังไม่ได้ตั้งค่าโทเคนของ LINE — ใส่ NOTIFY_LINE_TOKEN ก่อนจึงจะส่งโปรโมชันได้',
      };
    }

    const imageUrl = renderableImageUrl(body.imageUrl);
    if (body.imageUrl && imageUrl === null) {
      return {
        ok: false,
        reason: 'image_not_drawable',
        message: 'ลิงก์รูปที่ใส่มาเปิดเป็นรูปไม่ได้ — ใช้ลิงก์ที่ลงท้ายด้วยรูปภาพ หรือลิงก์แชร์ของ Nextcloud',
      };
    }

    const plan = await planCampaign();
    if (plan.recipients.length === 0) {
      return {
        ok: false,
        reason: 'no_recipients',
        message:
          'ยังไม่มีลูกค้าที่รับโปรโมชันได้เต็มเงื่อนไข — ต้องผูกบัญชี LINE เพิ่มเพื่อนร้าน และกดยินยอมรับโปรโมชัน',
        excluded: summarise(plan.excluded),
      };
    }

    /*
     * The month's allowance, read before anything is written. This is a courtesy and a
     * measurement rather than the authority: LINE's own documentation warns a send can be
     * refused with the monthly-limit error while the console still shows messages left, so a
     * refusal here saves the shop a campaign it would have to redo, and LINE's own refusal is
     * what lands on the batch if this read was wrong.
     */
    const quota = await readLineQuota();
    if (quota !== null && !campaignAffordable(quota.remaining, plan.recipients.length)) {
      return {
        ok: false,
        reason: 'quota_short',
        message: `โควตาข้อความเดือนนี้เหลือ ${quota.remaining} ข้อความ แต่แคมเปญนี้ต้องใช้ ${plan.recipients.length} ข้อความ — ลดรายชื่อหรือรอเดือนถัดไป`,
        remaining: quota.remaining,
        cost: plan.recipients.length,
      };
    }

    const campaign = await createCampaign({
      body: body.body,
      imageUrl,
      actorId: session.id,
      recipientIds: plan.recipients,
      quotaRemainingAtSend: quota?.remaining ?? null,
    });

    return {
      ok: true,
      campaign,
      // The batches are written and nothing has gone out: this is the number the admin's own
      // screen says while the shop's worker delivers them.
      batches: plan.batches.length,
      excluded: summarise(plan.excluded),
    };
  });
}

/** The exclusions as counts per reason, which is what a screen shows. */
function summarise(
  excluded: { subject: string; reason: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of excluded) {
    counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  }
  return counts;
}
