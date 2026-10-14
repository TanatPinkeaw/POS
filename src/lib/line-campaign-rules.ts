/**
 * Who a campaign reaches, how it is split, and what it costs (ADR 0032 §6).
 *
 * Three answers, all pure, and each one is a number the shop is asked to trust before it
 * presses send on an act that cannot be taken back:
 *
 *   * **Who** — the customers this shop may send a promotion to: consented *and* a friend of
 *     the Official Account. The rule is not re-invented here; it is `linePromoConsentBlock`'s,
 *     called per candidate, so there is one place that knows what consent means.
 *   * **In what batches** — LINE's multicast takes at most 500 user ids per request, so a
 *     list of 1,200 customers is three requests. `planCampaignBatches` is where that split
 *     lives, in stable order so a run is reproducible and a stored batch can be compared to
 *     what was computed.
 *   * **What it costs** — one message per recipient, counted against the month's allowance
 *     (300 on Thailand's free plan). `campaignAffordable` is the pre-check, and it is a
 *     *courtesy*: LINE's own documentation warns a send can be refused with the
 *     monthly-limit error while the console still shows messages left, so the authority is
 *     the refusal recorded on the batch.
 *
 * No I/O and no `prisma` import. The friend row and the consent timestamps arrive as
 * parameters the caller read, the same shape `lineCustomerNotifyBlock` established, so the
 * eligibility rule is a unit test rather than a database fixture.
 */
import {
  linePromoConsentBlock,
  type LinePromoBlock,
  type LinePromoEligibilityInput,
} from './line-promo-consent';

/**
 * LINE's documented maximum recipients per multicast request.
 *
 * Stated once, here, and mirrored by a CHECK on `line_campaign_batches.recipient_ids`: a
 * batch of 501 would be refused by LINE *after* the shop had been told it was queued, which
 * is the wrong order to find out in.
 */
export const MAX_RECIPIENTS_PER_REQUEST = 500;

/** One candidate as the eligibility rule needs them: the LINE facts, and who they are. */
export interface CampaignCandidate extends LinePromoEligibilityInput {
  /** The LINE user id to send to. The same value as the customer's `line_subject`. */
  subject: string;
}

/** Why a campaign cannot reach a candidate; `linePromoConsentBlock`'s own closed set. */
export type CampaignExclusion = LinePromoBlock;

/** The whole answer: who is in, and why each of the others is not. */
export interface CampaignAudience {
  /** The recipients, in the order given — the caller's order, never re-sorted. */
  recipients: string[];
  /** One entry per excluded candidate, so the screen can count the reasons. */
  excluded: { subject: string; reason: CampaignExclusion }[];
}

/**
 * The customers a campaign may reach.
 *
 * The order of the input is preserved rather than sorted here: which order a shop's own list
 * is in is the caller's business (it is the customer list's order, which a person can see),
 * and `planCampaignBatches` is where stability is guaranteed, because that is where a stored
 * batch has to match a recomputed one.
 */
export function eligibleCampaignRecipients(candidates: CampaignCandidate[]): CampaignAudience {
  const recipients: string[] = [];
  const excluded: { subject: string; reason: CampaignExclusion }[] = [];

  for (const candidate of candidates) {
    const block = linePromoConsentBlock(candidate);
    if (block === null) {
      recipients.push(candidate.subject);
    } else {
      excluded.push({ subject: candidate.subject, reason: block });
    }
  }

  return { recipients, excluded };
}

/**
 * Splits recipients into the requests LINE will accept.
 *
 * No empty tail: `Math.ceil(0 / 500)` is 0 requests and `Math.ceil(500 / 500)` is one, and
 * both are asserted in the tests rather than left to the arithmetic looking right. Every
 * batch is at most `MAX_RECIPIENTS_PER_REQUEST`, and the order is the order given — a batch
 * that is stored and later compared cannot have been shuffled in between.
 */
export function planCampaignBatches(
  recipients: string[],
  maxPerRequest: number = MAX_RECIPIENTS_PER_REQUEST,
): string[][] {
  if (maxPerRequest < 1) {
    throw new Error('maxPerRequest must be at least 1');
  }
  const batches: string[][] = [];
  for (let start = 0; start < recipients.length; start += maxPerRequest) {
    batches.push(recipients.slice(start, start + maxPerRequest));
  }
  return batches;
}

/**
 * What a send costs, in LINE messages.
 *
 * One message **per recipient**, not per request: LINE counts multicast per recipient, which
 * is also why a push into the shop's own group costs one message for every member of it. A
 * campaign to 250 customers spends 250 of the month's 300.
 */
export function campaignCostMessages(recipients: number): number {
  return Math.max(0, Math.trunc(recipients));
}

/**
 * Whether the month's allowance can pay for this campaign.
 *
 * `remaining === null` means **no limit** (LINE's own `type: 'none'`), not "unknown": a
 * number that could not be read is a different case and does not reach this function — the
 * caller refuses the send rather than guessing, because the shop is about to spend money's
 * worth of a quota and a guess in either direction is a lie to somebody.
 */
export function campaignAffordable(remaining: number | null, recipients: number): boolean {
  if (remaining === null) {
    return true;
  }
  return campaignCostMessages(recipients) <= remaining;
}

/** What a campaign's batches add up to. */
export type CampaignStatus = 'pending' | 'sent' | 'partial' | 'failed';

/**
 * The campaign's own status, from its batches.
 *
 * `partial` is the state the screen must be able to show, because it is the one a shop
 * cannot otherwise see: some customers got the message and others did not, and a status that
 * folded that into "sent" would hide the only case where somebody has to decide whether to
 * send again. A campaign with no batches yet is `pending`.
 */
export function campaignStatusFromBatches(
  statuses: readonly string[],
): CampaignStatus {
  if (statuses.length === 0 || statuses.every((status) => status === 'pending')) {
    return 'pending';
  }
  if (statuses.every((status) => status === 'sent')) {
    return 'sent';
  }
  if (statuses.some((status) => status === 'sent')) {
    return 'partial';
  }
  return 'failed';
}

/**
 * The first words of a campaign, for the audit row.
 *
 * A dispatch record rather than a copy of the promotion: the trail says *that* a message went
 * to two hundred customers and what it opened with, and the campaign row is where the whole
 * text lives.
 */
export const CAMPAIGN_AUDIT_PREVIEW_LENGTH = 60;

export function campaignAuditPreview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= CAMPAIGN_AUDIT_PREVIEW_LENGTH
    ? flat
    : `${flat.slice(0, CAMPAIGN_AUDIT_PREVIEW_LENGTH)}…`;
}
