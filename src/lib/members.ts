/**
 * Customer accounts.
 *
 * This is the missing half of the pre-order feature, and until now the last thing
 * standing between a freshly installed shop and its own product: the SRS assumes
 * members exist, `POST /api/v1/orders` requires one for a pre-order, and
 * `requireRole(['member'])` gates the whole `/shop` area — but nothing anywhere
 * created one. A renter's only customer was the one a developer inserted with SQL.
 *
 * **A member is a credential, and that is why this is not a plain address book.**
 * A customer account can reserve stock without paying for it, which is the one
 * capability in this system that is worth inventing an identity to get. So
 * creating one is audited, its phone number is unique across *every* role (a
 * cashier whose number was reused could no longer sign in), and the role is never
 * taken from the request.
 *
 * What this deliberately does not do, in the same spirit as `staff.ts`: no
 * self-sign-up, no invitation by SMS, and no points editing. A shop's customers
 * are created at the counter by somebody who has seen them, and loyalty points are
 * a ledger with its own rules — a screen that let an admin type a balance would be
 * a screen that can invent money in the form of a liability.
 */
import { recordAudit } from './audit';
import { prisma } from './db';
import { ConflictError, NotFoundError } from './errors';
import { assertPassword, hashPassword } from './password';
import { normalisePhone } from './phone';

import type { Prisma } from '../generated/prisma/client';

/** The row shape every read here maps from, including the order tally. */
type MemberRow = Prisma.usersGetPayload<{
  include: { _count: { select: { orders_as_customer: true } } };
}>;

const MEMBER_INCLUDE = { _count: { select: { orders_as_customer: true } } } as const;

/**
 * The unique index on `users.phone` spans every role, so the collision this
 * translates is not always another customer.
 *
 * One message covers both, because the caller can act on the same thing either
 * way — pick a different number — and which role already owns it is not theirs to
 * learn from an error string. Declared `never` so a caller can let it end a catch
 * block and still satisfy the compiler that every path returns.
 */
function throwDuplicatedAccount(
  error: unknown,
  phone: string,
  email: string | null,
): never {
  if (isUniqueViolation(error)) {
    throw new ConflictError(
      `มีบัญชีที่ใช้ ${phone}${email ? ` หรือ ${email}` : ''} อยู่แล้ว — ลองใช้เบอร์อื่น`,
      'DUPLICATE_ACCOUNT',
    );
  }
  throw error;
}

export interface Member {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  isActive: boolean;
  /** Read-only here: the ledger owns it. */
  pointsBalance: number;
  /** How many orders this account has ever placed, sold or not. */
  orderCount: number;
  /** ISO instant. */
  joinedAt: string;
}

export interface CreateMemberInput {
  fullName: string;
  phone: string;
  email?: string | null;
  password: string;
  /** The person adding them, when there is one on the request. */
  actorId?: string | null;
}

export interface UpdateMemberInput {
  id: string;
  actorId?: string | null;
  fullName?: string;
  phone?: string;
  email?: string | null;
  isActive?: boolean;
  /** Omitted leaves the existing password alone. */
  password?: string;
}

/** Everyone this shop serves, for the customer screen. */
export async function listMembers(): Promise<Member[]> {
  const users = await prisma.users.findMany({
    where: { role: 'member' },
    orderBy: { full_name: 'asc' },
    include: MEMBER_INCLUDE,
  });

  return users.map((user) => toMember(user, user._count.orders_as_customer));
}

/**
 * Creates one customer account.
 *
 * The password is handed over at the counter and typed by the cashier, which is
 * the same shape as the staff screen and the only one that works in a shop with no
 * email address on file and no customer app to invite anybody from. It is a
 * *temporary* credential in intent: the customer can change it themselves from
 * their own profile screen once they are signed in.
 */
export async function createMember(input: CreateMemberInput): Promise<Member> {
  assertPassword(input.password);
  const phone = normalisePhone(input.phone);
  const email = blankToNull(input.email);

  let created: MemberRow;
  try {
    created = await prisma.users.create({
      data: {
        full_name: input.fullName.trim(),
        phone,
        email,
        password_hash: await hashPassword(input.password),
        // Never from the request: this endpoint makes customers, and there is no
        // shape of a request to it that should produce a cashier.
        role: 'member',
        is_active: true,
      },
      include: MEMBER_INCLUDE,
    });
  } catch (error) {
    throwDuplicatedAccount(error, phone, email);
  }

  await recordAudit({
    action: 'member_created',
    actorUserId: input.actorId ?? null,
    targetType: 'user',
    targetId: created.id,
    detail: { phone },
  });

  return toMember(created, created._count.orders_as_customer);
}

