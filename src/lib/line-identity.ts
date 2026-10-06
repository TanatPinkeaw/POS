/**
 * A customer's LINE: binding it, unbinding it, and the consent it sits behind
 * (ADR 0030).
 *
 * Three facts live on the customer row — the subject (`line_subject`), when they
 * consented to being notified (`line_consent_at`), and under which text
 * (`line_consent_version`) — and this file owns every write to them. The caller
 * has *already* verified the id token, exactly as `identity.ts` trusts the Google
 * identity it is handed; this file does no crypto of its own.
 *
 * The shape to copy is ADR 0020's, because the problem is its problem: a LINE
 * credential proves the **LINE account** and nothing about the number it arrives
 * beside. So:
 *
 *   1. **A subject already on a row is that customer.** Sign straight in; any
 *      number offered beside it is not looked at.
 *   2. **A subject nobody holds must be anchored.** Unlike Google's first
 *      sign-in, the anchor here is not a typed number — the callback arrived in a
 *      browser whose session (if any) says somebody else, and a binding act is
 *      exactly the takeover §4 of ADR 0020 exists to refuse. So the number is
 *      proved the way a phone *change* proves it: an OTP code, sent to the number
 *      being anchored to, consumed before anything is written (ADR 0030 §1).
 *   3. **Staff rows are never bound.** LINE is a customer door; a cashier keeps
 *      the phone and temporary password the counter enrolled them with.
 *
 * Unlinking is the customer's own act: it clears the subject and the consent
 * together, because the strongest form of "stop messaging me" is also the
 * easiest to explain to the person who asked (ADR 0030 §2).
 */
import { randomBytes } from 'node:crypto';

import { recordAudit } from './audit';
import { prisma } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { LINE_CONSENT_VERSION } from './line-notify';
import { isCurrentCustomerNotice, recordNoticeAcknowledgement } from './privacy-notice';
import { normalisePhone } from './phone';
import { consumeOtpChallenge } from './otp-store';
import { hashPassword } from './password';

/**
 * The customer behind a LINE subject, if the door has been used before.
 *
 * A separate select from `findCustomerByGoogleSubject` — the LINE door has to know
 * whether the row it found is a member *before* deciding what to answer, and
 * `role` is already in both shapes.
 */
export async function findCustomerByLineSubject(subject: string): Promise<{
  id: string;
  role: string;
  fullName: string;
  phone: string;
  isActive: boolean;
} | null> {
  const row = await prisma.users.findUnique({
    where: { line_subject: subject },
    select: { id: true, role: true, full_name: true, phone: true, is_active: true },
  });
  return row ? { id: row.id, role: row.role, fullName: row.full_name, phone: row.phone, isActive: row.is_active } : null;
}

/**
 * The consent state of one signed-in customer, as the account page needs it.
 *
 * Three fields rather than an object per fact, because the page renders them as
 * one card: whether a LINE account is bound, when notification was agreed (and
 * under which text, so the page can say "you agreed to the current version"),
 * and nothing else — the friend condition is checked at *send* time, so the page
 * says "your LINE may need to add the shop" rather than claiming to know.
 */
export async function lineBindingForUser(userId: string): Promise<{
  lineSubject: string | null;
  consentAt: Date | null;
  consentVersion: string | null;
} | null> {
  const row = await prisma.users.findUnique({
    where: { id: userId },
    select: { line_subject: true, line_consent_at: true, line_consent_version: true, role: true },
  });
  if (!row || row.role !== 'member') {
    return null;
  }
  return {
    lineSubject: row.line_subject,
    consentAt: row.line_consent_at,
    consentVersion: row.line_consent_version,
  };
}

/**
 * Finishes a first LINE sign-in: the same two halves as the Google door.
 *
 * Called by `POST /api/v1/auth/line` with the verified identity. A known subject
 * signs its customer in; an unknown one answers `needsPhone` with no rows
 * written, so a caller who walks away leaves nothing behind — the same
 * statelessness the Google door records as a decision rather than an accident.
 */
