import { LineConsole, type LineCampaignRow, type LineOutboxRow } from '@/components/admin/LineConsole';
import { LineReadinessPanel } from '@/components/admin/LineReadinessPanel';
import { PageHeader, Stack } from '@/components/ds';
import { bangkokDateTimeString } from '@/lib/bangkok-time';
import { readNoticeAudience } from '@/lib/line-audience';
import { planCampaign, listCampaigns } from '@/lib/line-campaigns';
import { countLineFriends } from '@/lib/line-friends';
import { readLiffId } from '@/lib/line-liff-entry';
import { LineQuotaUnavailableError, readLineQuota, type LineQuota } from '@/lib/line-quota';
import { lineReadiness, outboxStalled } from '@/lib/line-readiness';
import { listAbandonedNotifications, oldestDueAt, outboxHealth } from '@/lib/notify-outbox';
import { readLineChannelToken } from '@/lib/notify-channel';
import { requireShellUser } from '@/lib/shell';

/**
 * The shop's LINE screen (ADR 0032 §8) — what it can send, who will get it, what it costs,
 * what it sent, and what did not go out.
 *
 * Admin-only by the page matrix (`/admin` grants admins and nobody else) and again here, where
 * the data is actually read. This screen exists because a campaign is the one act in this
 * system that reaches every customer at once and cannot be taken back, and it is the only
 * place where what the shop *may* send (consent), what it *can afford* (the month's allowance)
 * and what it *did* send (the record) are the same question. Spread across settings, the
 * customer list and a dashboard, each would be answerable and none of them together.
 *
 * Everything is read on the server, so the screen arrives with its numbers rather than with
 * spinners where a shop's money and its customers' consent should be — and the timestamps are
 * formatted here, in Bangkok time, so the browser's own zone cannot turn a send into yesterday.
 */
export const dynamic = 'force-dynamic';

export default async function AdminLinePage() {
  await requireShellUser(['admin']);

  /*
   * "Configured" for this screen is a **token**, not the outbox's channel: the promotions on
   * this page go to customers' LINE, which is a different question from where the shop's own
   * alerts are delivered (ADR 0032 §6).
   */
  const lineConfigured = readLineChannelToken() !== null;

  /*
   * The audience and the quota are two different questions and each can fail on its own.
   *
   * The quota read is the one that can throw — LINE may be unreachable, the token wrong, the
   * answer unreadable — and it is caught rather than allowed to take the screen down: the
   * composer still has to render, because *the messages and the history are the shop's own
   * data*, and an admin who cannot see LINE's counter still needs to read what went out.
   */
  const plan = await planCampaign();

  let quota: LineQuota | null = null;
  let quotaError: string | null = null;
  try {
    quota = await readLineQuota();
  } catch (error) {
    quotaError =
      error instanceof LineQuotaUnavailableError
        ? error.message
        : 'อ่านโควตาข้อความของ LINE ไม่ได้ — ตรวจการตั้งค่าโทเคนแล้วลองโหลดหน้านี้ใหม่';
  }

  const campaigns: LineCampaignRow[] = (await listCampaigns(20)).map((campaign) => ({
    id: campaign.id,
    body: campaign.body,
    imageUrl: campaign.imageUrl,
    status: campaign.status,
    recipientCount: campaign.recipientCount,
    quotaRemainingAtSend: campaign.quotaRemainingAtSend,
    failureReason: campaign.failureReason,
    sentAt: bangkokDateTimeString(campaign.createdAt),
    sentByName: campaign.sentByName,
  }));

  const outbox: LineOutboxRow[] = (await listAbandonedNotifications(20)).map((row) => ({
    id: row.id,
    kind: row.kind,
    recipient: row.recipient,
    lastError: row.lastError,
    attempts: row.attempts,
  }));

  /*
   * The readiness half, read from the **process's** environment rather than from `.env`:
   * this is the environment the planner will actually use when a cashier packs an order,
   * and a panel that read the file would answer a different question from the one that
   * matters. `npm run line:wizard` is the file's reader.
   *
   * `outboxHealth` and `oldestDueAt` are two reads of one question, and both are needed:
   * the count says whether anything is waiting, the timestamp says for how long. A worker
   * that was never started leaves everything pending and nothing abandoned, so neither
   * the dashboard's existing card nor a status column would show it (ADR 0035).
   */
  const [health, oldest] = await Promise.all([outboxHealth(), oldestDueAt()]);

  return (
    <Stack gap="lg">
      <PageHeader
        title="LINE และโปรโมชัน"
        subtitle="ส่งโปรโมชันถึงลูกค้าที่ผูกบัญชี LINE ไว้ เพิ่มเพื่อนร้าน และยินยอมรับโปรโมชันแล้ว — ดูยอดโควตาก่อนกดส่ง"
      />

      <LineReadinessPanel
        doors={lineReadiness()}
        audience={await readNoticeAudience()}
        outbox={health}
        stalled={outboxStalled({ dueNow: health.dueNow, oldestDueAt: oldest })}
      />

      <LineConsole
        lineConfigured={lineConfigured}
        liffConfigured={readLiffId() !== null}
        recipients={plan.recipients.length}
        excluded={plan.excluded.reduce<Record<string, number>>((counts, entry) => {
          counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
          return counts;
        }, {})}
        friendCount={await countLineFriends()}
        quota={quota}
        quotaError={quotaError}
        initialCampaigns={campaigns}
        initialOutbox={outbox}
      />
    </Stack>
  );
}
