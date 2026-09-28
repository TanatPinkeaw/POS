/**
 * Money the bank told us about, and what we managed to do with it.
 *
 * The automatic path is short — a notification arrives, it is matched to a QR,
 * the QR is confirmed, the till closes the bill — and everything interesting
 * about it is in the cases where it *cannot* be finished:
 *
 *   * a notification that names no bill, or names one that is already paid;
 *   * the same notification twice, because the bridge retried;
 *   * money that is not a sale at all.
 *
 * None of those may end with the money missing from the record, and none of them
 * may end with money attached to a bill it did not pay. So a transfer is written
 * down whatever happens, with the reason it could not be attributed, and someone
 * is shown it. `src/lib/inbound-match.ts` makes the decision; this module is the
 * record of it.
 *
 * **Ordering, and the window it leaves.** The decision is made, the QR is
 * confirmed, and only then is the row written. A crash between the last two leaves
 * a closed bill with no inbound row — and the bill's own `paid_at` still says the
 * money came in, so the record is recoverable and merely incomplete. The other
 * order (write "matched" first, confirm after) can leave a row claiming to have
 * closed a bill that is still sitting on a QR, which is not recoverable at all:
 * a lie in the money record is worse than a gap in it.
 */
import { prisma } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { matchInboundTransfer, type InboundRefusalReason } from './inbound-match';
import { fromDecimal, roundThb } from './money';
import { confirmIntent } from './payment-intents';
import { recordAudit } from './audit';
import type { InboundStatus, InboundTransferView } from './inbound-transfer-view';

export type { InboundStatus, InboundTransferView } from './inbound-transfer-view';

/** A recorded transfer, plus whether it had been recorded before. */
export interface InboundRecord extends InboundTransferView {
  duplicate: boolean;
}

/** How far back a notification may pay a QR. */
const CANDIDATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many candidates one notification is compared against. */
const CANDIDATE_LIMIT = 50;

/** How many unattributed transfers the screen is asked for at a time. */
export const INBOUND_PAGE_SIZE = 25;

/**
 * Records a transfer and tries to close a bill with it.
 *
 * Idempotent on the bank's own message id: a retrying bridge gets the same row
 * back rather than a second one, because money is counted from this table.
 */
export async function recordInboundTransfer(input: {
  /**
   * What the amount was read out as, or null when the notification could not be
   * read at all.
   *
   * Null is legitimate and reaches the record: a bridge that cannot make sense
   * of a bank's wording must still not lose the money, so it posts the text it
   * has and the transfer is filed as `amount_unreadable`. A *stated* amount of
   * zero or less is different — that is a caller bug, and it is refused.
   */
  amountThb: number | null;
  text: string;
  source: string;
  receivedAt?: Date;
  externalId?: string | null;
}): Promise<InboundRecord> {
  const amountThb = input.amountThb === null ? null : roundThb(input.amountThb);
  if (amountThb !== null && (!Number.isFinite(amountThb) || amountThb <= 0)) {
    throw new ValidationError('เงินโอนที่แจ้งเข้ามาต้องมีจำนวนมากกว่าศูนย์');
  }

  const source = input.source.trim();
  if (source.length === 0) {
    throw new ValidationError('ต้องระบุแหล่งที่มาของการแจ้งเงินโอน');
  }

  const externalId = input.externalId?.trim() || null;
  const receivedAt = input.receivedAt ?? new Date();
  const text = input.text ?? '';

  if (externalId) {
    const existing = await prisma.inbound_payments.findUnique({
      where: { source_external_id: { source, external_id: externalId } },
    });
    if (existing) {
      return { ...toView(existing), duplicate: true };
    }
  }

  const match =
    amountThb === null
      ? ({ matched: false, reason: 'amount_unreadable', refs: [] } as const)
      : matchInboundTransfer(
          { amountThb, text, receivedAt },
          await candidatesFor(amountThb, receivedAt),
        );

  /*
   * A matched QR is confirmed before the row is written, and its answer is
   * believed rather than assumed: `confirmIntent` is a conditional update, so a
   * cashier who confirmed the same QR by hand a moment ago leaves it unmoved, and
   * this transfer is then simply unattributable like any other.
   */
  let matchedRef: string | null = null;
  if (match.matched) {
    const intent = await confirmIntent({ ref: match.ref, confirmedByUserId: null });
    if (intent.status === 'paid' || intent.status === 'consumed') {
      matchedRef = intent.ref;
    }
  }

  const status: InboundStatus = matchedRef ? 'matched' : 'unmatched';
  const refusalReason = matchedRef ? null : match.matched ? 'not_payable' : match.reason;

  try {
    const row = await prisma.inbound_payments.create({
      data: {
        // Null when the amount could not be read: the record keeps the text, and
        // a null is the honest figure. The screen shows the text as it arrived.
        amount: amountThb,
        received_at: receivedAt,
        source,
        external_id: externalId,
        raw_text: text,
        status,
        refusal_reason: refusalReason,
        intent_ref: matchedRef,
      },
    });
    return { ...toView(row), duplicate: false };
  } catch (error) {
    /*
     * Two notifications with one id arriving at once: both read no existing row,
     * one insert wins and the other hits the unique index. The loser reports the
     * winner's row — which is the whole point of the index, and the reason this
     * is a lookup rather than a retry.
     */
    if (externalId && isUniqueViolation(error)) {
      const existing = await prisma.inbound_payments.findUnique({
        where: { source_external_id: { source, external_id: externalId } },
      });
      if (existing) {
        return { ...toView(existing), duplicate: true };
      }
    }
    throw error;
  }
}