export async function completeCustomerLineSignIn(input: {
  subject: string;
  /** What the LINE profile names them, for the screen that collects a phone. */
  fullName: string | null;
  email: string | null;
}): Promise<{ needsPhone: boolean } | { signedIn: true }> {
  const customer = await findCustomerByLineSubject(input.subject);
  return customer ? { signedIn: true } : { needsPhone: true };
}

/**
 * Binds a verified LINE subject to a customer row, proving the phone first.
 *
 * The one act in this file that moves an identity, so the order is prove, then
 * decide, then write — the same order `changeCustomerPhone` records as the reason
 * a wrong code leaves the row exactly as it was:
 *
 *   1. The OTP code sent to the number must be consumed (its own guard, so a
 *      code minted for another number proves nothing here).
 *   2. A staff number is refused; a number no row holds **creates a customer**
 *      (the walk-in equivalent of the counter enrolment, self-served) rather
 *      than inventing a second identity table.
 *   3. The row is written and audited in one transaction, so "bound" and
 *      "recorded" cannot disagree.
 *
 * A LINE account that already belongs to another customer is refused at the
 * unique index — arriving here with one means either a double click (harmless;
 * the answer is the same customer) or somebody presenting a stranger's subject
 * to a browser holding a stranger's OTP, and the index is the backstop for the
 * read this function could not make atomic.
 */
