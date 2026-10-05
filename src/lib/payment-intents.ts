/**
 * Payment intents: the QR the till shows, and what became of it.
 *
 * **What this can and cannot do.** It can mint a PromptPay QR that is locked to
 * one amount (see `promptpay.ts`), show it on two screens, and close a bill the
 * instant a confirmation arrives. It cannot know that money arrived by itself —
 * that is a fact only a bank has, and it reaches us through whatever the shop
 * has to carry it: a bank-notification bridge posting to the confirmation
 * endpoint with `PAYMENT_WEBHOOK_SECRET`, a payment provider doing the same, or a
 * person who looked at the banking app and is willing to sign for it with their
 * PIN. All three end in the same call, and this module treats them the same,
 * because the difference between them is a business arrangement rather than a
 * difference in the record.
 *
 * The states exist to make the awkward cases safe:
 *
 *   * A confirmation that arrives twice must close one bill, not two — so
 *     `paid → consumed` is a single conditional `UPDATE`, and the second attempt
 *     finds nothing to consume.
 *   * A confirmation that arrives after the cashier gave up and took cash must be
 *     recorded as money received and *not* silently attached to a sale that was
 *     paid for another way. `consume` refuses an intent whose status is not
 *     `paid`.
 *   * A QR nobody pays must stop being payable, without a cron job — `sweep`
 *     runs on read, the same lazy pattern `expiry.ts` already uses for pre-orders.
 */
import { prisma } from './db';
import { optionalNumberEnv } from './env';
import { ConflictError, NotFoundError } from './errors';
import type { Db } from './inventory';
import { fromDecimal, roundThb } from './money';
import { buildPromptPayPayload, type PromptPayIdType } from './promptpay';
import { recordAudit } from './audit';
import { loadShop } from './shop';
import type {
  AwaitingCollectionView,
  PaymentIntentStatus,
  PaymentIntentView,
} from './payment-intents-view';

export type {
  AwaitingCollectionView,
  PaymentIntentStatus,
  PaymentIntentView,
} from './payment-intents-view';

/**
 * How long a QR stays payable.
 *
 * Five minutes is a judgement about the queue, not about the network: long
 * enough that a customer who has to find their banking app is not rushed, short
 * enough that a code abandoned on the counter stops being payable before the next
 * customer reaches the till.
 */
export function intentTtlSeconds(): number {
  return optionalNumberEnv('PAYMENT_INTENT_TTL_SECONDS', 300);
}

/** Characters a reference is drawn from. No vowels, so it cannot spell a word. */
const REF_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXZ';
const REF_LENGTH = 6;

/**
 * A short, unambiguous reference.
 *
 * This ends up in the QR's reference field and gets read aloud, typed into a
 * bridge's config, or copied off a receipt — so the alphabet excludes the
 * characters people confuse when they are reading: 0/O, 1/I, and the vowels.
 */
