/**
 * The audit trail.
 *
 * Money and authority leave a record here: who was at the till, whose PIN
 * approved it, what it cost, and when. Every other table in this schema is
 * mutable; this one is not, and the migration enforces that with a trigger that
 * refuses UPDATE and DELETE. The value of a trail is entirely in whether it can
 * still be trusted a year later, which is not a property that can be agreed in
 * code review.
 *
 * **Two people can be named on one row, and that is the point.**
 * `actorUserId` is who was standing at the counter — usually a cashier.
 * `authorizedByUserId` is whose PIN let it through — usually an admin. "Who was
 * at the keyboard" and "who allowed this" are different questions, and a trail
 * that can only answer one of them is the kind that gets ignored mid-investigation.
 * When an owner is alone in the shop those two ids are equal, which is a fact
 * about the shift rather than a gap in the record.
 *
 * Rows are only ever inserted. There is deliberately no update or delete helper
 * here, so an append-only table is not one mistaken `prisma.audit_logs.update`
 * away from being an ordinary table.
 */
import type { Prisma, audit_action } from '../generated/prisma/client';

import { prisma } from './db';
import type { Db } from './inventory';
import { AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE_MAX } from './audit-view';
import type { AuditAction, AuditActor, AuditRow } from './audit-view';

export type { AuditAction } from './audit-view';
export { AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE_MAX } from './audit-view';

export interface AuditEntry {
  action: AuditAction;
  /** The signed-in user who performed the action. */
  actorUserId?: string | null;
  /** The supervisor whose PIN authorised it, when one was needed. */
  authorizedByUserId?: string | null;
  /** `order`, `payment_intent`, `user`, `display_device`… */
  targetType?: string | null;
  targetId?: string | null;
  shiftId?: number | null;
  /**
   * Whatever a later reader will need and cannot derive: the amount, the limit
   * that was exceeded, the previous value, the reason given.
   */
  detail?: Prisma.InputJsonValue | null;
}

/**
 * Appends one row.
 *
 * Takes a `db` so it can join the caller's transaction. That matters: an audit
 * row written outside the transaction that performed the action can survive a
 * rollback, and then the trail describes something that never happened — worse
 * than no trail at all.
 */
export async function recordAudit(entry: AuditEntry, db: Db = prisma): Promise<void> {
  await db.audit_logs.create({
    data: {
      action: entry.action,
      actor_user_id: entry.actorUserId ?? null,
      authorized_by_user_id: entry.authorizedByUserId ?? null,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      shift_id: entry.shiftId ?? null,
      // Omitted rather than set to a null cast: Prisma distinguishes "no detail"
      // from an explicit JSON `null`, and only the first one omits the column.
      ...(entry.detail === undefined || entry.detail === null ? {} : { detail: entry.detail }),
    },
  });
}

export interface AuditQuery {
  action?: AuditAction;
  /** Rows involving this user, on either side of the approval. */
  userId?: string;
  limit?: number;
  /** Rows strictly older than this id — the trail is read newest-first. */
  beforeId?: string;
}

/**
 * The trail, newest first, with the people resolved to names.
 *
 * Reads `actor` and `authorized_by` in the same query rather than a second pass,
 * because the screen shows a name on every row and a page of fifty would
 * otherwise be fifty more round trips.
 */
export async function listAuditLogs(query: AuditQuery = {}): Promise<AuditRow[]> {
  const limit = clampLimit(query.limit);

  const rows = await prisma.audit_logs.findMany({
    where: {
      ...(query.action ? { action: query.action } : {}),
      ...(query.userId
        ? {
            OR: [{ actor_user_id: query.userId }, { authorized_by_user_id: query.userId }],
          }
        : {}),
      // Keyset paging rather than an offset: the trail grows while it is being
      // read, and a new row arriving must not shove an older one onto page two.
      ...(query.beforeId ? { id: { lt: BigInt(query.beforeId) } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit,
    include: {
      actor: { select: { id: true, full_name: true } },
      authorized_by: { select: { id: true, full_name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id.toString(),
    action: row.action as AuditAction,
    actor: toActor(row.actor),
    authorizedBy: toActor(row.authorized_by),
    targetType: row.target_type,
    targetId: row.target_id,
    shiftId: row.shift_id,
    detail: asDetail(row.detail),
    createdAt: row.created_at.toISOString(),
  }));
}

/** How many rows the trail holds in total, for the screen's own count. */
export async function countAuditLogs(query: AuditQuery = {}): Promise<number> {
  return prisma.audit_logs.count({
    where: {
      ...(query.action ? { action: query.action } : {}),
      ...(query.userId
        ? {
            OR: [{ actor_user_id: query.userId }, { authorized_by_user_id: query.userId }],
          }
        : {}),
    },
  });
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return AUDIT_PAGE_SIZE;
  }
  return Math.min(Math.floor(limit), AUDIT_PAGE_SIZE_MAX);
}

function toActor(user: { id: string; full_name: string } | null): AuditActor | null {
  return user ? { id: user.id, fullName: user.full_name } : null;
}

/** `detail` is JSONB: an object, an array, a scalar, or absent. */
function asDetail(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Re-exported so callers can name the enum's type without a second import. */
export type AuditActionEnum = audit_action;
