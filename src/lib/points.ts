/**
 * Loyalty point ledger — SRS §5.1.
 *
 * Every change to a balance writes a row carrying `balance_after`, and the
 * balance itself is only ever moved by a single conditional UPDATE. Recomputing
 * a balance by summing the ledger would drift under concurrency; keeping the
 * ledger as an append-only audit trail alongside the authoritative counter is
 * what makes the two verifiable against each other.
 */
import { ConflictError } from './errors';
import type { Db } from './inventory';

/**
 * Applies a signed point change and appends the ledger row.
 *
 * Returns the balance after the change. A change that would drive the balance
 * negative is rejected rather than clamped, because a negative balance means a
 * redemption was approved against points that no longer exist.
 */
export async function applyPointChange(
  db: Db,
  input: {
    userId: string;
    delta: number;
    orderId?: string | null;
    description: string;
  },
): Promise<number> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new ConflictError('A point change must be a non-zero whole number', 'POINTS_NOOP');
  }

  const rows = await db.$queryRaw<{ points_balance: number }[]>`
    UPDATE "users"
       SET "points_balance" = "points_balance" + ${input.delta},
           "updated_at"     = NOW()
     WHERE "id" = ${input.userId}::uuid
       AND "points_balance" + ${input.delta} >= 0
    RETURNING "points_balance"
  `;

  const updated = rows[0];
  if (!updated) {
    throw new ConflictError(
      `Cannot apply a ${input.delta} point change: the customer does not exist or ` +
        'the balance would become negative',
      'INSUFFICIENT_POINTS',
    );
  }

  await db.point_transactions.create({
    data: {
      user_id: input.userId,
      order_id: input.orderId ?? null,
      points_change: input.delta,
      balance_after: updated.points_balance,
      description: input.description,
    },
  });

  return updated.points_balance;
}

/** Current point balance, or null when the user does not exist. */
export async function readPointBalance(db: Db, userId: string): Promise<number | null> {
  const user = await db.users.findUnique({
    where: { id: userId },
    select: { points_balance: true },
  });
  return user?.points_balance ?? null;
}