function newRef(): string {
  let ref = '';
  for (let index = 0; index < REF_LENGTH; index += 1) {
    ref += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return ref;
}

/**
 * Issues a QR for one amount.
 *
 * The shop must have a PromptPay id: without one there is nothing to put in the
 * payload, and emitting a QR with a placeholder would send a customer's transfer
 * into somebody else's account. That is a 409 with an explanation rather than a
 * silent fallback, because the cashier needs to be told to take cash.
 */
export async function createIntent(input: {
  shiftId: number;
  cashierId: string;
  amountThb: number;
}): Promise<PaymentIntentView> {
  const shop = await loadShop();
  if (!shop?.promptpayId || !shop.promptpayType) {
    throw new ConflictError(
      'ร้านนี้ยังไม่ได้ตั้งค่าพร้อมเพย์ — ตั้งในหน้า "ตั้งค่าร้าน" ก่อนจึงจะออก QR ได้',
      'PROMPTPAY_NOT_CONFIGURED',
    );
  }

  const amountThb = roundThb(input.amountThb);
  if (amountThb <= 0) {
    throw new ConflictError('ยอดที่ออก QR ต้องมากกว่าศูนย์', 'INVALID_INTENT_AMOUNT');
  }

  const shift = await prisma.cash_shifts.findUnique({
    where: { id: input.shiftId },
    select: { id: true, status: true },
  });
  if (!shift || shift.status !== 'open') {
    throw new ConflictError(
      `Cash drawer #${input.shiftId} is not open, so a transfer could not be reconciled against it`,
      'NO_OPEN_SHIFT',
    );
  }

  const payload = buildPromptPayPayload({
    id: shop.promptpayId,
    idType: shop.promptpayType as PromptPayIdType,
    amountThb,
    reference: newRef(),
    merchantName: shop.name,
  });

  /*
   * The reference the QR carries is the one read back out of the payload, not the
   * one that was passed in: `buildPromptPayPayload` strips characters the banks'
   * readers dislike, and a stored reference that disagrees with the printed one
   * would make an incoming confirmation unmatchable.
   */
  const ref = readReference(payload);

  /*
   * `expires_at` is computed by the database, not by this process.
   *
   * This is not pedantry. The till and the database are two clocks, and every
   * comparison that matters for an intent — `expires_at > now()` when a
   * confirmation arrives, `expires_at <= now()` when one is swept — happens on the
   * database's side. Writing the deadline from JavaScript means those comparisons
   * are between a client-supplied instant and a server one, which is exactly the
   * class of bug that makes a QR expire immediately on a machine whose clock or
   * timezone disagrees with its database.
   */
  const rows = await prisma.$queryRaw<
    {
      id: bigint;
      ref: string;
      amount: unknown;
      qr_payload: string;
      status: string;
      expires_at: Date;
      paid_at: Date | null;
    }[]
  >`
    INSERT INTO "payment_intents"
      ("ref", "shift_id", "cashier_id", "amount", "qr_payload", "status", "expires_at")
    VALUES (
      ${ref}, ${input.shiftId}, ${input.cashierId}::uuid, ${amountThb}, ${payload}, 'pending',
      now() + make_interval(secs => ${intentTtlSeconds()})
    )
    RETURNING "id", "ref", "amount", "qr_payload", "status", "expires_at", "paid_at"
  `;

  const row = rows[0];
  if (!row) {
    throw new ConflictError('สร้างรายการรับเงินไม่สำเร็จ', 'INTENT_NOT_CREATED');
  }

  return toView(row);
}

/**
 * Records that the money arrived.
 *
 * Idempotent by design: the `WHERE status = 'pending'` is the whole guarantee. A
 * bridge that retries, a customer who taps "paid" twice, or two sources both
 * reporting the same transfer all land here and only the first one moves the row.
 * The caller gets the current state either way, so a duplicate is not reported to
 * the till as a failure — the money did arrive.
 */
export async function confirmIntent(input: {
  ref: string;
  /** Set for a person; null for a webhook, which has no user behind it. */
  confirmedByUserId?: string | null;
  /** A human confirmation is money authority, so it is audited; a webhook is not. */
  shiftId?: number | null;
  actorUserId?: string | null;
  authorizedByUserId?: string | null;
}): Promise<PaymentIntentView> {
  const rows = await prisma.$queryRaw<
    { id: bigint; status: PaymentIntentStatus }[]
  >`
    UPDATE "payment_intents"
       SET "status" = 'paid', "paid_at" = now(), "confirmed_by_user_id" = ${input.confirmedByUserId ?? null}::uuid
     WHERE "ref" = ${input.ref}
       AND "status" = 'pending'
       AND "expires_at" > now()
    RETURNING "id", "status"
  `;

  if (rows.length === 0) {
    // Either it was already paid, or it expired, or it never existed. The client
    // gets the real state rather than a bare 409, because "money came in for a
    // bill you already closed" is worth showing.
    const existing = await findIntent(input.ref);
    if (!existing) {
      throw new NotFoundError('ไม่พบรายการชำระเงินที่ระบุ', `Payment intent ${input.ref}`);
    }
    return existing;
  }

  const intent = await findIntent(input.ref);
  if (!intent) {
    throw new NotFoundError('ไม่พบรายการชำระเงินที่ระบุ', `Payment intent ${input.ref}`);
  }

  if (input.authorizedByUserId) {
    await recordAudit({
      action: 'manual_payment_confirm',
      actorUserId: input.actorUserId ?? null,
      authorizedByUserId: input.authorizedByUserId,
      targetType: 'payment_intent',
      targetId: intent.ref,
      shiftId: input.shiftId ?? null,
      detail: { amountThb: intent.amountThb },
    });
  }

  return intent;
}

/**
 * Attaches a paid intent to the sale that settles it, exactly once.
 *
 * Called inside `createPosSale`'s transaction, so the bill and the intent commit
 * together: there is no window in which a customer has paid and no sale exists,
 * or a sale exists and the intent is still spendable.
 *
 * The `WHERE status = 'paid'` is what makes a double submission harmless. Two
 * taps on "ยืนยันรับเงิน" produce one consumed intent and one 409, rather than two
 * completed sales for one transfer.
 */
export async function consumeIntent(
  db: Db,
  input: { ref: string; orderId: string },
): Promise<PaymentIntentView> {
  const rows = await db.$queryRaw<{ id: bigint }[]>`
    UPDATE "payment_intents"
       SET "status" = 'consumed', "consumed_at" = now(), "order_id" = ${input.orderId}::uuid
     WHERE "ref" = ${input.ref}
       AND "status" = 'paid'
    RETURNING "id"
  `;

  if (rows.length === 0) {
    const existing = await findIntent(input.ref);
    if (!existing) {
      throw new NotFoundError('ไม่พบรายการชำระเงินที่ระบุ', `Payment intent ${input.ref}`);
    }
    throw new ConflictError(
      `การชำระเงิน ${input.ref} อยู่ในสถานะ "${existing.status}" และปิดบิลซ้ำไม่ได้`,
      'INTENT_NOT_CONSUMABLE',
    );
  }

  const intent = await findIntent(input.ref);
  if (!intent) {
    throw new NotFoundError('ไม่พบรายการชำระเงินที่ระบุ', `Payment intent ${input.ref}`);
  }
  return intent;
}

/** The cashier gave up and took cash instead. */
export async function cancelIntent(input: {
  ref: string;
  actorId: string;
}): Promise<PaymentIntentView> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    UPDATE "payment_intents"
       SET "status" = 'cancelled'
     WHERE "ref" = ${input.ref}
       AND "status" = 'pending'
    RETURNING "id"
  `;

  if (rows.length === 0) {
    const existing = await findIntent(input.ref);
    if (!existing) {
      throw new NotFoundError('ไม่พบรายการชำระเงินที่ระบุ', `Payment intent ${input.ref}`);
    }
    throw new ConflictError(
      `ยกเลิกไม่ได้ เพราะรายการนี้อยู่ในสถานะ "${existing.status}"`,
      'INTENT_NOT_CANCELLABLE',
    );
  }

  const intent = await findIntent(input.ref);
  if (!intent) {
    throw new NotFoundError('ไม่พบรายการชำระเงินที่ระบุ', `Payment intent ${input.ref}`);
  }
  return intent;
}

/**
 * QR transfers that closed a bill inside a window, as a total.
 *
 * The other half of the day's reconciliation: `consumed` is the only status that
 * means a sale exists, so this is what the day's confirmed transfers are compared
 * against (`inbound-reconcile.ts`).
 */
export async function closedTransferTotals(input: {
  from: Date;
  to: Date;
}): Promise<{ count: number; amountThb: number }> {
  const rows = await prisma.$queryRaw<{ count: bigint; amount: unknown }[]>`
    SELECT COUNT(*) AS count, COALESCE(SUM("amount"), 0) AS amount
      FROM "payment_intents"
     WHERE "status" = 'consumed'
       AND "consumed_at" >= ${input.from}
       AND "consumed_at" <  ${input.to}
  `;
  const row = rows[0];
  return {
    count: row ? Number(row.count) : 0,
    amountThb: row ? fromDecimal(row.amount as never) : 0,
  };
}

/**
 * Money that arrived and closed no bill.
 *
 * A QR is confirmed within seconds of the customer paying, and consumed the moment
 * the cashier finishes the sale — so a `paid` intent that is *still* paid after
 * the code's own payable window has gone by is a sale nobody rang up. That window
 * is the threshold, rather than a number invented for this screen: if a bill did
 * not close inside the time its QR was valid, something happened that a person
 * should look at.
 *
 * Oldest first — the money that has been sitting longest is the one to chase.
 */
export async function listAwaitingCollection(
  now: Date = new Date(),
  limit = 10,
): Promise<AwaitingCollectionView[]> {
  const cutoff = new Date(now.getTime() - intentTtlSeconds() * 1000);

  const rows = await prisma.payment_intents.findMany({
    where: { status: 'paid', order_id: null, paid_at: { lt: cutoff } },
    orderBy: { paid_at: 'asc' },
    take: limit,
    select: {
      ref: true,
      amount: true,
      paid_at: true,
      cashier: { select: { full_name: true } },
    },
  });

  return rows.map((row) => {
    const paidAt = row.paid_at ?? now;
    return {
      ref: row.ref,
      amountThb: fromDecimal(row.amount),
      paidAt: paidAt.toISOString(),
      cashierName: row.cashier?.full_name ?? null,
      waitingMinutes: Math.max(0, Math.floor((now.getTime() - paidAt.getTime()) / 60_000)),
    };
  });
}

/** One intent by reference, swept for expiry first. */
export async function findIntent(ref: string): Promise<PaymentIntentView | null> {
  await sweepExpiredIntents();
  const row = await prisma.payment_intents.findUnique({ where: { ref } });
  return row ? toView(row) : null;
}

/**
 * Closes the QRs nobody paid.
 *
 * Runs on read rather than on a timer, the same pattern `expiry.ts` uses for
 * unconfirmed pre-orders: the app already refuses to start a background scheduler
 * in a serverless deployment, and a lazy sweep is correct whether there is one
 * process or five. It is idempotent, and cheap when there is nothing to do.
 */
export async function sweepExpiredIntents(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    UPDATE "payment_intents"
       SET "status" = 'expired'
     WHERE "status" = 'pending'
       AND "expires_at" <= now()
    RETURNING "id"
  `;
  return rows.length;
}