export async function bindLineToCustomer(input: {
  subject: string;
  displayName: string | null;
  email: string | null;
  phone: string;
  code: string;
  fullName?: string;
  /**
   * The privacy notice the customer acknowledged — demanded only when a new
   * customer is made, exactly as the Google door demands it only at the point an
   * account appears (ADR 0020): a returning customer was told when they arrived,
   * and asking again would re-collect something the shop already holds.
   */
  noticeVersion?: string;
}): Promise<{ id: string; fullName: string; phone: string; created: boolean }> {
  const phone = normalisePhone(input.phone);
  if (phone.length === 0) {
    throw new ValidationError('กรุณากรอกเบอร์โทรศัพท์');
  }

  // 1. Prove the number before anything is decided — this door's whole proof.
  if (!(await consumeOtpChallenge(phone, input.code))) {
    throw new ValidationError('รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว');
  }

  // 2. Who already owns this number, and is the row the subject may anchor to?
  const byPhone = await prisma.users.findUnique({
    where: { phone },
    select: { id: true, role: true, line_subject: true },
  });

  if (byPhone && byPhone.role !== 'member') {
    throw new ConflictError(
      'เบอร์นี้เป็นบัญชีพนักงาน — ใช้เบอร์อื่นสำหรับบัญชีลูกค้า',
      'PHONE_BELONGS_TO_STAFF',
    );
  }

  const alreadyBound = await prisma.users.findUnique({
    where: { line_subject: input.subject },
    select: { id: true, role: true },
  });
  if (alreadyBound && alreadyBound.id !== byPhone?.id) {
    throw new ConflictError(
      'บัญชี LINE นี้ถูกผูกกับบัญชีลูกค้าอื่นอยู่แล้ว — ถ้าเป็นของคุณ โปรดยืนยันที่หน้าบัญชีของคุณ',
      'LINE_SUBJECT_TAKEN',
    );
  }

  /*
   * The privacy notice, checked here rather than in the route, for the same
   * reason `identity.ts` checks it here: only this function knows whether an
   * account is being created, and only creation is the moment the shop's duty to
   * inform arises. Binding to an existing row records the LINE consent instead,
   * which is its own fact with its own version below.
   */
  const noticeVersion = input.noticeVersion?.trim() ?? '';
  if (byPhone === null && !isCurrentCustomerNotice(noticeVersion)) {
    throw new ValidationError(
      'กรุณาอ่านและยืนยันนโยบายคุ้มครองข้อมูลส่วนบุคคลก่อนสร้างบัญชี',
      'NOTICE_NOT_ACKNOWLEDGED',
    );
  }

  // 3. The write, with its audit row, in one transaction. Both branches return
  //    the same shape — the union the route starts a session from.
  const bound: { id: string; fullName: string; phone: string; created: boolean } =
    await prisma.$transaction(async (tx): Promise<{ id: string; fullName: string; phone: string; created: boolean }> => {
    if (byPhone) {
      /*
       * An existing customer binds their own row — the ordinary case. The email
       * the LINE profile carries is deliberately *not* written over the row: the
       * customer may have set one through Google (ADR 0020) or an operator may
       * have corrected it, and a door that arrived later does not get to rewrite
       * what earlier doors established.
       */
      const row = await tx.users.update({
        where: { id: byPhone.id },
        data: {
          line_subject: input.subject,
          line_consent_at: new Date(),
          line_consent_version: LINE_CONSENT_VERSION,
        },
        select: { id: true, full_name: true, phone: true },
      });
      await recordAudit(
        {
          action: 'line_bound',
          actorUserId: row.id,
          targetType: 'user',
          targetId: row.id,
          detail: { subject: input.subject, lineConsentVersion: LINE_CONSENT_VERSION, created: false },
        },
        tx,
      );
      return { id: row.id, fullName: row.full_name, phone: row.phone, created: false };
    }

    // A number nobody owns: a new customer, the same shape the Google door makes.
    const fullName = input.fullName?.trim() || input.displayName?.trim() || 'ลูกค้า';
    const created = await tx.users.create({
      data: {
        full_name: fullName,
        phone,
        email: input.email,
        password_hash: await hashPassword(randomBytes(24).toString('base64url')),
        role: 'member',
        line_subject: input.subject,
        line_consent_at: new Date(),
        line_consent_version: LINE_CONSENT_VERSION,
      },
      select: { id: true, full_name: true, phone: true },
    });
    await recordAudit(
      {
        action: 'line_bound',
        actorUserId: created.id,
        targetType: 'user',
        targetId: created.id,
        detail: { subject: input.subject, lineConsentVersion: LINE_CONSENT_VERSION, created: true, phone },
      },
      tx,
    );
    /*
     * The notice acknowledgement rides the same transaction as the customer row,
     * for the same reason `identity.ts` records it there: a shop that can say
     * "this customer was told" must not be able to produce a customer who was
     * not.
     */
    await recordNoticeAcknowledgement(tx, {
      customerUserId: created.id,
      noticeVersion,
    });
    return { id: created.id, fullName: created.full_name, phone: created.phone, created: true };
  });

  return bound;
}

/**
 * Binds a LINE account to a customer who is **already signed in** (ADR 0030 §1).
 *
 * The account-page half of the door. No OTP is consumed here, and that is not a
 * shortcut: the caller holds the session, which is the same credential the phone
 * change and the points ledger already trust, and the id token has been verified
 * by the route — so the two facts this file needs (which row, which LINE account)
 * are both proved before this function runs. The OTP path exists for the browser
 * that arrives with a LINE callback and *no* session; this one arrives with a
 * session and no phone to prove.
 *
 * What is refused is everything the unique indexes refuse anyway, said in Thai
 * before the database has to: a subject another row already holds (a stranger's
 * LINE cannot be adopted by signing in), and a staff row (LINE is a customer
 * door). Consent is recorded at the same moment, because a customer who just
 * linked their LINE to the shop has said yes in the only sentence that matters.
 */
