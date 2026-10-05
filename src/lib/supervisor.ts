/**
 * Supervisor approval.
 *
 * Four till actions are not a cashier's to take alone: voiding a bill,
 * discounting past the shop's limit, opening the drawer with no sale behind it,
 * and confirming a transfer by hand. The reference design gates those with a
 * 4-digit supervisor PIN, and the shape is right — the alternatives are worse in
 * ways that matter. Signing the till out to fetch a manager loses the basket;
 * letting every cashier void freely means the first person to notice a shortage
 * is the owner, months later, with no way to tell who did what.
 *
 * How one approval flows, end to end:
 *
 *   1. The cashier attempts a gated action. The server refuses it: no approval
 *      header, no action.
 *   2. The till opens `SupervisorApprovalDialog`, which posts the supervisor's
 *      PIN to `/api/v1/pos/approvals`.
 *   3. `verifySupervisorPin` checks it against that admin's hash, counting
 *      failures and locking the PIN after five of them.
 *   4. The endpoint returns a short-lived signed token — bound to the action, to
 *      the target and to the cashier who asked, so it cannot be reused for a
 *      different void, a bigger discount, or by anybody else.
 *   5. The till retries the original request with `X-Supervisor-Token`. The
 *      gated route calls `requireApproval`, which verifies the binding.
 *   6. The action writes its own audit row naming *both* people: the cashier who
 *      pressed the button and the supervisor whose PIN allowed it.
 *
 * Two things this deliberately does not do. It does not write an audit row for
 * an approval that was granted but never used — a token is a means, not an
 * event, and a trail padded with them buries the events. And it does not log
 * each individual wrong PIN, only the one that trips the lock: otherwise the
 * trail is exactly where an attacker gets to write, at volume, for free.
 */
import { SignJWT, jwtVerify } from 'jose';

import { bangkokTimeString } from './bangkok-time';
import {
  ApprovalRejectedError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from './errors';
import { authSecretKey } from './session-token';
import type { SessionUser } from './session-token';
import { requireRole } from './auth';
import { recordAudit } from './audit';
import { prisma } from './db';
import { hashPassword, verifyPassword } from './password';
import {
  APPROVAL_HEADER,
  APPROVAL_TTL_SECONDS,
  MAX_PIN_ATTEMPTS,
  PIN_LOCK_MINUTES,
  SUPERVISOR_ACTION_LABELS,
  pinProblem,
  type SupervisorAction,
  type SupervisorOption,
  type SupervisorStatus,
} from './supervisor-view';

export type { SupervisorAction } from './supervisor-view';

/**
 * The token's own issuer and audience.
 *
 * Distinct from a session token's, so an approval can never be presented as a
 * session or the other way round even though both are HS256 under the same
 * secret. Verifying an audience is the cheap half of key hygiene.
 */
const APPROVAL_ISSUER = 'pos-realtime-approval';
const APPROVAL_AUDIENCE = 'pos:supervisor-approval';

/** Raised when an approval token is absent, expired, or bound to something else. */
class InvalidApprovalError extends Error {
  constructor(message = 'Invalid or expired approval') {
    super(message);
    this.name = 'InvalidApprovalError';
  }
}

export interface ApprovalGrant {
  token: string;
  expiresAt: string;
  actionLabel: string;
  /** For the dialog's confirmation line: "ให้ส่วนลด … · อนุมัติโดย …". */
  approverName: string;
}

export interface ApprovalClaims {
  /** The cashier the approval was granted to. */
  actorId: string;
  supervisorId: string;
  action: SupervisorAction;
  targetId: string;
}

export type PinCheck =
  | { ok: true; supervisorId: string }
  | { ok: false; reason: 'wrong'; attemptsRemaining: number }
  | { ok: false; reason: 'locked'; lockedUntil: string };

interface PinHolderRow {
  id: string;
  role: string;
  full_name: string;
  is_active: boolean;
  pin_hash: string | null;
  pin_failed_attempts: number;
  pin_locked_until: Date | null;
}

// ---------------------------------------------------------------- the PIN

/**
 * Gives someone a supervisor PIN, or replaces the one they have.
 *
 * Admin-only, and enforced here rather than only at the route: a PIN is the
 * ability to approve your own voids, so handing one to an employee would be
 * handing them the rule the rule exists to keep.
 */
export async function setSupervisorPin(input: {
  userId: string;
  pin: string;
  /** Who is setting it — the admin themselves, or another admin resetting it. */
  actorId: string;
}): Promise<SupervisorStatus> {
  const problem = pinProblem(input.pin);
  if (problem) {
    throw new ValidationError(problem);
  }

  const target = await loadPinHolder(input.userId);
  if (target.role !== 'admin') {
    throw new ValidationError(
      'เฉพาะผู้ดูแลระบบเท่านั้นที่ตั้ง PIN ผู้ดูแลได้ เพราะการอนุมัติทำได้เฉพาะผู้ดูแลระบบ',
    );
  }

  const pinHash = await hashPassword(input.pin);
  const wasSet = target.pin_hash !== null;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.users.update({
      where: { id: input.userId },
      data: { pin_hash: pinHash, pin_failed_attempts: 0, pin_locked_until: null },
      select: { pin_locked_until: true },
    });

    await recordAudit(
      {
        action: wasSet ? 'pin_reset' : 'pin_set',
        actorUserId: input.actorId,
        targetType: 'user',
        targetId: input.userId,
        detail: { subject: target.full_name, bySelf: input.actorId === input.userId },
      },
      tx,
    );

    return { hasPin: true, lockedUntil: updated.pin_locked_until?.toISOString() ?? null };
  });
}

