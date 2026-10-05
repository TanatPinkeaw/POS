/**
 * Becoming a customer with Google, and returning as one (ADR 0020 §3, §4).
 *
 * Two doors lead to a `member` — the counter (ADR 0011) and this one. The phone is the
 * identity; points and order history hang off the row that owns it.
 *
 * What a Google credential proves is the **Google account**, and nothing about the
 * number it arrives with. That is the whole shape of the rule here, and it is
 * deliberately not the OTP door it once was:
 *
 *   1. **A Google account already on a row.** The subject resolves first, so a
 *      returning customer signs straight in. The number it arrives with is not even
 *      looked at — the credential is the proof.
 *   2. **A first sign-in needs a number.** A number nobody owns makes a customer.
 *   3. **A number somebody owns is refused, never linked.** Attaching the subject to
 *      a row on the strength of a typed number would hand anybody who can type it the
 *      points and the history behind that row. Removing the OTP proof is what makes
 *      this a takeover, so the row is reached with its own password instead.
 *
 * `changeCustomerPhone` below is the one act that still proves a number, because moving
 * the identity is the higher-risk act.
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
import {
  isCurrentCustomerNotice,
  recordNoticeAcknowledgement,
} from './privacy-notice';

/** The customer behind a Google subject, if the door has been used before. */
export interface CustomerRow {
  id: string;
  role: string;
  fullName: string;
  phone: string;
  pointsBalance: number;
  isActive: boolean;
}

