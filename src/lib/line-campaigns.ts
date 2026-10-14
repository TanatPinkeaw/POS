/**
 * Campaigns as rows: planning one, reading it back, and the batches the worker sends
 * (ADR 0032 §6, §7).
 *
 * The rules live in `line-campaign-rules.ts` and `line-promo-consent.ts`; this module is the
 * other half — the reads that produce the facts those rules need, and the writes that record
 * what happened. That split is the repository's own (`credit-notes.ts` beside
 * `refund-plan.ts`), and it is why the eligibility decision is a unit test while "the
 * eligible set is the consented friends and nobody else" is an integration one.
 *
 * **Nothing here sends anything.** A campaign leaves this module fully written and fully
 * unsent; the worker's own pass picks up its batches. That is the outbox's decision, kept for
 * the same reason: a `fetch` inside a request handler loses the shop's work when the
 * connection drops, and the shop has already been told the send happened.
 */
import { recordAudit } from './audit';
import { prisma } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import type { Db } from './inventory';
import {
  campaignAuditPreview,
  campaignStatusFromBatches,
  eligibleCampaignRecipients,
  planCampaignBatches,
  type CampaignCandidate,
  type CampaignExclusion,
  type CampaignStatus,
} from './line-campaign-rules';
import { friendSubjects } from './line-friends';
import { readLineChannelToken } from './notify-channel';

/** One candidate as this module reads it, before the pure rule has its say. */
interface CandidateRow {
  subject: string;
  consentAt: Date | null;
  withdrawnAt: Date | null;
  isFriend: boolean;
}

/**
 * Every customer this shop may send a promotion to, and why the others are out.
 *
 * Two reads rather than a query per candidate: the customers (with the consent timestamps
 * that decide the state) and the friend rows. A shop with no LINE customers gets two queries
 * that find nothing and an empty audience, and a shop with a thousand gets three queries
 * total — the audience, the split, and the write.
 */
export async function readCampaignAudience(db: Db = prisma): Promise<{
  recipients: string[];
  excluded: { subject: string; reason: CampaignExclusion }[];
}> {
  /*
   * The channel here means "this deployment can talk to LINE at all", which is a token rather
   * than `NOTIFY_CHANNEL`: the exclusion sentence is "the shop has not set its LINE channel
   * up", and a shop whose own alerts go to a webhook can still send promotions on LINE
   * (ADR 0032 §6). `readLineChannelToken` is the one reader of that token.
   */
  const channel = readLineChannelToken() === null ? null : 'line';

  const rows = await db.users.findMany({
    where: { role: 'member', line_subject: { not: null } },
    select: {
      line_subject: true,
      line_promo_consent_at: true,
      line_promo_withdrawn_at: true,
    },
    orderBy: { full_name: 'asc' },
  });

  const subjects = rows.map((row) => row.line_subject as string);
  const friends = await friendSubjects(subjects, db);

  const candidates: CampaignCandidate[] = rows.map((row) => {
    const subject = row.line_subject as string;
    return {
      subject,
      channel,
      customerLineSubject: subject,
      consentAt: row.line_promo_consent_at,
      withdrawnAt: row.line_promo_withdrawn_at,
      isFriend: friends.has(subject),
    };
  });

  return eligibleCampaignRecipients(candidates);
}

/** What a shop sees before it presses send: who, how many, and how it would be split. */
export interface CampaignPlan {
  recipients: string[];
  excluded: { subject: string; reason: CampaignExclusion }[];
  batches: string[][];
  costMessages: number;
}

/** Plans a campaign — the read-only half of sending, used by the composer as well as the send. */
export async function planCampaign(db: Db = prisma): Promise<CampaignPlan> {
  const audience = await readCampaignAudience(db);
  const batches = planCampaignBatches(audience.recipients);
  return {
    recipients: audience.recipients,
    excluded: audience.excluded,
    batches,
    costMessages: audience.recipients.length,
  };
}

/** One campaign as the shop's own screen reads it. */
export interface CampaignRow {
  id: string;
  body: string;
  imageUrl: string | null;
  status: CampaignStatus;
  recipientCount: number;
  quotaRemainingAtSend: number | null;
  failureReason: string | null;
  createdAt: Date;
  sentByName: string | null;
}

/**
 * Records a campaign and its batches, in one transaction, and sends nothing.
 *
 * The recipient list is written into the batches **as it was at this moment**, not
 * recomputed later: a customer who withdraws tomorrow must not change what was sent
 * yesterday, and a batch that had to be re-derived from today's consent rows would be a
 * different message than the one the shop approved.
 *
 * The audit row is written here, in the same transaction as the campaign — a send that
 * happened and a trail that says who approved it are one fact (ADR 0007 decision 1).
 */