/** Removes a PIN, so the account can no longer approve anything. */
export async function clearSupervisorPin(input: {
  userId: string;
  actorId: string;
}): Promise<SupervisorStatus> {
  const target = await loadPinHolder(input.userId);

  return prisma.$transaction(async (tx) => {
    await tx.users.update({
      where: { id: input.userId },
      data: { pin_hash: null, pin_failed_attempts: 0, pin_locked_until: null },
    });

    await recordAudit(
      {
        action: 'pin_reset',
        actorUserId: input.actorId,
        targetType: 'user',
        targetId: input.userId,
        detail: { subject: target.full_name, cleared: true },
      },
      tx,
    );

    return { hasPin: false, lockedUntil: null };
  });
}

/** Whether this account holds a PIN, and whether it is currently locked. */
export async function supervisorStatus(userId: string): Promise<SupervisorStatus> {
  const user = await loadPinHolder(userId);
  return {
    hasPin: user.pin_hash !== null,
    lockedUntil: user.pin_locked_until?.toISOString() ?? null,
  };
}

/**
 * The admins who can approve, for the dialog's picker.
 *
 * Active admins who have set a PIN, and nothing else — no email, no phone, no
 * count of past approvals. The cashier needs a name to pick and the PIN to go
 * with it, and that is all this answers.
 */
export async function listSupervisors(): Promise<SupervisorOption[]> {
  const admins = await prisma.users.findMany({
    where: { role: 'admin', is_active: true, pin_hash: { not: null } },
    select: { id: true, full_name: true },
    orderBy: { full_name: 'asc' },
  });

  return admins.map((admin) => ({ id: admin.id, fullName: admin.full_name }));
}

/**
 * Checks a PIN against one supervisor.
 *
 * The failure counter is incremented in a single conditional `UPDATE`, the same
 * way stock is moved elsewhere in this codebase: reading the count and writing
 * it back would let two simultaneous guesses both see `4` and both record the
 * fifth, which is exactly the case a lockout exists for.
 *
 * The lock resets the counter rather than leaving it at the limit, so that when
 * five minutes elapse the holder gets five fresh attempts. Leaving it at `5`
 * would mean every later attempt re-locks immediately, and the PIN would be
 * permanently unusable without an admin reset.
 */