/**
 * The QRs a transfer of this amount could have paid.
 *
 * Deliberately wide: every status is loaded, not only `pending`, because a
 * refusal has to be able to say *why* — "there was a QR for this amount and its
 * window had closed" is a different sentence to a person than "there was no QR
 * for this amount at all", and only the candidates can tell them apart.
 */
async function candidatesFor(amountThb: number, receivedAt: Date) {
  const rows = await prisma.payment_intents.findMany({
    where: {
      amount: amountThb,
      created_at: { gte: new Date(receivedAt.getTime() - CANDIDATE_WINDOW_MS) },
    },
    orderBy: { id: 'desc' },
    take: CANDIDATE_LIMIT,
    select: { ref: true, amount: true, status: true, expires_at: true },
  });

  return rows.map((row) => ({
    ref: row.ref,
    amountThb: fromDecimal(row.amount),
    status: row.status,
    expiresAt: row.expires_at,
  }));
}

/** What still needs a person, or the history of one status. */
export async function listInboundTransfers(input: {
  status?: InboundStatus;
  limit?: number;
} = {}): Promise<InboundTransferView[]> {
  const rows = await prisma.inbound_payments.findMany({
    where: { status: input.status ?? 'unmatched' },
    // Newest first, and `id` breaks the tie: two notifications posted in the same
    // millisecond are ordered by arrival rather than arbitrarily.
    orderBy: [{ received_at: 'desc' }, { id: 'desc' }],
    take: input.limit ?? INBOUND_PAGE_SIZE,
  });
  return rows.map(toView);
}

/**
 * A person has looked at this money and says it is not a sale of ours.
 *
 * The only human decision in the whole inbound path, and so the only part of it
 * that is audited: a machine match carries the bank's notification, while this
 * carries nothing but somebody's word. The reason is required for the same
 * reason a refund's is — it is the only written record of why the money was
 * written off.
 */
export async function dismissInboundTransfer(input: {
  id: string;
  actorId: string;
  reason: string;
}): Promise<InboundTransferView> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new ValidationError('ต้องระบุเหตุผลก่อนปิดรายการเงินโอนนี้');
  }

  const id = BigInt(input.id);
  /*
   * One conditional UPDATE rather than a read, a check and a write.
   *
   * Two admins looking at the same list is not hypothetical — it is what happens
   * when a transfer is being discussed — and the read-then-write version would
   * let the second one overwrite the first's reason while both audit rows claim
   * to be the decision. `status = 'unmatched'` makes the database pick the winner.
   */
  const updated = await prisma.inbound_payments.updateMany({
    where: { id, status: 'unmatched' },
    data: {
      status: 'dismissed',
      dismissed_reason: reason,
      dismissed_by_user_id: input.actorId,
      dismissed_at: new Date(),
    },
  });

  if (updated.count === 0) {
    const existing = await prisma.inbound_payments.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError(`Inbound payment ${input.id}`);
    }
    if (existing.status === 'matched') {
      throw new ConflictError(
        'เงินโอนรายการนี้ปิดบิลไปแล้ว จึงปิดแบบไม่ใช่ยอดขายไม่ได้',
        'INBOUND_ALREADY_MATCHED',
      );
    }
    throw new ConflictError('รายการนี้ถูกปิดไปแล้ว', 'INBOUND_ALREADY_DISMISSED');
  }

  const row = await prisma.inbound_payments.findUniqueOrThrow({ where: { id } });

  await recordAudit({
    action: 'inbound_transfer_dismissed',
    actorUserId: input.actorId,
    targetType: 'inbound_payment',
    targetId: row.id.toString(),
    detail: {
      // Null when the amount was never readable, rather than a number somebody
      // could later mistake for the transfer's value.
      amountThb: row.amount === null ? null : fromDecimal(row.amount),
      reason,
      source: row.source,
      receivedAt: row.received_at.toISOString(),
    },
  });

  return toView(row);
}

function toView(row: {
  id: bigint;
  amount: unknown | null;
  received_at: Date;
  source: string;
  status: string;
  refusal_reason: string | null;
  intent_ref: string | null;
  raw_text: string;
  dismissed_reason: string | null;
  created_at: Date;
}): InboundTransferView {
  return {
    id: row.id.toString(),
    amountThb: row.amount === null ? null : fromDecimal(row.amount as never),
    receivedAt: row.received_at,
    source: row.source,
    status: row.status as InboundStatus,
    refusalReason: row.refusal_reason as InboundRefusalReason | null,
    intentRef: row.intent_ref,
    rawText: row.raw_text,
    dismissedReason: row.dismissed_reason,
    createdAt: row.created_at,
  };
}

/** Prisma's unique-constraint code, without importing Prisma's error classes. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code === 'P2002'
    : false;
}