export async function createCampaign(input: {
  body: string;
  imageUrl: string | null;
  actorId: string;
  recipientIds: string[];
  quotaRemainingAtSend: number | null;
}): Promise<CampaignRow> {
  const body = input.body.trim();
  if (body.length === 0) {
    throw new ValidationError('เขียนข้อความก่อนส่ง', [
      { path: 'body', message: 'required' },
    ]);
  }
  if (input.recipientIds.length === 0) {
    throw new ConflictError(
      'ยังไม่มีลูกค้าที่รับโปรโมชันได้ — ต้องผูกบัญชี LINE เพิ่มเพื่อนร้าน และยินยอมรับโปรโมชันก่อน',
      'NO_CAMPAIGN_RECIPIENTS',
    );
  }

  const batches = planCampaignBatches(input.recipientIds);

  return prisma.$transaction(async (tx) => {
    const campaign = await tx.line_campaigns.create({
      data: {
        body,
        image_url: input.imageUrl,
        sent_by_user_id: input.actorId,
        // Written as `pending`: the campaign exists and nothing has gone out. Its batches
        // are what move it, and the worker is what moves them.
        status: 'pending',
        recipient_count: input.recipientIds.length,
        quota_remaining_at_send: input.quotaRemainingAtSend,
      },
      select: { id: true, created_at: true },
    });

    await tx.line_campaign_batches.createMany({
      data: batches.map((recipientIds, index) => ({
        campaign_id: campaign.id,
        batch_index: index,
        recipient_ids: recipientIds,
        status: 'pending',
      })),
    });

    await recordAudit(
      {
        action: 'line_campaign_sent',
        actorUserId: input.actorId,
        targetType: 'line_campaign',
        targetId: campaign.id,
        detail: {
          recipients: input.recipientIds.length,
          batches: batches.length,
          preview: campaignAuditPreview(body),
          quotaRemainingAtSend: input.quotaRemainingAtSend,
        },
      },
      tx,
    );

    return {
      id: campaign.id,
      body,
      imageUrl: input.imageUrl,
      status: 'pending' as CampaignStatus,
      recipientCount: input.recipientIds.length,
      quotaRemainingAtSend: input.quotaRemainingAtSend,
      failureReason: null,
      createdAt: campaign.created_at,
      sentByName: null,
    };
  });
}

/** The campaigns the shop has sent, newest first, with who pressed send. */
export async function listCampaigns(limit = 20, db: Db = prisma): Promise<CampaignRow[]> {
  const rows = await db.line_campaigns.findMany({
    orderBy: { created_at: 'desc' },
    take: limit,
    select: {
      id: true,
      body: true,
      image_url: true,
      status: true,
      recipient_count: true,
      quota_remaining_at_send: true,
      failure_reason: true,
      created_at: true,
      sent_by: { select: { full_name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    imageUrl: row.image_url,
    status: row.status as CampaignStatus,
    recipientCount: row.recipient_count,
    quotaRemainingAtSend: row.quota_remaining_at_send,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    sentByName: row.sent_by?.full_name ?? null,
  }));
}

/** One batch as the worker needs it: who to send to, what to say, and which campaign. */
export interface DueCampaignBatch {
  id: string;
  campaignId: string;
  batchIndex: number;
  recipientIds: string[];
  body: string;
  imageUrl: string | null;
}

/**
 * The batches that have not been tried yet, oldest first.
 *
 * `status = 'pending'` is the whole filter, and there is deliberately no time-based retry:
 * at most once is the decision (ADR 0032 §7), so a batch that failed is not picked up again
 * by anything. A person reads the failure and writes a new campaign.
 */
export async function dueCampaignBatches(limit = 20, db: Db = prisma): Promise<DueCampaignBatch[]> {
  const rows = await db.line_campaign_batches.findMany({
    /*
     * `attempted_at: null` is part of "due", not decoration. A batch somebody already tried
     * is not handed out again — see `claimCampaignBatch` — and a list that included it would
     * have the worker claim rows it is about to refuse, every pass, forever.
     */
    where: { status: 'pending', attempted_at: null },
    /*
     * A campaign's batches in their own order, oldest campaign first: sending batch 3 of a
     * campaign before batch 1 is not wrong (each is an independent request to 500 people) but
     * it makes a shop's own history read backwards, and `id` alone is a random uuid ordering.
     */
    orderBy: [{ campaign_id: 'asc' }, { batch_index: 'asc' }],
    take: limit,
    select: {
      id: true,
      campaign_id: true,
      batch_index: true,
      recipient_ids: true,
      campaign: { select: { body: true, image_url: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    batchIndex: row.batch_index,
    recipientIds: row.recipient_ids,
    body: row.campaign.body,
    imageUrl: row.campaign.image_url,
  }));
}

/**
 * Takes one batch, or answers that somebody else has it.
 *
 * A conditional `UPDATE` from `pending`, which is where "at most once" is actually enforced:
 * two workers started at the same moment both read the same due list, and exactly one of them
 * wins this statement. The attempt is stamped before the send, so a worker killed mid-request
 * leaves a batch that says it is being tried rather than one that silently disappears.
 */
export async function claimCampaignBatch(
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  /*
   * `attempted_at: null` is the guard that makes this at-most-once rather than merely
   * "stamped": two workers that read the same due list both call this, and only the first
   * finds a row with no attempt on it. The stamp is written *before* the request leaves, so a
   * worker killed mid-send leaves a batch that says it was tried — which is exactly the truth,
   * and `abandonStalledCampaignBatches` is how it stops being ambiguous.
   */
  const result = await prisma.line_campaign_batches.updateMany({
    where: { id, status: 'pending', attempted_at: null },
    data: { attempted_at: now },
  });
  return result.count === 1;
}

/**
 * How long an attempted batch may sit with no outcome before it is called unknown (ADR 0032 §7).
 *
 * Five minutes: the request itself times out at ten seconds (`notify-channel.ts`), so anything
 * this old means the process died between the stamp and the write — not that LINE is slow.
 */
export const CAMPAIGN_BATCH_STALL_MS = 5 * 60_000;

/**
 * Records the batches whose worker died between the attempt and the outcome.
 *
 * The one case "at most once" leaves behind, and it is dealt with by *saying so* rather than
 * by retrying: LINE offers no idempotency key, so a second attempt cannot be told apart from
 * a fresh send, and this repository has already decided that a duplicated promotion is worse
 * than a short one. The batch is therefore marked failed with a sentence that states the
 * ambiguity — some of those customers may well have received it — and the campaign moves to
 * `partial` or `failed`, which is the state an admin can act on by writing a new campaign.
 *
 * Returns how many were abandoned, so a worker's own report can print it.
 */
export async function abandonStalledCampaignBatches(
  now: Date = new Date(),
  graceMs: number = CAMPAIGN_BATCH_STALL_MS,
): Promise<number> {
  const stalled = await prisma.line_campaign_batches.findMany({
    where: { status: 'pending', attempted_at: { not: null, lte: new Date(now.getTime() - graceMs) } },
    select: { id: true, campaign_id: true },
  });

  for (const batch of stalled) {
    await markCampaignBatchFailed(
      batch.id,
      'ไม่ทราบผลจาก LINE — การส่งถูกเริ่มแล้วแต่ไม่มีคำตอบกลับ อาจมีลูกค้าได้รับข้อความไปแล้ว',
    );
  }

  return stalled.length;
}

/** The batch went out. */
export async function markCampaignBatchSent(id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.line_campaign_batches.updateMany({
      // From `pending` rather than from "anything": the claim left the status alone, so this
      // is the write that ends the attempt, and a batch already finished stays untouched.
      where: { id, status: 'pending' },
      data: { status: 'sent', error: null },
    });
    await refreshCampaignStatusFor(id, tx);
  });
}

/**
 * The batch did not go out, and LINE said why.
 *
 * Recorded on the batch rather than retried: LINE's multicast takes no idempotency key, so a
 * second attempt cannot be told apart from a fresh send, and the failure is what a person
 * needs in order to decide. When it was the last batch the campaign itself becomes `failed`
 * with LINE's own words on it, so the screen has something to show beside the composer.
 */
export async function markCampaignBatchFailed(id: string, error: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.line_campaign_batches.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'failed', error: error.slice(0, 500) },
    });
    await refreshCampaignStatusFor(id, tx);
  });
}