/**
 * Edits a customer account.
 *
 * Two refusals carry the weight. An account that is not a member cannot be touched
 * here — the mirror of `updateStaff`'s own refusal, and without it this screen
 * would be a way to rename a cashier or reset their password. And a phone number
 * already in use cannot be taken, because uniqueness spans every role.
 */
export async function updateMember(input: UpdateMemberInput): Promise<Member> {
  const existing = await prisma.users.findUnique({ where: { id: input.id } });
  if (!existing) {
    throw new NotFoundError('ไม่พบลูกค้าที่ระบุ', `Customer ${input.id}`);
  }
  if (existing.role !== 'member') {
    throw new ConflictError(
      'This account belongs to staff; manage it from the staff screen',
      'NOT_A_MEMBER_ACCOUNT',
    );
  }

  if (input.password !== undefined) {
    assertPassword(input.password);
  }

  const nextPhone = input.phone === undefined ? existing.phone : normalisePhone(input.phone);
  const nextEmail = input.email === undefined ? existing.email : blankToNull(input.email);
  const nextIsActive = input.isActive ?? existing.is_active;

  /*
   * What changed about how this account signs in, and the only thing this edit is
   * ever written down for. A rename is deliberately absent: the trail's value is in
   * being *narrow*, and a corrected spelling is not an event a later reader needs to
   * find. A phone number and an email address are, because both are identifiers
   * somebody signs in with; so is a closed account.
   */
  const audited: string[] = [];
  if (nextPhone !== existing.phone) {
    audited.push('phone');
  }
  if (nextEmail !== existing.email) {
    audited.push('email');
  }
  if (nextIsActive !== existing.is_active) {
    audited.push('active');
  }
  if (input.password !== undefined) {
    audited.push('password');
  }

  const unchanged =
    input.fullName === undefined &&
    input.phone === undefined &&
    input.email === undefined &&
    input.isActive === undefined &&
    input.password === undefined;

  /*
   * Nothing sent is not a write. Returning the row rather than issuing an empty
   * UPDATE keeps the audit rule below honest: there is no such thing as an edit
   * that changed nothing, so there is no such thing as a trail row for one.
   */
  if (unchanged) {
    const current = await prisma.users.findUniqueOrThrow({
      where: { id: existing.id },
      include: MEMBER_INCLUDE,
    });
    return toMember(current, current._count.orders_as_customer);
  }

  let updated: MemberRow;
  try {
    updated = await prisma.users.update({
      where: { id: existing.id },
      data: {
        ...(input.fullName === undefined ? {} : { full_name: input.fullName.trim() }),
        phone: nextPhone,
        email: nextEmail,
        is_active: nextIsActive,
        ...(input.password === undefined
          ? {}
          : { password_hash: await hashPassword(input.password) }),
      },
      include: MEMBER_INCLUDE,
    });
  } catch (error) {
    throwDuplicatedAccount(error, nextPhone, nextEmail);
  }

  if (audited.length > 0) {
    await recordAudit({
      action: 'member_updated',
      actorUserId: input.actorId ?? null,
      targetType: 'user',
      targetId: existing.id,
      detail: {
        fields: audited,
        /*
         * The one previous value worth keeping: a phone number is what a cashier
         * writes on a receipt and searches by when a customer comes back, so "this
         * account used to be that number" explains a search that stopped working.
         */
        ...(audited.includes('phone') ? { previousPhone: existing.phone } : {}),
      },
    });
  }

  return toMember(updated, updated._count.orders_as_customer);
}

function toMember(
  user: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
    is_active: boolean;
    points_balance: number;
    created_at: Date;
  },
  orderCount: number,
): Member {
  return {
    id: user.id,
    fullName: user.full_name,
    phone: user.phone,
    email: user.email,
    isActive: user.is_active,
    pointsBalance: user.points_balance,
    orderCount,
    joinedAt: user.created_at.toISOString(),
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}
