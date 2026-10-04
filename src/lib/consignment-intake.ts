/**
 * A member offers their own goods for consignment (ADR 0025).
 *
 * The member fills in a short form on their own account page, signed in, and the
 * browser posts it here. There is no Google Form, no Apps Script trigger and no shared
 * secret — the session is the proof, and the session is the identity, which is what
 * makes this a fourth route into nothing at all: the module decides nothing.
 *
 * Three properties are the reason this is not a shortcut into `products`:
 *
 *   * **An offer is not an arrangement.** Nothing here creates a product and nothing
 *     here sets a share. A member offering goods has not yet agreed a percentage with
 *     anybody, so a row that created either would be a liability the shop never
 *     accepted. `approveSubmission` is where both happen, inside one transaction,
 *     through the *existing* `setConsignment` — the same rule that has always guarded
 *     the share, not a second implementation of it.
 *   * **The link is kept, the bytes are not** (ADR 0014 extended). A member attaches a
 *     Drive link or whatever else they keep their pictures in, and this system cannot
 *     open it, cannot back it up and cannot vouch for it. Holding the link and saying
 *     so is the same trade a product photo makes; storing the file would need a place
 *     to put it and a backup that covers it, which this repository has decided against.
 *   * **A double-tap is not a second offer.** The member's browser mints a
 *     `client_ref` once for the form — the same idea as `orders.client_ref` in ADR
 *     0019 — and it is UNIQUE, so a second press or a retried request is answered with
 *     the offer already recorded rather than with a new row. Goods counted twice because
 *     somebody tapped twice is worse than goods counted once late.
 *
 * The scoping property is the same one `consignment-portal.ts` relies on and lives
 * here for the same reason: the query that reads a member's submissions is the query
 * that names them, so nothing in a request body can widen it.
 */
import { recordAudit } from './audit';
import { setConsignment } from './consignment';
import { MAX_OFFER_DOCUMENTS, MAX_OFFER_PHOTOS } from './consignment-rules';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { adjustStock, type Db } from './inventory';
import { renderableImageUrl } from './image-url';
import { fromDecimal } from './money';

/** The most submissions one screen reads, newest first. */
export const OFFER_INBOX_LIMIT = 50;
/** How much of a member's own history their account page shows. */
export const CUSTOMER_SUBMISSION_LIMIT = 50;

export type ConsignmentDocumentKind = 'photo' | 'document';

/** One attachment as the member's form sends it. */
export interface OfferAttachment {
  kind: ConsignmentDocumentKind;
  /** What the member called it, or a default this module fills in. */
  label: string;
  url: string;
}

export interface OfferInput {
  /** The member who offered the goods, from the session. Never a typed claim. */
  consignorUserId: string;
  /** The browser's key for this form; the idempotency key, and UNIQUE in the database. */
  clientRef: string;
  productName: string;
  offeredPriceThb: number;
  quantity: number;
  notes?: string | null;
  attachments: OfferAttachment[];
}

export interface OfferResult {
  submissionId: string;
  status: 'pending';
  /** True when this exact form had already been recorded, rather than sent twice. */
  duplicate: boolean;
}

/**
 * The Thai default for an attachment the member did not name.
 *
 * Asking somebody to label their own photograph "ด้านหน้า" or "ด้านข้าง" is asking
 * for a vocabulary they do not have, so the common case is numbered for them and the
 * field is there for the case where a name genuinely helps.
 */
function defaultLabel(kind: ConsignmentDocumentKind, index: number): string {
  const nth = ['แรก', 'ที่สอง', 'ที่สาม', 'ที่สี่', 'ที่ห้า', 'ที่หก', 'ที่เจ็ด', 'ที่แปด'];
  const side = index === 0 ? 'แรก' : 'ที่สอง';
  return kind === 'photo' ? `รูป${side}` : `เอกสาร${nth[index] ?? index + 1}`;
}

/**
 * Record one offer, or return the offer already recorded under this form's key.
 *
 * Idempotent on `client_ref` and not merely "tolerating" a duplicate: the lookup
 * happens *before* the insert and the existing row is returned untouched, so a double
 * tap cannot create a second row and cannot resurrect a decided one.
 */
