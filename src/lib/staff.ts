/**
 * Staff accounts.
 *
 * The SRS assumes users exist and only ever describes what they may do — nothing
 * in it says how a shop creates a cashier. Until now the only way was the seed
 * file, so a renter could not open a till without a developer. This module is
 * that missing surface.
 *
 * One invariant deserves its own paragraph. **A shop must never be able to lock
 * itself out of its own administration.** Deactivating or demoting the last
 * active admin leaves a system nobody can configure, with no support desk to
 * call. `assertNotLastAdmin` enforces it inside the caller's transaction under a
 * transaction-scoped advisory lock, because two concurrent "deactivate the other
 * admin" requests would each observe a surviving admin and both succeed.
 */
import { prisma } from './db';
import { ConflictError, NotFoundError } from './errors';
import type { Db } from './inventory';
import { assertPassword, hashPassword } from './password';
import { normalisePhone } from './phone';
import type { Role } from './roles';

/** Roles this surface manages. Members are customers, not staff. */
export const STAFF_ROLES: readonly Role[] = ['employee', 'admin'];

export interface StaffMember {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: Role;
  isActive: boolean;
}

export interface CreateStaffInput {
  fullName: string;
  phone: string;
  email?: string | null;
  role: Role;
  password: string;
}

export interface UpdateStaffInput {
  id: string;
  /** The person making the change, so they cannot demote themselves. */
  actorId: string;
  fullName?: string;
  phone?: string;
  email?: string | null;
  role?: Role;
  isActive?: boolean;
  /** Omitted leaves the existing password alone. */
  password?: string;
}

const TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 30_000 } as const;

/** Everyone who can operate the shop, for the staff screen. */
export async function listStaff(): Promise<StaffMember[]> {
  const users = await prisma.users.findMany({
    where: { role: { in: [...STAFF_ROLES] } },
    orderBy: [{ role: 'asc' }, { full_name: 'asc' }],
  });
  return users.map(toStaffMember);
}

/**
 * Creates one staff account.
 *
 * The role is passed in rather than inferred: the setup wizard makes the first
 * admin, and the staff screen makes cashiers.
 */
export async function createStaff(input: CreateStaffInput): Promise<StaffMember> {
  assertPassword(input.password);
  const phone = normalisePhone(input.phone);
  const email = blankToNull(input.email);

  try {
    const user = await prisma.users.create({
      data: {
        full_name: input.fullName.trim(),
        phone,
        email,
        password_hash: await hashPassword(input.password),
        role: input.role,
        is_active: true,
      },
    });
    return toStaffMember(user);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `An account already exists for ${phone}${email ? ` or ${email}` : ''}`,
        'DUPLICATE_ACCOUNT',
      );
    }
    throw error;
  }
}

/** Edits a staff account, optionally resetting its password. */
export async function updateStaff(input: UpdateStaffInput): Promise<StaffMember> {
  const existing = await prisma.users.findUnique({ where: { id: input.id } });
  if (!existing) {
    throw new NotFoundError(`Staff member ${input.id}`);
  }
  if (existing.role === 'member') {
    throw new ConflictError(
      'This account belongs to a customer; manage it from the customer screen',
      'NOT_A_STAFF_ACCOUNT',
    );
  }

  const nextRole = input.role ?? (existing.role as Role);
  const nextIsActive = input.isActive ?? existing.is_active;

  /*
   * Changing your own role or deactivating yourself is refused outright rather
   * than left to the last-admin check: a manager who demotes themselves has
   * removed their own ability to undo it, and that is a mistake worth blocking
   * even when another admin exists.
   */
  if (input.actorId === existing.id && (nextRole !== 'admin' || !nextIsActive)) {
    throw new ConflictError(
      'You cannot demote or deactivate your own account — ask another administrator',
      'SELF_DEMOTION',
    );
  }

  if (input.password !== undefined) {
    assertPassword(input.password);
  }

  return prisma.$transaction(async (tx) => {
    /*
     * Taken before the count is read, so a concurrent demotion cannot slip
     * through between the check and the write.
     *
     * The wrapper is not decoration: `pg_advisory_xact_lock` returns `void`, and
     * Prisma cannot deserialize a `void` column — asking for it directly fails
     * with "Failed to deserialize column of type 'void'". Selecting a literal
     * from the locked CTE keeps the call inside one statement while giving the
     * reader a type it understands.
     */
    await tx.$queryRaw`
      WITH lock AS (SELECT pg_advisory_xact_lock(hashtext('pos:staff-admin-invariant')))
      SELECT true AS locked FROM lock
    `;

    await assertNotLastAdmin(
      tx,
      { id: existing.id, role: existing.role as Role, isActive: existing.is_active },
      { role: nextRole, isActive: nextIsActive },
    );

    if (!nextIsActive) {
      await assertNothingDangling(tx, existing.id);
    }

    const updated = await tx.users.update({
      where: { id: existing.id },
      data: {
        ...(input.fullName === undefined ? {} : { full_name: input.fullName.trim() }),
        ...(input.phone === undefined ? {} : { phone: normalisePhone(input.phone) }),
        ...(input.email === undefined ? {} : { email: blankToNull(input.email) }),
        role: nextRole,
        is_active: nextIsActive,
        ...(input.password === undefined
          ? {}
          : { password_hash: await hashPassword(input.password) }),
      },
    });

    return toStaffMember(updated);
  }, TRANSACTION_OPTIONS);
}

/**
 * Refuses to remove the last way into the admin area.
 *
 * Only a transition that *stops* being an active admin is interesting; anything
 * else passes without a query.
 */
async function assertNotLastAdmin(
  db: Db,
  target: { id: string; role: Role; isActive: boolean },
  next: { role: Role; isActive: boolean },
): Promise<void> {
  const wasActiveAdmin = target.role === 'admin' && target.isActive;
  const staysActiveAdmin = next.role === 'admin' && next.isActive;

  if (!wasActiveAdmin || staysActiveAdmin) {
    return;
  }

  const others = await db.users.count({
    where: { role: 'admin', is_active: true, id: { not: target.id } },
  });

  if (others === 0) {
    throw new ConflictError(
      'This is the only active administrator. Promote someone else first, or you will ' +
        'lock the shop out of its own settings.',
      'LAST_ADMIN',
    );
  }
}

/**
 * A deactivated person must not leave live state behind.
 *
 * Their session stops working the moment `is_active` is false, so an open
 * timesheet would become impossible to close and an open cash drawer would be
 * stranded mid-shift — both are states the shop would have to fix in SQL.
 */
async function assertNothingDangling(db: Db, userId: string): Promise<void> {
  const openLog = await db.time_logs.findFirst({
    where: { employee_id: userId, check_out: null },
    select: { id: true },
  });
  if (openLog) {
    throw new ConflictError(
      'This person is still clocked in. Close their timesheet before deactivating them.',
      'STAFF_STILL_CLOCKED_IN',
    );
  }

  const openShift = await db.cash_shifts.findFirst({
    where: { opened_by: userId, status: 'open' },
    select: { id: true },
  });
  if (openShift) {
    throw new ConflictError(
      'This person has an open cash drawer. Close the shift before deactivating them.',
      'STAFF_HAS_OPEN_SHIFT',
    );
  }
}

export function toStaffMember(user: {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  role: string;
  is_active: boolean;
}): StaffMember {
  return {
    id: user.id,
    fullName: user.full_name,
    phone: user.phone,
    email: user.email,
    role: user.role as Role,
    isActive: user.is_active,
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}