/** Recomputes one campaign's status from its batches. */
async function refreshCampaignStatusFor(batchId: string, db: Db): Promise<void> {
  const batch = await db.line_campaign_batches.findUnique({
    where: { id: batchId },
    select: { campaign_id: true },
  });
  if (!batch) {
    return;
  }
  await refreshCampaignStatus(batch.campaign_id, db);
}

/**
 * The campaign's status, read from its batches and written back.
 *
 * `failure_reason` is set only when nothing went out at all: a partial campaign keeps the
 * batch's own error on the batch, because the sentence that matters for `partial` is "some
 * customers got this and some did not" rather than a copy of LINE's last complaint.
 */
export async function refreshCampaignStatus(campaignId: string, db: Db = prisma): Promise<void> {
  const batches = await db.line_campaign_batches.findMany({
    where: { campaign_id: campaignId },
    select: { status: true, error: true },
  });

  const status = campaignStatusFromBatches(batches.map((batch) => batch.status));
  const failures = batches.filter((batch) => batch.status === 'failed');
  const failureReason =
    status === 'failed'
      ? (failures.find((batch) => batch.error !== null)?.error ??
        'LINE ปฏิเสธการส่ง — ตรวจการตั้งค่าช่องทางแล้วลองใหม่')
      : null;

  await db.line_campaigns.update({
    where: { id: campaignId },
    data: {
      status,
      failure_reason: status === 'failed' ? failureReason : null,
    },
  });
}

/** One batch, for a test or a screen that wants to be sure nothing is left to send. */
export async function campaignBatches(campaignId: string, db: Db = prisma) {
  const rows = await db.line_campaign_batches.findMany({
    where: { campaign_id: campaignId },
    orderBy: { batch_index: 'asc' },
    select: { batch_index: true, status: true, recipient_ids: true, error: true },
  });
  if (rows.length === 0) {
    throw new NotFoundError('ไม่พบแคมเปญที่ระบุ', `Campaign ${campaignId}`);
  }
  return rows;
}