export async function submitOffer(db: Db, input: OfferInput): Promise<OfferResult> {
  /*
   * Only ever a return, never a write. The row behind a key that has already been
   * decided is closed, and re-sending the same form must not reopen a conversation
   * the shop already finished — the member reads the outcome on their account page
   * and sends a fresh offer, with a fresh key, if they want to try again.
   */
  const existing = await db.consignment_submissions.findUnique({
    where: { client_ref: input.clientRef },
    select: { id: true },
  });
  if (existing) {
    return { submissionId: existing.id, status: 'pending', duplicate: true };
  }

  const submission = await db.consignment_submissions.create({
    data: {
      consignor_user_id: input.consignorUserId,
      client_ref: input.clientRef,
      product_name: input.productName,
      offered_price_thb: input.offeredPriceThb,
      quantity: input.quantity,
      notes: input.notes ?? null,
      documents: {
        create: input.attachments.map((attachment, index) => ({
          kind: attachment.kind,
          label: attachment.label || defaultLabel(attachment.kind, index),
          url: attachment.url,
        })),
      },
    },
    select: { id: true },
  });

  /*
   * The actor is the member, because the member signed in and pressed the button.
   * Naming them is not an inference here, which is the whole difference from a
   * stranger's form answer arriving with nobody behind it.
   */
  await recordAudit(
    {
      action: 'consignment_offer_submitted',
      actorUserId: input.consignorUserId,
      targetType: 'consignment_submission',
      targetId: submission.id,
      detail: {
        clientRef: input.clientRef,
        productName: input.productName,
        quantity: input.quantity,
        offeredPriceThb: input.offeredPriceThb,
        attachmentCount: input.attachments.length,
      },
    },
    db,
  );

  return { submissionId: submission.id, status: 'pending', duplicate: false };
}

export interface ApproveSubmissionInput {
  submissionId: string;
  actorId: string;
  /**
   * The agreed share of the net. The owner's decision, and the reason this door is
   * admin-only: nobody has agreed a percentage when a member presses send, so the
   * member's form cannot supply one and must not be able to.
   */
  sharePercent: number;
  /**
   * What the shop will sell it for. Defaults to what the member asked, which is a
   * starting point for the conversation rather than a price anybody has agreed.
   */
  salePriceThb?: number | null;
  /**
   * How many units actually arrived. Defaults to the offered quantity, and exists
   * because counting goods at the counter and counting them at home disagree roughly
   * as often as not: a submission that says 20 and a shelf that holds 18 has to be
   * recordable without editing the member's words.
   */
  receivedQty?: number | null;
  categoryId?: number | null;
  /**
   * Which member owns the goods, when an owner is approving somebody else's offer on
   * their behalf. Null — the default — means the member who sent it, which is the
   * member's own account and the only case the member's form can produce.
   */
  consignorUserId?: string | null;
  note?: string | null;
}

export interface ApproveSubmissionResult {
  productId: string;
  sharePercent: number;
  receivedQty: number;
  /** How many documents rode along to the product. */
  attachedDocuments: number;
}

/**
 * Turn an offer into a product with a share on it.
 *
 * Five writes, one transaction, and the order is the argument:
 *
 *   1. the product, at zero stock — a product whose stock arrived without a movement
 *      would be invisible to every stock report the shop runs;
 *   2. `adjustStock` with `REASON_CONSIGNMENT`, which writes the movement row itself,
 *      so "goods arrived from a member" is distinguishable from "a delivery came";
 *   3. `setConsignment`, the *existing* rule — which refuses a consignor who is not a
 *      member, refuses to move goods that have already sold, and writes the
 *      `consignment_set` audit row. Reusing it is the point: a second implementation
 *      of "set the share" is a second set of rules about money the shop owes;
 *   4. the documents, in one `updateMany` — a loop here is a loop that can half-run;
 *   5. the submission closes, carrying the share that was agreed.
 *
 * The `receivedQty` default is deliberately not the submitted quantity in the
 * database — the caller decides, and only falls back when the owner did not type one.
 */