/**
 * The reference out of a built payload.
 *
 * Read back rather than trusted, because the builder sanitises: a reference
 * stored raw could differ from the one on the customer's screen, and matching a
 * confirmation is the only job it has. A TLV walk rather than one clever regex —
 * the payload is full of two-digit numbers, and a pattern loose enough to match
 * `62` anywhere also matches inside the CRC or an amount.
 */
function readReference(payload: string): string {
  const additional = readTlv(payload, '62');
  const reference = additional === null ? null : readTlv(additional, '01');
  if (reference !== null && reference.length > 0 && reference.length <= 12) {
    return reference;
  }
  /*
   * Not reachable while the builder always writes a reference. A distinct value
   * rather than an empty one: the column is unique, so two fallbacks would collide
   * and surface as a 500 instead of a clear failure.
   */
  return `X${Date.now().toString(36).toUpperCase().slice(-11)}`;
}

/** The value of one top-level TLV field, or null when it is not present. */
function readTlv(payload: string, wanted: string): string | null {
  let index = 0;
  while (index + 4 <= payload.length) {
    const id = payload.slice(index, index + 2);
    const length = Number(payload.slice(index + 2, index + 4));
    if (!Number.isFinite(length)) {
      return null;
    }
    const value = payload.slice(index + 4, index + 4 + length);
    if (id === wanted) {
      return value;
    }
    index += 4 + length;
  }
  return null;
}

function toView(row: {
  id: bigint;
  ref: string;
  amount: unknown;
  qr_payload: string;
  status: string;
  expires_at: Date;
  paid_at: Date | null;
}): PaymentIntentView {
  return {
    id: row.id.toString(),
    ref: row.ref,
    amountThb: fromDecimal(row.amount as never),
    qrPayload: row.qr_payload,
    status: row.status as PaymentIntentStatus,
    expiresAt: row.expires_at.toISOString(),
    paidAt: row.paid_at?.toISOString() ?? null,
  };
}