export async function verifySupervisorPin(input: {
  supervisorId: string;
  pin: string;
}): Promise<PinCheck> {
  const holder = await loadPinHolder(input.supervisorId);

  if (holder.pin_hash === null) {
    throw new ConflictError(
      `${holder.full_name} ยังไม่ได้ตั้ง PIN ผู้ดูแล`,
      'NO_SUPERVISOR_PIN',
    );
  }

  const now = new Date();
  if (holder.pin_locked_until !== null && holder.pin_locked_until > now) {
    return { ok: false, reason: 'locked', lockedUntil: holder.pin_locked_until.toISOString() };
  }

  if (await verifyPassword(input.pin, holder.pin_hash)) {
    if (holder.pin_failed_attempts > 0 || holder.pin_locked_until !== null) {
      await prisma.users.update({
        where: { id: holder.id },
        data: { pin_failed_attempts: 0, pin_locked_until: null },
      });
    }
    return { ok: true, supervisorId: holder.id };
  }

  const rows = await prisma.$queryRaw<{ pin_failed_attempts: number; pin_locked_until: Date | null }[]>`
    UPDATE "users"
       SET "pin_failed_attempts" = CASE
             WHEN "pin_failed_attempts" + 1 >= ${MAX_PIN_ATTEMPTS} THEN 0
             ELSE "pin_failed_attempts" + 1
           END,
           "pin_locked_until" = CASE
             WHEN "pin_failed_attempts" + 1 >= ${MAX_PIN_ATTEMPTS}
               THEN now() + make_interval(mins => ${PIN_LOCK_MINUTES})
             ELSE NULL
           END
     WHERE "id" = ${input.supervisorId}::uuid
    RETURNING "pin_failed_attempts", "pin_locked_until"
  `;

  const updated = rows[0];
  if (updated?.pin_locked_until && updated.pin_locked_until > now) {
    await recordAudit({
      action: 'pin_locked',
      actorUserId: holder.id,
      targetType: 'user',
      targetId: holder.id,
      detail: { attempts: MAX_PIN_ATTEMPTS, minutes: PIN_LOCK_MINUTES },
    });
    return { ok: false, reason: 'locked', lockedUntil: updated.pin_locked_until.toISOString() };
  }

  return {
    ok: false,
    reason: 'wrong',
    attemptsRemaining: Math.max(0, MAX_PIN_ATTEMPTS - (updated?.pin_failed_attempts ?? 0)),
  };
}

// ---------------------------------------------------------------- the token

/**
 * Mints the approval the till retries with.
 *
 * Three bindings, and every one of them closes a hole: the action (so an
 * approved discount cannot be spent on a void), the target (so an approved
 * ฿60 discount cannot be spent on a ฿600 one), and the subject (so the approval
 * cannot be handed to the till next door).
 */
export async function issueApprovalToken(input: {
  actorId: string;
  supervisorId: string;
  action: SupervisorAction;
  targetId: string;
}): Promise<{ token: string; expiresAt: string; actionLabel: string }> {
  const token = await new SignJWT({
    act: input.action,
    tid: input.targetId,
    by: input.supervisorId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.actorId)
    .setIssuedAt()
    .setIssuer(APPROVAL_ISSUER)
    .setAudience(APPROVAL_AUDIENCE)
    .setExpirationTime(`${APPROVAL_TTL_SECONDS}s`)
    .sign(authSecretKey());

  return {
    token,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_SECONDS * 1000).toISOString(),
    actionLabel: SUPERVISOR_ACTION_LABELS[input.action],
  };
}

/**
 * Verifies a supervisor's PIN and, if it holds, mints the approval.
 *
 * The one entry point for the approval endpoint. Folding the two steps together
 * is deliberate: an endpoint that could issue a token without checking a PIN
 * would be one refactor away from doing exactly that.
 */
export async function requestApproval(input: {
  actorId: string;
  supervisorId: string;
  pin: string;
  action: SupervisorAction;
  targetId: string;
}): Promise<ApprovalGrant> {
  const check = await verifySupervisorPin({
    supervisorId: input.supervisorId,
    pin: input.pin,
  });

  if (!check.ok) {
    if (check.reason === 'locked') {
      throw new ApprovalRejectedError(
        `PIN ถูกล็อกชั่วคราว ลองใหม่ได้หลัง ${bangkokTimeString(new Date(check.lockedUntil))}`,
        'PIN_LOCKED',
        { reason: 'locked', lockedUntil: check.lockedUntil },
      );
    }
    throw new ApprovalRejectedError(
      check.attemptsRemaining === 0
        ? 'PIN ไม่ถูกต้อง'
        : `PIN ไม่ถูกต้อง เหลืออีก ${check.attemptsRemaining} ครั้งก่อนถูกล็อก`,
      'PIN_WRONG',
      { reason: 'wrong', attemptsRemaining: check.attemptsRemaining },
    );
  }

  const approver = await loadPinHolder(check.supervisorId);
  const token = await issueApprovalToken({
    actorId: input.actorId,
    supervisorId: check.supervisorId,
    action: input.action,
    targetId: input.targetId,
  });

  return { ...token, approverName: approver.full_name };
}