/** What a completed self-signup produces, for the session and the screen. */
export interface CustomerSignIn {
  id: string;
  fullName: string;
  phone: string;
  pointsBalance: number;
  /** True when this call created the customer row; false when it signed one back in. */
  created: boolean;
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
 * Signs a verified Google identity in, or makes them a customer.
 *
 * The caller has *already* verified the id token (`verifyGoogleIdToken`) — this
 * function trusts `identity` and does no crypto of its own.
 *
 * The number is where the care goes, because a Google credential proves the *Google
 * account* and nothing about the number it is offered with. So a subject that already
 * resolves to a row signs in, and the number it happens to arrive with is not looked
 * at; a number nobody owns makes a customer; a number that belongs to staff is
 * refused, and so is one that belongs to another customer. The last is the change from
 * the OTP door this replaced — attaching the subject to a stranger's row on the
 * strength of a typed number would be a takeover, and that row is reached with its own
 * password instead.
 *
 * `phone` is normalised because the counter writes numbers in the same shape
 * (`normalisePhone`), so the same digits typed two ways are one identity.
 */
export async function completeCustomerGoogleSignIn(input: {
  identity: GoogleIdentity;
  /** The number offered on a first sign-in; a returning account needs none. */
  phone?: string;
  /** What the customer wants to be called; the Google name is the fallback. */
  fullName?: string;
  /**
   * The privacy notice the customer was shown, required only when a new customer is
   * made.
   *
   * **Optional in the type but required in practice on the create path.** Step 1
   * returns early for a returning customer, and a returning customer was told the
   * notice when they first arrived — asking for it again would ask a shop to re-collect
   * something it already holds, and would fail every sign-in by somebody who signed up
   * before this existed. So the field is only demanded at the point where an account is
   * actually created, which is the only point where the shop's duty to inform arises.
   */
  noticeVersion?: string;
}): Promise<CustomerSignIn> {
  const subject = input.identity.subject;

  // 1. This Google account is already somebody — sign in, and ignore any number: the
  //    Google credential is the whole proof, and this door never moves a phone.
  const bySubject = await findCustomerByGoogleSubject(subject);
  if (bySubject) {
    return { ...bySubject, created: false };
  }

  // 2. A first sign-in needs a number to hang the identity on.
  const phone = normalisePhone(input.phone ?? '');
  if (phone.length === 0) {
    throw new ValidationError('กรุณากรอกเบอร์โทรศัพท์');
  }

  // 3. Who already owns this number? Nobody this door may take it from.
  const byPhone = await prisma.users.findUnique({ where: { phone }, select: { id: true, role: true } });
  if (byPhone) {
    if (byPhone.role !== 'member') {
      throw new ConflictError(
        'เบอร์นี้เป็นบัญชีพนักงาน — ใช้เบอร์อื่นสำหรับบัญชีลูกค้า',
        'PHONE_BELONGS_TO_STAFF',
      );
    }
    /*
     * A number that already has a customer is refused, not linked. The door cannot
     * prove the number, so linking would mean anybody who can type it inherits the
     * points and the order history behind that row. The row is reached with its own
     * password instead — the one the counter handed over when it enrolled them
     * (ADR 0011) — so nothing is lost, only not gained without a credential.
     */
    throw new ConflictError(
      'เบอร์นี้มีบัญชีลูกค้าอยู่แล้ว — เข้าสู่ระบบด้วยเบอร์และรหัสผ่านก่อน',
      'PHONE_ALREADY_REGISTERED',
    );
  }

  // 4. A number nobody owns: a new customer, with a password nobody knows.
  const fullName = input.fullName?.trim() || input.identity.fullName?.trim() || 'ลูกค้า';

  /*
   * The notice, checked here rather than in the route.
   *
   * It is the check that matters most in this file and it is three lines long: the shop
   * is required to inform a customer what it does with their data, and the only moment
   * this shop can do that for a walk-in is the moment the account appears. So the
   * version the customer acknowledged is demanded *before* the row exists, and an
   * absent or stale one refuses the signup.
   *
   * It belongs here, not in the route handler, because this is the function that knows
   * whether an account is being created. A returning customer (step 1) has already been
   * told and never reaches this line, so demanding a notice at the route would ask a
   * returning customer to acknowledge a notice they have already acknowledged — and
   * would refuse every account that predates this table.
   *
   * The message names the notice rather than saying "invalid version", because the only
   * way to arrive here with a bad value is a browser that is holding an out-of-date page
   * while the shop is running a newer build.
   */
  const noticeVersion = input.noticeVersion?.trim() ?? '';
  if (!isCurrentCustomerNotice(noticeVersion)) {
    throw new ValidationError(
      'กรุณาอ่านและยืนยันนโยบายคุ้มครองข้อมูลส่วนบุคคลก่อนสร้างบัญชี',
      'NOTICE_NOT_ACKNOWLEDGED',
    );
  }

  try {
    /*
     * The customer and the acknowledgement in one transaction.
     *
     * Written sequentially they would be two facts that could disagree: a failure
     * between them leaves an account the shop cannot show any record of having told
     * anybody about — the exact state this row exists to rule out, and the one a
     * regulator would find first. `recordAudit` has always accepted a `db` for this
     * reason; it is the same transaction now, and the same argument.
     */
    const created = await prisma.$transaction(async (tx) => {
      const customer = await tx.users.create({
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
      await recordNoticeAcknowledgement(tx, {
        customerUserId: customer.id,
        noticeVersion,
      });
      await recordAudit(
        {
          action: 'member_created',
          actorUserId: customer.id,
          targetType: 'user',
          targetId: customer.id,
          // The version rides along with the audit row so the trail and the evidence
          // cannot be read differently: both name the same text, on the same day.
          detail: { phone, via: 'google', noticeVersion },
        },
        tx,
      );
      return customer;
    });
    return { ...toCustomer(created), created: true };
  } catch (error) {
    /*
     * The race the read above cannot exclude: two requests for one phone (or one Google
     * account) arriving together, both finding nothing. The database refuses the second
     * insert on the unique index, and it arrives as the same conflict a second sign-up
     * should see.
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
 * The order is prove, then decide, then write. So a wrong or expired code leaves the
 * row exactly as it was, and no half-moved identity can exist. A new
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
    throw new NotFoundError('ไม่พบลูกค้าที่ระบุ', `Customer ${input.userId}`);
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
