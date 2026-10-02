/**
 * Becoming a customer with Google, and returning as one (ADR 0020 §3, §4).
 *
 * Two doors lead to a `member` — the counter (ADR 0011) and this one — and the
 * ticket's whole job is that the second never makes a *second* row. The phone is the
 * identity; points and order history hang off the row that owns it. So a Google
 * sign-in that arrives with a phone some customer already has must **link** to that
 * row, and a phone that belongs to staff must be refused rather than duplicated.
 *
 * The order of the checks is the rule, and it is deliberate:
 *
 *   1. **A Google account already on a row.** The subject resolves first, so a
 *      returning customer whose number is unchanged signs straight in with no OTP —
 *      ADR 0020 §5 verifies the phone at signup and on a change, not on every visit.
 *      If the same subject arrives with a *different* phone, it is refused: moving a
 *      number is a step-up act (ticket 03), not a side effect of signing in.
 *   2. **The phone proved by OTP.** Consumed before anything is written, so a bad or
 *      expired code cannot create an account or attach a credential.
 *   3. **Who already owns the phone.** A staff number is refused; a customer's row
 *      gets the subject attached (or is already carrying it); only a phone nobody
 *      owns makes a new customer.
 *
 * Creating a customer here mints a random password hash rather than leaving the
 * column null. The password door is neither required nor closed: the customer can set
 * a real password later from their profile (ADR 0020 §3), and until they do, no
 * password anybody could guess opens the account.
 */
import { randomBytes } from 'node:crypto';

import { recordAudit } from './audit';
import { prisma } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import type { GoogleIdentity } from './google-id-token';
import { consumeOtpChallenge } from './otp-store';
import { hashPassword } from './password';
import { normalisePhone } from './phone';

/** The customer behind a Google subject, if the door has been used before. */
export interface CustomerRow {
  id: string;
  role: string;
  fullName: string;
  phone: string;
  pointsBalance: number;
  isActive: boolean;
}

/** What a completed self-signup or link produces, for the session and the screen. */
export interface CustomerSignIn {
  id: string;
  fullName: string;
  phone: string;
  pointsBalance: number;
  /** True when this call created the customer row. */
  created: boolean;
  /** True when this call attached the Google subject to an existing row. */
  linked: boolean;
}

const CUSTOMER_SELECT = {
  id: true,
  role: true,
  full_name: true,
  phone: true,
  points_balance: true,
  is_active: true,
} as const;

function toCustomer(row: {
  id: string;
  role: string;
  full_name: string;
  phone: string;
  points_balance: number;
  is_active: boolean;
}): CustomerRow {
  return {
    id: row.id,
    role: row.role,
    fullName: row.full_name,
    phone: row.phone,
    pointsBalance: row.points_balance,
    isActive: row.is_active,
  };
}

/** The customer a verified Google subject already belongs to, or null. */
export async function findCustomerByGoogleSubject(subject: string): Promise<CustomerRow | null> {
  const row = await prisma.users.findUnique({ where: { google_subject: subject }, select: CUSTOMER_SELECT });
  return row ? toCustomer(row) : null;
}

/**
 * Signs a verified Google identity in, or makes them a customer, or links them.
 *
 * The caller has *already* verified the id token (`verifyGoogleIdToken`) — this
 * function trusts `identity` and does no crypto of its own. It does own the phone
 * proof: the OTP is consumed here, inside the rule, so there is no path that
 * attaches a Google subject without a proved phone.
 *
 * `phone` is normalised first, because the OTP was issued under the normalised form
 * (`normalisePhone` at the send door) and the same person typing `080-000-0002` and
 * `0800000002` must find one challenge, not two.
 */