/** Verifies an approval token's signature, lifetime, and bindings. */
export async function verifyApprovalToken(token: string): Promise<ApprovalClaims> {
  try {
    const { payload } = await jwtVerify(token, authSecretKey(), {
      issuer: APPROVAL_ISSUER,
      audience: APPROVAL_AUDIENCE,
    });

    const { sub, act, tid, by } = payload as Record<string, unknown>;
    if (
      typeof sub !== 'string' ||
      typeof act !== 'string' ||
      typeof tid !== 'string' ||
      typeof by !== 'string'
    ) {
      throw new InvalidApprovalError();
    }

    return { actorId: sub, action: act as SupervisorAction, targetId: tid, supervisorId: by };
  } catch (error) {
    if (error instanceof InvalidApprovalError) {
      throw error;
    }
    throw new InvalidApprovalError();
  }
}

/**
 * The gate a protected route calls instead of `requireRole`.
 *
 * Refuses the request unless it carries an approval that matches this action,
 * this target, and *this* cashier. The mismatch messages are deliberately
 * specific about what did not match, because the person reading them is a
 * developer looking at a 403 in the log, and "forbidden" alone would send them
 * to the wrong file.
 */
export async function requireApproval(
  request: Request,
  action: SupervisorAction,
  targetId: string,
): Promise<{ actor: SessionUser; approverId: string }> {
  const actor = await requireRole(['employee', 'admin']);

  const raw = request.headers.get(APPROVAL_HEADER);
  if (!raw) {
    throw new ForbiddenError(
      `ต้องได้รับอนุมัติจากผู้ดูแลก่อน — ${SUPERVISOR_ACTION_LABELS[action]}`,
    );
  }

  let claims: ApprovalClaims;
  try {
    claims = await verifyApprovalToken(raw);
  } catch {
    throw new ForbiddenError('การอนุมัติไม่ถูกต้องหรือหมดอายุแล้ว กรุณาขออนุมัติใหม่');
  }

  assertApprovalMatches(claims, { action, targetId, actorId: actor.id });

  return { actor, approverId: claims.supervisorId };
}

/**
 * The three bindings, stated once.
 *
 * A pure function for two reasons: `requireApproval` needs a cookie and a Request,
 * which makes it awkward to test, while this is the part that can actually be
 * wrong. Both callers — the gate and its tests — run the same code.
 */
export function assertApprovalMatches(
  claims: ApprovalClaims,
  expected: { action: SupervisorAction; targetId: string; actorId: string },
): void {
  /*
   * All three say what was approved versus what is being attempted, because "you do
   * not have permission" sends the cashier hunting for a role problem when the real
   * answer is that they are one approval behind — a supervisor approved a discount
   * and the cashier is now trying to void the order.
   *
   * The action names are already Thai (`SUPERVISOR_ACTION_LABELS`); only the sentence
   * around them was English.
   */
  if (claims.action !== expected.action) {
    throw new ForbiddenError(
      `อนุมัตินี้ใช้สำหรับ${SUPERVISOR_ACTION_LABELS[claims.action]} ไม่ใช่${SUPERVISOR_ACTION_LABELS[expected.action]}`,
      `approval granted for ${claims.action}, expected ${expected.action}`,
    );
  }
  if (claims.targetId !== expected.targetId) {
    throw new ForbiddenError(
      'อนุมัตินี้ใช้กับยอดหรือรายการอื่น — กรุณาขออนุมัติใหม่',
      `approval bound to target ${claims.targetId}, expected ${expected.targetId}`,
    );
  }
  if (claims.actorId !== expected.actorId) {
    throw new ForbiddenError(
      'อนุมัตินี้ให้กับผู้ใช้อื่น — กรุณาขออนุมัติใหม่',
      `approval granted to actor ${claims.actorId}, expected ${expected.actorId}`,
    );
  }
}

async function loadPinHolder(userId: string): Promise<PinHolderRow> {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      full_name: true,
      is_active: true,
      pin_hash: true,
      pin_failed_attempts: true,
      pin_locked_until: true,
    },
  });

  if (!user) {
    throw new NotFoundError('ไม่พบผู้ใช้ที่ระบุ', `User ${userId}`);
  }
  if (!user.is_active) {
    throw new ConflictError('บัญชีนี้ไม่ได้ใช้งานแล้ว', 'ACCOUNT_INACTIVE');
  }

  return user;
}