export async function approveSubmission(
  db: Db,
  input: ApproveSubmissionInput,
): Promise<ApproveSubmissionResult> {
  const submission = await db.consignment_submissions.findUnique({
    where: { id: input.submissionId },
    select: { id: true, status: true, consignor_user_id: true, product_name: true, notes: true, offered_price_thb: true, quantity: true },
  });
  if (!submission) {
    throw new NotFoundError('ไม่พบคำขอฝากขายนี้');
  }
  if (submission.status !== 'pending') {
    throw new ConflictError('คำขอนี้ถูกตัดสินไปแล้ว', 'SUBMISSION_NOT_PENDING');
  }

  /*
   * The member who sent the offer owns the goods, and `consignor_user_id` is NOT NULL,
   * so there is no "somebody typed a phone number that matched nobody" case to refuse
   * here any more. The override stays because an owner genuinely can be approving on
   * somebody's behalf — the member standing at the counter is not always the member
   * whose account carries the ledger.
   */
  const consignorUserId = input.consignorUserId ?? submission.consignor_user_id;

  const receivedQty = input.receivedQty ?? submission.quantity;
  if (!Number.isInteger(receivedQty) || receivedQty <= 0) {
    throw new ValidationError('จำนวนที่รับจริงต้องเป็นจำนวนเต็มที่มากกว่า 0');
  }

  /*
   * The first photograph the shop can actually draw becomes the product's image. The
   * same allowlist as a pasted link (ADR 0014) — a member's own form is just another
   * place a URL can come from, and being signed in says nothing about whether the link
   * points at a picture.
   * A submission with no usable photo simply leaves the column null and the tile draws
   * its placeholder glyph, which is what happens when an operator pastes nothing too.
   */
  const firstPhoto = await db.consignment_documents.findFirst({
    where: { submission_id: submission.id, kind: 'photo' },
    orderBy: { id: 'asc' },
    select: { url: true },
  });
  const imageUrl = renderableImageUrl(firstPhoto?.url);

  const product = await db.products.create({
    data: {
      name: submission.product_name,
      description: submission.notes,
      sale_price: input.salePriceThb ?? submission.offered_price_thb,
      category_id: input.categoryId ?? null,
      image_url: imageUrl,
      // Stock arrives through adjustStock below so the movement is recorded, and the
      // shop's cost stays zero because these goods are not the shop's to cost.
      stock_qty: 0,
    },
    select: { id: true },
  });

  await adjustStock(db, {
    productId: product.id,
    delta: receivedQty,
    reason: 'REASON_CONSIGNMENT',
    note: `รับของฝากขายจากคำขอ #${submission.id.slice(0, 8)}`,
    userId: input.actorId,
  });

  await setConsignment(db, {
    productId: product.id,
    consignorUserId,
    sharePercent: input.sharePercent,
    actorId: input.actorId,
  });

  const attached = await db.consignment_documents.updateMany({
    where: { submission_id: submission.id, product_id: null },
    data: { product_id: product.id },
  });

  await db.consignment_submissions.update({
    where: { id: submission.id },
    data: {
      status: 'approved',
      product_id: product.id,
      consignor_user_id: consignorUserId,
      decided_by_user_id: input.actorId,
      decided_at: new Date(),
      decided_share_percent: input.sharePercent,
      decision_note: input.note ?? null,
    },
  });

  await recordAudit(
    {
      action: 'consignment_submission_approved',
      actorUserId: input.actorId,
      targetType: 'consignment_submission',
      targetId: submission.id,
      detail: {
        productId: product.id,
        consignorUserId,
        sharePercent: input.sharePercent,
        receivedQty,
        offeredQty: submission.quantity,
        offeredPriceThb: submission.offered_price_thb,
        attachedDocuments: attached.count,
      },
    },
    db,
  );

  return { productId: product.id, sharePercent: input.sharePercent, receivedQty, attachedDocuments: attached.count };
}

/**
 * Turn a member's offer down, and say why.
 *
 * The note is required and the row is kept. Deleting it would leave the member with a
 * submission that silently vanished, which is the experience that makes somebody fill
 * in the form a second time for the same goods; keeping it with a reason means the
 * member can read on their own account exactly what the shop said, and the audit trail
 * keeps "how many offers does this shop decline, and why" as a question with an answer.
 */
export async function rejectSubmission(
  db: Db,
  input: { submissionId: string; actorId: string; note: string },
): Promise<{ submissionId: string; status: 'rejected' }> {
  const note = input.note.trim();
  if (note === '') {
    throw new ValidationError('ต้องระบุเหตุผลที่ปฏิเสธ เพื่อให้สมาชิกทราบ');
  }

  const submission = await db.consignment_submissions.findUnique({
    where: { id: input.submissionId },
    select: { id: true, status: true },
  });
  if (!submission) {
    throw new NotFoundError('ไม่พบคำขอฝากขายนี้');
  }
  if (submission.status !== 'pending') {
    throw new ConflictError('คำขอนี้ถูกตัดสินไปแล้ว', 'SUBMISSION_NOT_PENDING');
  }

  await db.consignment_submissions.update({
    where: { id: submission.id },
    data: {
      status: 'rejected',
      decided_by_user_id: input.actorId,
      decided_at: new Date(),
      decision_note: note,
    },
  });

  await recordAudit(
    {
      action: 'consignment_submission_rejected',
      actorUserId: input.actorId,
      targetType: 'consignment_submission',
      targetId: submission.id,
      detail: { note },
    },
    db,
  );

  return { submissionId: submission.id, status: 'rejected' };
}