export async function bindSignedInCustomer(input: {
  userId: string;
  subject: string;
}): Promise<void> {
  const row = await prisma.users.findUnique({
    where: { id: input.userId },
    select: { role: true, line_subject: true },
  });
  if (!row) {
    throw new NotFoundError('ไม่พบลูกค้าที่ระบุ', `Customer ${input.userId}`);
  }
  if (row.role !== 'member') {
    throw new ConflictError('บัญชีนี้ไม่ใช่บัญชีลูกค้า', 'NOT_A_MEMBER_ACCOUNT');
  }
  if (row.line_subject === input.subject) {
    return; // The same account, linked again — a no-op, not an error.
  }

  const holder = await prisma.users.findUnique({
    where: { line_subject: input.subject },
    select: { id: true },
  });
  if (holder && holder.id !== input.userId) {
    throw new ConflictError(
      'บัญชี LINE นี้ถูกผูกกับบัญชีอื่นอยู่แล้ว',
      'LINE_SUBJECT_TAKEN',
    );
  }

  await prisma.users.update({
    where: { id: input.userId },
    data: {
      line_subject: input.subject,
      line_consent_at: new Date(),
      line_consent_version: LINE_CONSENT_VERSION,
    },
  });
  await recordAudit({
    action: 'line_bound',
    actorUserId: input.userId,
    targetType: 'user',
    targetId: input.userId,
    detail: { subject: input.subject, lineConsentVersion: LINE_CONSENT_VERSION, via: 'account' },
  });
}

/**
 * Clears a customer's LINE binding — their own act, never an operator's.
 *
 * Both facts go together (ADR 0030 §2): the subject that lets them sign in with
 * LINE and the consent that lets the shop push to it. A subject left behind with
 * the consent cleared would be a half-stopped messaging; a consent left behind
 * with the subject cleared is dead weight. One update, one audit row, done.
 */
export async function unbindLineFromCustomer(userId: string): Promise<void> {
  const row = await prisma.users.findUnique({
    where: { id: userId },
    select: { line_subject: true, role: true },
  });
  if (!row) {
    throw new NotFoundError('ไม่พบลูกค้าที่ระบุ', `Customer ${userId}`);
  }
  if (row.role !== 'member') {
    throw new ConflictError('บัญชีนี้ไม่ใช่บัญชีลูกค้า', 'NOT_A_MEMBER_ACCOUNT');
  }
  if (row.line_subject === null) {
    return; // Already unbound — the request is a no-op, not an error.
  }

  await prisma.users.update({
    where: { id: userId },
    data: { line_subject: null, line_consent_at: null, line_consent_version: null },
  });
  await recordAudit({
    action: 'line_unbound',
    actorUserId: userId,
    targetType: 'user',
    targetId: userId,
    detail: { subject: row.line_subject },
  });
}

/**
 * Records (or withdraws) notification consent, on a bound account only.
 *
 * A consent change is a smaller act than a binding — it changes what the shop may
 * send, not who can sign in — so it is audited as `member_updated` with the
 * field named, exactly as the phone change names its field. A member may flip it
 * as often as they like; the timestamp records the most recent yes.
 */
export async function setLineNotificationConsent(input: {
  userId: string;
  consentVersion: string;
}): Promise<{ consented: boolean; consentAt: Date | null }> {
  const row = await prisma.users.findUnique({
    where: { id: input.userId },
    select: { line_subject: true, role: true },
  });
  if (!row) {
    throw new NotFoundError('ไม่พบลูกค้าที่ระบุ', `Customer ${input.userId}`);
  }
  if (row.role !== 'member') {
    throw new ConflictError('บัญชีนี้ไม่ใช่บัญชีลูกค้า', 'NOT_A_MEMBER_ACCOUNT');
  }
  if (row.line_subject === null) {
    throw new ConflictError(
      'ยังไม่ได้ผูกบัญชี LINE — ผูกบัญชีก่อนจึงจะรับการแจ้งเตือนได้',
      'LINE_NOT_BOUND',
    );
  }

  const now = new Date();
  await prisma.users.update({
    where: { id: input.userId },
    data: { line_consent_at: now, line_consent_version: input.consentVersion.trim() },
  });
  await recordAudit({
    action: 'member_updated',
    actorUserId: input.userId,
    targetType: 'user',
    targetId: input.userId,
    detail: { fields: ['line_notify_consent'], consentVersion: input.consentVersion.trim() },
  });

  return { consented: true, consentAt: now };
}