export async function completeCustomerGoogleSignIn(input: {
  identity: GoogleIdentity;
  phone: string;
  code: string;
  /** What the customer wants to be called; the Google name is the fallback. */
  fullName?: string;
}): Promise<CustomerSignIn> {
  const phone = normalisePhone(input.phone);
  if (phone.length === 0) {
    throw new ValidationError('กรุณากรอกเบอร์โทรศัพท์');
  }
  const subject = input.identity.subject;

  // 1. This Google account is already somebody — sign in, no OTP required.
  const bySubject = await findCustomerByGoogleSubject(subject);
  if (bySubject) {
    if (bySubject.phone !== phone) {
      throw new ConflictError(
        'บัญชี Google นี้ผูกกับเบอร์อื่นอยู่แล้ว',
        'GOOGLE_ACCOUNT_ALREADY_LINKED',
      );
    }
    return { ...bySubject, created: false, linked: false };
  }

  // 2. Prove the phone before writing anything.
  if (!(await consumeOtpChallenge(phone, input.code))) {
    throw new ValidationError('รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว');
  }

  // 3. Who owns this phone?
  const byPhone = await prisma.users.findUnique({ where: { phone }, select: { ...CUSTOMER_SELECT, google_subject: true } });
  if (byPhone) {
    if (byPhone.role !== 'member') {
      throw new ConflictError(
        'เบอร์นี้เป็นบัญชีพนักงาน — ใช้เบอร์อื่นสำหรับบัญชีลูกค้า',
        'PHONE_BELONGS_TO_STAFF',
      );
    }
    if (byPhone.google_subject && byPhone.google_subject !== subject) {
      throw new ConflictError(
        'บัญชีนี้ผูกกับบัญชี Google อื่นอยู่แล้ว',
        'GOOGLE_ACCOUNT_ALREADY_LINKED',
      );
    }

    // Link: the same row, so the points and the order history stay put. The name is
    // deliberately not touched — linking a sign-in door is not a rename, and a
    // customer who enrolled as "คุณสมชาย" keeps the name the counter wrote down.
    const linked = await prisma.users.update({
      where: { id: byPhone.id },
      data: { google_subject: subject },
      select: CUSTOMER_SELECT,
    });
    await recordAudit({
      action: 'member_updated',
      actorUserId: linked.id,
      targetType: 'user',
      targetId: linked.id,
      detail: { fields: ['google'] },
    });
    return { ...toCustomer(linked), created: false, linked: true };
  }

  // 4. A phone nobody owns: a new customer, with a password nobody knows.
  const fullName = input.fullName?.trim() || input.identity.fullName?.trim() || 'ลูกค้า';
  try {
    const created = await prisma.users.create({
      data: {
        full_name: fullName,
        phone,
        email: input.identity.email,
        // A random hash, not a null and not a known one: the phone+password door is
        // closed until the customer sets a password of their own.
        password_hash: await hashPassword(randomBytes(24).toString('base64url')),
        role: 'member',
        google_subject: subject,
        is_active: true,
      },
      select: CUSTOMER_SELECT,
    });
    await recordAudit({
      action: 'member_created',
      actorUserId: created.id,
      targetType: 'user',
      targetId: created.id,
      detail: { phone, via: 'google' },
    });
    return { ...toCustomer(created), created: true, linked: false };
  } catch (error) {
    /*
     * The race the two reads above cannot exclude: two requests for one phone (or one
     * Google account) arriving together, both finding nothing. The database refuses
     * the second insert on the unique index, and it arrives as the same conflict a
     * second sign-up should see.
     */
    if (isUniqueViolation(error)) {
      throw new ConflictError('เบอร์นี้หรือบัญชี Google นี้ถูกใช้แล้ว', 'DUPLICATE_ACCOUNT');
    }
    throw error;
  }
}

/**
 * Moves a customer's phone to a new number, proving the new one first (ADR 0020 §5).
 *
 * This is the other half of "OTP is verified once, and on every phone change". A
 * phone is the identity — points, order history and the collection code all hang off
 * it — so moving it is the higher-risk act, and the proof is of the number being
 * moved *to*, not the one being left. A code minted for the old number is therefore
 * useless here: the challenge is looked up by the new one.
 *
 * The order matches `completeCustomerGoogleSignIn`: prove the new number by
 * consuming its challenge, then decide, then write. So a wrong or expired code
 * leaves the row exactly as it was, and no half-moved identity can exist. A new
 * number another row already holds is refused rather than stolen, and uniqueness
 * spans every role — a staff number is as taken as another customer's — with the
 * index as the backstop under the read a race could slip between.
 *
 * Changing to the number the row already has is a no-op: there is nothing to prove
 * and nothing to write down, so it neither spends a code nor earns an audit row.
 */
export async function changeCustomerPhone(input: {
  userId: string;
  /** The number being moved to; the code must have been sent to *this* one. */
  newPhone: string;
  code: string;
}): Promise<CustomerRow> {
  const newPhone = normalisePhone(input.newPhone);
  if (newPhone.length === 0) {
    throw new ValidationError('กรุณากรอกเบอร์โทรศัพท์');
  }

  const existing = await prisma.users.findUnique({
    where: { id: input.userId },
    select: { ...CUSTOMER_SELECT, google_subject: true },
  });
  if (!existing) {
    throw new NotFoundError(`Customer ${input.userId}`);
  }
  if (existing.role !== 'member') {
    throw new ConflictError('บัญชีนี้ไม่ใช่บัญชีลูกค้า', 'NOT_A_MEMBER_ACCOUNT');
  }

  if (existing.phone === newPhone) {
    return toCustomer(existing);
  }

  // Prove the new number before anything is written.
  if (!(await consumeOtpChallenge(newPhone, input.code))) {
    throw new ValidationError('รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว');
  }

  // Uniqueness spans every role, so this is a refusal rather than a re-key of somebody
  // else's account. Loaded here so the message is Thai, with the index below as the
  // backstop for the race between this read and the write.
  const owner = await prisma.users.findUnique({ where: { phone: newPhone }, select: { id: true } });
  if (owner && owner.id !== existing.id) {
    throw new ConflictError('เบอร์นี้ถูกใช้กับบัญชีอื่นอยู่แล้ว — ลองใช้เบอร์อื่น', 'DUPLICATE_ACCOUNT');
  }

  let updated: {
    id: string;
    role: string;
    full_name: string;
    phone: string;
    points_balance: number;
    is_active: boolean;
  };
  try {
    updated = await prisma.users.update({
      where: { id: existing.id },
      data: { phone: newPhone },
      select: CUSTOMER_SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('เบอร์นี้ถูกใช้กับบัญชีอื่นอยู่แล้ว — ลองใช้เบอร์อื่น', 'DUPLICATE_ACCOUNT');
    }
    throw error;
  }

  /*
   * A phone change is a security event — it moves the identity — so it is written
   * down, with the number that used to be the way to find this customer. The shape
   * matches `updateMember`'s, so the trail reads the same whoever made the change.
   */
  await recordAudit({
    action: 'member_updated',
    actorUserId: updated.id,
    targetType: 'user',
    targetId: updated.id,
    detail: { fields: ['phone'], previousPhone: existing.phone },
  });

  return toCustomer(updated);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}