/** One attachment as a screen draws it. */
export interface SubmissionDocumentView {
  id: string;
  kind: ConsignmentDocumentKind;
  label: string;
  url: string;
  /**
   * False when the link is one this system would refuse to draw — a Drive *file*
   * link sent as a photo, for instance. The screen then shows a link rather than a
   * broken image, which is the honest rendering of a link nobody here can vouch for.
   */
  drawable: boolean;
}

export interface SubmissionView {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  productName: string;
  offeredPriceThb: number;
  quantity: number;
  notes: string | null;
  /** Never null: an offer belongs to the member who sent it. */
  consignorUserId: string;
  consignorName: string | null;
  /** The member's number, read from their account rather than copied onto the offer. */
  consignorPhone: string;
  submittedAt: string;
  decidedSharePercent: number | null;
  decisionNote: string | null;
  decidedAt: string | null;
  productId: string | null;
  documents: SubmissionDocumentView[];
}

/**
 * One row to one view.
 *
 * `drawPhotos` is a policy, not a formatting flag. The owner's inbox draws the
 * photographs, because deciding whether to take the goods on is partly a question of
 * what they look like. The member's own page does not: it lists what they sent as
 * links they can open, which keeps a member's account from loading a gallery of
 * thumbnails from a file host the shop chose.
 */
function toView(row: SubmissionRow, drawPhotos: boolean): SubmissionView {
  return {
    id: row.id,
    status: row.status,
    productName: row.product_name,
    offeredPriceThb: fromDecimal(row.offered_price_thb),
    quantity: row.quantity,
    notes: row.notes,
    consignorUserId: row.consignor_user_id,
    consignorName: row.consignor.full_name,
    consignorPhone: row.consignor.phone,
    submittedAt: row.submitted_at.toISOString(),
    decidedSharePercent: row.decided_share_percent,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    productId: row.product_id,
    documents: row.documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      label: document.label,
      url: document.url,
      drawable: drawPhotos && renderableImageUrl(document.url) !== null,
    })),
  };
}

type SubmissionRow = SubmissionProjection;

/** Everything a submission view needs, and nothing a screen must not see. */
const SUBMISSION_INCLUDE = {
  consignor: { select: { full_name: true, phone: true } },
  documents: {
    select: { id: true, kind: true, label: true, url: true },
    orderBy: { id: 'asc' as const },
  },
} as const;

type SubmissionProjection = {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  product_name: string;
  offered_price_thb: { toNumber(): number; toString(): string };
  quantity: number;
  notes: string | null;
  consignor_user_id: string;
  submitted_at: Date;
  decided_share_percent: number | null;
  decision_note: string | null;
  decided_at: Date | null;
  product_id: string | null;
  consignor: { full_name: string; phone: string };
  documents: { id: string; kind: 'photo' | 'document'; label: string; url: string }[];
};

/**
 * The owner's inbox: every offer waiting, newest first.
 *
 * Pending only, because this is a work list. An owner looking at "what is waiting for
 * me" and seeing last month's approved offers mixed in has to filter it in their head,
 * and the decision this screen drives is the decision about the pending ones.
 */
export async function listPendingSubmissions(
  db: Db,
  limit = OFFER_INBOX_LIMIT,
): Promise<SubmissionView[]> {
  const rows = await db.consignment_submissions.findMany({
    where: { status: 'pending' },
    include: SUBMISSION_INCLUDE,
    orderBy: { submitted_at: 'desc' },
    take: limit,
  });
  return rows.map((row) => toView(row, true));
}

/**
 * One member's own submissions, newest first.
 *
 * Scoped by the caller's id inside the query and nowhere else: there is no parameter
 * naming a member, so this cannot be asked for somebody else's offers. The same
 * property `loadCustomerConsignment` relies on, for the same reason.
 */
export async function listCustomerSubmissions(
  customerId: string,
  db: Db,
  limit = CUSTOMER_SUBMISSION_LIMIT,
): Promise<SubmissionView[]> {
  const rows = await db.consignment_submissions.findMany({
    where: { consignor_user_id: customerId },
    include: SUBMISSION_INCLUDE,
    orderBy: { submitted_at: 'desc' },
    take: limit,
  });
  return rows.map((row) => toView(row, false));
}

/**
 * The documents a member attached to one offer, for the product that offer became.
 *
 * Read by `product_id` and not through a join on the submission's status, because
 * "the paperwork behind this product" is a question about the product — and after the
 * product is renamed, recategorised or moved to another shelf it is still the same
 * paperwork.
 */
export async function listProductDocuments(productId: string, db: Db): Promise<SubmissionDocumentView[]> {
  const rows = await db.consignment_documents.findMany({
    where: { product_id: productId },
    select: { id: true, kind: true, label: true, url: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    url: row.url,
    drawable: renderableImageUrl(row.url) !== null,
  }));
}

