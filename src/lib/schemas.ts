/**
 * Request schemas.
 *
 * Collecting them here keeps the shape of the API readable in one file, and
 * means a route handler is only ever concerned with what it does, not with
 * re-describing what a valid payload looks like.
 */
import { z } from 'zod';

import { AUDIT_ACTIONS, AUDIT_PAGE_SIZE_MAX } from './audit-view';
import { isClock, isLocalDateTime, isValidCalendarDay } from './bangkok-time';
import { MAX_SHARE_PERCENT, MIN_SHARE_PERCENT } from './consignment-rules';
import { MAX_BLOCK_SIZE } from './number-block';
import { REPORT_TYPES } from './report-spec';
import { PROMPTPAY_ID_TYPES, normalisePromptPayId } from './promptpay';
import { PIN_LENGTH, SUPERVISOR_ACTIONS } from './supervisor-view';

export const loginSchema = z.object({
  /** Either a phone number or an email address. */
  identifier: z.string().trim().min(1, 'Enter your phone number or email'),
  password: z.string().min(1, 'Enter your password'),
});

/**
 * The number to send a sign-in OTP to (ADR 0020 §5).
 *
 * Trimmed and length-bounded, not shape-checked: this door is also the one a
 * first-time customer uses to prove a number we have never seen, so it must accept
 * a number in any of the forms people write them, and the same loose `.max(20)` the
 * counter's enrolment uses. Whether the number is already a customer is a question
 * for later (ticket 02), not a reason to refuse the send.
 */
export const otpSendSchema = z.object({
  phone: z.string().trim().min(1, 'Enter a phone number').max(20),
});

/** A Google id token from the browser, to be verified in-process (ADR 0020 §6). */
export const googleSignInSchema = z.object({
  idToken: z.string().trim().min(1, 'A Google credential is required'),
});

/**
 * The second half of a first Google sign-in: the id token and the phone.
 *
 * Both halves travel together on purpose. The id token is re-verified here rather
 * than held in a half-signed-up state on the server, so there is no window in which a
 * "pending" Google identity exists without a phone to anchor it.
 *
 * `phone` is optional because only a *first* sign-in needs one: a Google account that
 * already resolves to a customer signs in without touching a number, so a caller that
 * knows that must not be forced to invent one. When it is needed and absent,
 * `identity.ts` is what refuses, in Thai.
 */
export const googleSignupSchema = z.object({
  idToken: z.string().trim().min(1, 'A Google credential is required'),
  phone: z.string().trim().max(20).optional(),
  fullName: z.string().trim().min(1).max(100).optional(),
  /**
   * The privacy notice the customer read, checked against the current version in
   * `identity.ts`.
   *
   * Shaped as a loose string rather than refined to the exact version here, on purpose.
   * A schema that pinned the current version would answer "malformed" to a stale page —
   * a wrong kind of wrong, telling the browser its request was nonsense rather than that
   * the shop has a newer notice to read. The version lives in one place
   * (`privacy-notice.ts`) and the refusal there can say so in Thai.
   */
  noticeVersion: z.string().trim().max(10).optional(),
});

/**
 * A customer moving their own number to a new one (ADR 0020 §5).
 *
 * The new number and the code that proves it travel together, so there is no window
 * in which a number is recorded but unproved: the code is checked against the *new*
 * number, and nothing is written until it matches. The old number is never in the
 * body — it is whatever the signed-in customer's row already is, because a caller
 * does not get to name the identity they are moving.
 */
export const customerPhoneChangeSchema = z.object({
  phone: z.string().trim().min(1, 'Enter a phone number').max(20),
  code: z.string().trim().min(1, 'Enter the code').max(10),
});

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const categoryRenameSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

// ------------------------------------------------------ shop & staff (ADR 0002)

const optionalEmail = z
  .string()
  .trim()
  .max(255)
  .nullable()
  .optional()
  .refine(
    (value) =>
      value === undefined || value === null || value === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
    'That does not look like an email address',
  );

/**
 * Shop identity and tax settings.
 *
 * `pricesIncludeVat` is accepted only so it can be *refused* explicitly: the
 * sale path cannot yet derive the tax from an exclusive price without changing
 * what the customer owes (see ADR 0002), and silently storing the mode would put
 * a wrong figure on a tax document. A clear 422 beats that.
 */
export const shopSettingsSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter the shop name').max(150),
    legalName: z.string().trim().max(200).nullable().optional(),
    branchLabel: z.string().trim().max(100).nullable().optional(),
    taxId: z.string().trim().max(13).nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    isVatRegistered: z.boolean(),
    vatRate: z.number().min(0).max(100),
    receiptPrefix: z.string().trim().min(1).max(10),
    receiptFooter: z.string().trim().max(500).nullable().optional(),
    logoUrl: z.string().trim().max(2048).nullable().optional(),
    pricesIncludeVat: z.boolean().optional(),
    /**
     * Past this, a discount needs a supervisor PIN. Optional in the schema so
     * the setup wizard can omit it and let the column's own default apply.
     */
    supervisorDiscountLimitThb: z.number().min(0).max(100_000).optional(),
    /** Where the shop receives PromptPay transfers; enables the till's QR. */
    promptpayId: z.string().trim().max(20).nullable().optional(),
    promptpayType: z.enum(PROMPTPAY_ID_TYPES).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.pricesIncludeVat === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['pricesIncludeVat'],
        message:
          'VAT-exclusive pricing is not supported yet — set prices to include VAT',
      });
    }

    const taxId = value.taxId?.trim() ?? '';
    if (taxId !== '' && !/^\d{13}$/.test(taxId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['taxId'],
        message: 'A Thai tax ID is exactly 13 digits',
      });
    }
    if (value.isVatRegistered && taxId === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['taxId'],
        message: 'A VAT-registered shop must record its 13-digit tax ID on every receipt',
      });
    }

    if (value.vatRate === 0 && value.isVatRegistered) {
      ctx.addIssue({
        code: 'custom',
        path: ['vatRate'],
        message: 'A VAT-registered shop cannot charge a 0% rate',
      });
    }

    /*
     * Half a PromptPay setting is worse than none: an id with no kind cannot be
     * turned into a payload, and a kind with no id would make the till think it
     * could issue a QR. Clearing both is the way to say "no PromptPay".
     */
    const promptpayId = value.promptpayId?.trim() ?? '';
    if (promptpayId !== '' && !value.promptpayType) {
      ctx.addIssue({
        code: 'custom',
        path: ['promptpayType'],
        message: 'เลือกประเภทพร้อมเพย์ (เบอร์มือถือ / เลขบัตรประชาชน / e-Wallet) ด้วย',
      });
    }
    if (value.promptpayType && promptpayId === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['promptpayId'],
        message: 'กรอกเลขพร้อมเพย์ หรือเว้นทั้งสองช่องว่างเพื่อปิดการออก QR',
      });
    }
    if (promptpayId !== '' && value.promptpayType) {
      // Reuses the builder's own rule, so a value the payload cannot carry is
      // refused at the form rather than at the first sale that needs a QR.
      try {
        normalisePromptPayId(value.promptpayType, promptpayId);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['promptpayId'],
          message: error instanceof Error ? error.message : 'เลขพร้อมเพย์ไม่ถูกต้อง',
        });
      }
    }
  });

/**
 * A staff account. The password ceiling is 72 because bcrypt silently ignores
 * anything past 72 bytes, and a password that is only half-checked is a trap.
 */
export const staffCreateSchema = z.object({
  fullName: z.string().trim().min(1, 'Enter a name').max(100),
  phone: z.string().trim().min(1, 'Enter a phone number').max(20),
  email: optionalEmail,
  role: z.enum(['employee', 'admin']),
  password: z.string().min(8, 'A password must be at least 8 characters').max(72),
});

export const staffUpdateSchema = z.object({
  fullName: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().min(1).max(20).optional(),
  email: optionalEmail,
  role: z.enum(['employee', 'admin']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8, 'A password must be at least 8 characters').max(72).optional(),
});

// ------------------------------------------------ customers (ADR 0010)

/**
 * Creating a customer at the counter.
 *
 * No `role`, deliberately: there is no shape of this request that should produce
 * anything but a member, and a field the server ignores is a field somebody will
 * eventually believe.
 */
export const memberCreateSchema = z.object({
  fullName: z.string().trim().min(1, 'Enter a name').max(100),
  phone: z.string().trim().min(1, 'Enter a phone number').max(20),
  email: optionalEmail,
  password: z.string().min(8, 'A password must be at least 8 characters').max(72),
});

/**
 * Editing one. Every field is optional because the screen patches one thing at a
 * time, and an absent password means "leave it alone" rather than "blank it".
 */
export const memberUpdateSchema = z.object({
  fullName: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().min(1).max(20).optional(),
  email: optionalEmail,
  isActive: z.boolean().optional(),
  password: z.string().min(8, 'A password must be at least 8 characters').max(72).optional(),
});

/**
 * First-run setup.
 *
 * The wizard writes the shop and its first administrator in one request, because
 * a shop with nobody able to sign in is not a usable state and two requests
 * would create a window where it exists.
 */
export const setupSchema = z.object({
  shop: shopSettingsSchema,
  admin: z.object({
    fullName: z.string().trim().min(1, 'Enter a name').max(100),
    phone: z.string().trim().min(1, 'Enter a phone number').max(20),
    email: optionalEmail,
    password: z.string().min(8, 'A password must be at least 8 characters').max(72),
  }),
});

export const productCreateSchema = z.object({
  name: z.string().trim().min(1).max(150),
  categoryId: z.number().int().positive().nullable().optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  description: z.string().trim().nullable().optional(),
  costPrice: z.number().min(0),
  salePrice: z.number().min(0),
  stockQty: z.number().int().min(0).default(0),
  /**
   * The offline reserve (ADR 0019). Validated here as well as by the column's CHECK, so a
   * negative number is a Thai field error rather than a 500 from a refused constraint.
   */
  offlineSafetyQty: z.number().int().min(0).default(0),
  imageUrl: z.string().trim().max(2048).nullable().optional(),
  isActive: z.boolean().default(true),
});

export const productUpdateSchema = productCreateSchema.partial();

/**
 * Putting a product into consignment, or re-agreeing its terms (ADR 0023).
 *
 * Both halves are required and travel together: a consignor with no share is a liability
 * the shop cannot settle, and a share with no consignor is a percentage owed to nobody.
 * The database refuses the half-state with a CHECK; this refuses it earlier, as a Thai
 * field error rather than a 500 from a constraint. The range is the rule module's own
 * constants, so the form and the arithmetic cannot disagree about what 100% means.
 */
export const consignmentTermsSchema = z.object({
  consignorUserId: z.string().uuid(),
  sharePercent: z
    .number()
    .int()
    .min(MIN_SHARE_PERCENT)
    .max(MAX_SHARE_PERCENT),
});

/**
 * Taking unsold goods back. The note is optional but the field exists because "why"
 * is the only thing the record cannot reconstruct: the stock movement says how many
 * units left, and this says whether it was the end of the arrangement or a recall.
 */
export const consignmentWithdrawalSchema = z.object({
  note: z.string().trim().max(500).nullable().optional(),
});

/**
 * Paying a consignor what the shop owes them (ADR 0023 §6).
 *
 * The amount is positive — a payout moves money — and the method is the two doors money
 * actually leaves through: the drawer or the shop's own banking app. `shiftId` is only
 * meaningful for cash, and the library refuses cash without an open drawer regardless of
 * what arrives here, so this is a shape check rather than the rule.
 */
export const consignmentPayoutSchema = z.object({
  amountThb: z.number().positive().max(9_999_999_999.99),
  method: z.enum(['cash', 'promptpay']),
  shiftId: z.number().int().positive().nullable().optional(),
  note: z.string().trim().max(255).nullable().optional(),
});

/**
 * SRS §4.3: a manual adjustment is only accepted with an enumerated reason, so
 * an unexplained stock change cannot enter the audit trail.
 */
export const stockAdjustmentSchema = z.object({
  productId: z.string().uuid(),
  delta: z
    .number()
    .int()
    .refine((value) => value !== 0, 'A stock adjustment must change the count'),
  reason: z.enum(['REASON_RESTOCK', 'REASON_DAMAGED', 'REASON_EXPIRED', 'REASON_CORRECTION']),
  note: z.string().trim().max(500).nullable().optional(),
});

export const cartLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

export const settlementSchema = z.object({
  cash: z.number().min(0).optional(),
  promptpay: z.number().min(0).optional(),
  points: z.number().int().min(0).optional(),
  receivedCash: z.number().min(0).optional(),
});

/**
 * A number the till printed out of its own borrowed block.
 *
 * Both halves are required — the number and which loan it came from — because the number
 * alone cannot be judged: `12` is a valid call number in every block the shop has ever
 * lent, and only the block says whether it is this device's to use. The id is parsed as a
 * UUID rather than a free string so that a malformed one is a 422 at the edge instead of
 * a cast error inside a transaction, which would reach the till as a 500.
 */
const deviceNumberClaimSchema = z.object({
  blockId: z.string().uuid(),
  value: z.number().int().positive(),
});

export const deviceNumbersSchema = z.object({
  receipt: deviceNumberClaimSchema.optional(),
  call: deviceNumberClaimSchema.optional(),
});

export const posSaleSchema = z.object({
  type: z.literal('pos_walkin'),
  lines: z.array(cartLineSchema).min(1, 'Add at least one item'),
  customerId: z.string().uuid().nullable().optional(),
  shiftId: z.number().int().positive(),
  discountThb: z.number().min(0).optional(),
  settlement: settlementSchema,
  /** Numbers the till printed itself, when it is holding a borrowed block (ADR 0019). */
  deviceNumbers: deviceNumbersSchema.optional(),
});

/**
 * A walk-in sale carrying a paid PromptPay intent.
 *
 * The reference is the only thing the client sends about the payment: the amount,
 * the cashier and the drawer all come from the intent's own row, so a tampered
 * client cannot claim a ฿10 transfer paid a ฿1000 bill.
 */
const intentRefField = z.string().trim().min(1).max(12).optional();

export const preOrderSchema = z.object({
  type: z.literal('preorder'),
  lines: z.array(cartLineSchema).min(1, 'Add at least one item'),
});

/**
 * How much one replay may carry, and how many loans it may close.
 *
 * A ceiling rather than a policy: the request is a JSON body holding a week of a shop's
 * bills, and an unbounded one is a way to make the server allocate an arbitrary amount of
 * memory. A device with more queued than this sends them in batches, in sequence — which is
 * the order it has to send them in anyway, because a replay stops at the first bill it
 * cannot record.
 */
export const OFFLINE_SYNC_MAX_BILLS = 500;
export const OFFLINE_SYNC_MAX_REPORTS = 20;

/**
 * One queued bill, as the device holds it (ADR 0019).
 *
 * Every figure here is the customer's slip: the price per line, the tax split, the total,
 * the cash handed over. That is unusual for a request body — this repository's habit is to
 * send a product id and let the server price it — and it is the point of a replay. The
 * offline sale was priced by the same pure modules against the shop's published settings,
 * the customer paid those figures, and a server that re-priced it from today's catalogue
 * would be writing a record that disagrees with the paper in somebody's hand.
 */
const offlineBillSchema = z.object({
  fulfilment: z.enum(['preparing', 'ready', 'collected']).optional(),
  /** The bill's identity as the device minted it — what makes the replay idempotent. */
  clientRef: z.string().uuid(),
  sequence: z.number().int().positive(),
  /** When the device sold it. The server files the bill under this instant. */
  soldAt: z.string().datetime({ offset: true }),
  /** The day the device filed it under, kept so a disagreement can be reported. */
  soldDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'soldDay must be YYYY-MM-DD'),
  /** The notes and coins handed over; the amount *applied* is `totalThb`. */
  receivedThb: z.number().min(0),
  totalThb: z.number().positive(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive(),
        unitPrice: z.number().min(0),
      }),
    )
    .min(1, 'A bill needs at least one line'),
  /** Present only when the device was holding a borrowed range. */
  numbers: deviceNumbersSchema.optional(),
  tax: z.object({
    isVatInvoice: z.boolean(),
    vatRatePercent: z.number().min(0).nullable(),
    netThb: z.number().min(0),
    vatThb: z.number().min(0),
  }),
});

/**
 * The offline replay: everything a device is holding, and every loan it wants closed.
 *
 * One request for both halves, because they are one fact. A report says "I counted through
 * N", and N is only true if every number up to N is on the server as a bill — so the bills
 * and the report travel together and the server decides what it may close.
 */
export const offlineSyncSchema = z.object({
  /** The drawer the bills were sold under. */
  shiftId: z.number().int().positive(),
  bills: z.array(offlineBillSchema).max(OFFLINE_SYNC_MAX_BILLS).default([]),
  reports: z
    .array(
      z.object({
        blockId: z.string().uuid(),
        /** `report` counts through a number; `cancel` hands a block back untouched. */
        mode: z.enum(['report', 'cancel']).default('report'),
        /** Required by `report`, meaningless for `cancel`. */
        lastUsed: z.number().int().positive().optional(),
      }),
    )
    .max(OFFLINE_SYNC_MAX_REPORTS)
    .default([]),
});

export const posSaleWithIntentSchema = posSaleSchema.extend({ intentRef: intentRefField });

export const createOrderSchema = z.discriminatedUnion('type', [
  posSaleWithIntentSchema,
  preOrderSchema,
]);

export const confirmOrderSchema = z.object({
  removeItemIds: z.array(z.string().min(1)).optional(),
});

/**
 * The call board's one control (ADR 0018).
 *
 * The two values are the state machine's own action names — the edges out of
 * `preparing` and `ready` in `fulfilment-state.ts` — rather than a free string, so
 * an unknown tap is refused at the edge instead of arriving at the machine as a
 * programming mistake.
 */
export const fulfilmentActionSchema = z.object({
  action: z.enum(['mark_ready', 'collect']),
});

/**
 * A device asking to borrow a range of numbers (ADR 0019).
 *
 * The size is capped by the same constant the pure module uses, because a borrowed block
 * freezes the shop's series until it is reported and a large one is therefore a mistake
 * with consequences rather than a harmless request.
 */
export const openNumberBlockSchema = z.object({
  id: z.string().uuid().optional(),
  series: z.enum(['receipt', 'queue']),
  day: z
    .string()
    .refine(isValidCalendarDay, 'A call-number block names a calendar day')
    .nullish(),
  size: z.number().int().min(1).max(MAX_BLOCK_SIZE),
  deviceLabel: z.string().trim().min(1).max(60),
});

/**
 * Closing a borrowed range: how far a device got, or that it printed nothing.
 *
 * One payload for both moves, because they are one decision — a block either has used
 * numbers or it has none, and the migration's CHECK constraints say the same thing. A
 * cancel that carried a `lastUsed` would be a caller describing a state that cannot
 * exist.
 */
export const closeNumberBlockSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('report'), lastUsed: z.number().int().positive() }),
  z.object({ action: z.literal('cancel') }),
]);

export const completeOrderSchema = z.object({
  shiftId: z.number().int().positive(),
  settlement: settlementSchema,
});

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/**
 * A refund of a completed sale.
 *
 * `refundMethod` is required rather than inferred from how the bill was paid,
 * because those are different facts and the drawer depends on this one: a bill
 * paid by transfer is very often refunded in cash, and writing that as a
 * `promptpay` leg would tell the reconciliation a bank moved money it never did.
 *
 * `shiftId` is required for a cash refund only, and the domain refuses the cash
 * case without an open drawer — so it is optional here and checked where the
 * drawer can actually be read.
 */
/**
 * Reversing a paid sale, wholly or in part.
 *
 * `lines` is what makes a refund partial. Omitting it means "everything still
 * outstanding", which is what a full refund has always meant and what the till
 * sends when the cashier does not pick the bill apart — so a caller that has not
 * been taught about partial refunds keeps working, unchanged.
 */
export const refundOrderSchema = z.object({
  lines: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1, 'Name at least one line to take back')
    .optional(),
  reason: z.string().trim().min(1, 'บอกเหตุผลการคืนเงิน').max(500),
  refundMethod: z.enum(['cash', 'promptpay']),
  shiftId: z.number().int().positive().nullable().optional(),
});

/**
 * Finding the parcel a customer is standing in front of.
 *
 * Four ways in, and each exists for a reason: the four-digit PIN (read aloud, typed
 * by hand), the QR the customer shows (SRS §3, scanned — see `pickup-token.ts`),
 * the order id (the staff board, which already has it), and the registered phone
 * number (the customer who lost the slip entirely).
 */
export const handoverLookupSchema = z.object({
  pin: z.string().trim().regex(/^\d{4}$/, 'A pickup PIN is 4 digits').optional(),
  orderId: z.string().uuid().optional(),
  phone: z.string().trim().min(1).optional(),
  pickupToken: z.string().trim().min(20).max(2000).optional(),
});

export const openShiftSchema = z.object({
  /** Defaults to the shop's usual float when omitted. */
  initialCash: z.number().min(0).optional(),
});

export const closeShiftSchema = z.object({
  actualCash: z.number().min(0),
});

// ---------------------------------------------------- attendance & roster

const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine(isValidCalendarDay, 'That calendar day does not exist');

const clockTime = z.string().refine(isClock, 'Use the format HH:MM (24-hour)');

/**
 * The 4-digit-ish time an employee gives when they arrive or leave. The note is
 * free text because reality is: "came back from delivery", "covered the till".
 */
export const attendanceClockSchema = z.object({
  note: z.string().trim().max(500).nullable().optional(),
});

/** Shared filter for the attendance and roster lists. */
export const attendanceQuerySchema = z.object({
  from: calendarDay.optional(),
  to: calendarDay.optional(),
  employeeId: z.string().uuid().optional(),
});

/**
 * A roster entry. `startTime`/`endTime` are wall-clock `HH:MM` strings rather
 * than instants, because a shift is a statement about the clock on the wall —
 * storing it as a timestamp would make the same roster shift mean different
 * things in different timezones.
 */
export const scheduleUpsertSchema = z.object({
  employeeId: z.string().uuid(),
  shiftDate: calendarDay,
  startTime: clockTime,
  endTime: clockTime,
  note: z.string().trim().max(500).nullable().optional(),
});

/**
 * An admin back-filled timesheet row. `checkIn` is an `<input
 * type="datetime-local">` value, read as Bangkok time — see
 * `parseBangkokLocalDateTime`, because the browser sends no timezone.
 */
export const manualLogSchema = z.object({
  employeeId: z.string().uuid(),
  checkIn: z.string().refine(isLocalDateTime, 'Use the format YYYY-MM-DDTHH:MM'),
  checkOut: z
    .string()
    .refine(isLocalDateTime, 'Use the format YYYY-MM-DDTHH:MM')
    .nullable()
    .optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

/**
 * SRS §8: the export endpoint is addressed by report type plus an inclusive
 * `from`/`to` calendar range. Both dates are optional so the admin screen can
 * open on a sensible default (the trailing 30 days) without special-casing.
 */
export const reportQuerySchema = z.object({
  type: z.enum(REPORT_TYPES),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD').optional(),
});

export const orderListQuerySchema = z.object({
  status: z
    .enum(['pending', 'confirmed', 'ready_for_pickup', 'completed', 'cancelled', 'refunded'])
    .optional(),
  type: z.enum(['pos_walkin', 'preorder']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ------------------------------------------------- supervisor approval

/**
 * A PIN as it arrives over the wire.
 *
 * Only the shape is checked here: it is a string of the right length, not a
 * number, because `0123` is a valid PIN and `123` as a number is not a thing a
 * form can send. The rules about which four digits are allowed live in
 * `pinProblem`, which the dialog also runs so the cashier sees the problem
 * before the round trip.
 */
export const supervisorPinSchema = z.object({
  pin: z.string().regex(/^\d{4}$/, `PIN ต้องเป็นตัวเลข ${PIN_LENGTH} หลัก`),
});

export const approvalRequestSchema = z.object({
  supervisorId: z.string().uuid(),
  pin: z.string().regex(/^\d{4}$/, `PIN ต้องเป็นตัวเลข ${PIN_LENGTH} หลัก`),
  action: z.enum(SUPERVISOR_ACTIONS),
  /**
   * What the approval is for: an order id, or the discount amount as a string.
   * Required even when there is nothing to point at yet, so that a token can
   * never authorise "anything" — an empty target is still a target.
   */
  targetId: z.string().trim().min(1).max(60),
  shiftId: z.coerce.number().int().positive().nullable().optional(),
});

/**
 * A no-sale drawer opening. The reason is optional but the field exists because
 * "why" is the only thing the record cannot reconstruct from the money: there is
 * no money.
 */
export const drawerOpenSchema = z.object({
  shiftId: z.coerce.number().int().positive(),
  reason: z.string().trim().max(200).nullable().optional(),
});

/**
 * A QR for the amount currently due.
 *
 * The amount is sent rather than derived from an order, because the order does
 * not exist yet — see `payment-intents.ts`. The server rounds and refuses a
 * non-positive value; the ceiling is a sanity bound, not a business rule.
 */
export const createIntentSchema = z.object({
  shiftId: z.coerce.number().int().positive(),
  amountThb: z.number().positive().max(1_000_000),
});

/** What the customer screen posts back once an admin has shown it a code. */
export const displayPairSchema = z.object({
  code: z.string().trim().min(6).max(6),
});

/** Naming a screen, so a list of three of them is not three identical rows. */
export const displayDeviceSchema = z.object({
  label: z.string().trim().min(1).max(60).nullable().optional(),
});

/** The bill being rung up, pushed to the customer display. */
export const displayCartSchema = z.object({
  lines: z
    .array(
      z.object({
        name: z.string().trim().max(200),
        quantity: z.number().int().positive(),
        totalPrice: z.number(),
      }),
    )
    .max(200),
  subtotalThb: z.number(),
  discountThb: z.number(),
  totalThb: z.number(),
  receivedThb: z.number().nullable().optional(),
  changeThb: z.number().nullable().optional(),
  memberFirstName: z.string().trim().max(60).nullable().optional(),
});

/**
 * A bank notification, as a bridge on the shop's own network posts it.
 *
 * `amountThb` is nullable on purpose: a bridge that cannot read a number out of
 * this bank's wording posts what it has rather than dropping the money, and the
 * transfer is filed as unreadable. `receivedAt` is the bank's own instant, so a
 * notification delayed in a mailbox is still judged by when the money moved.
 */
export const inboundTransferSchema = z.object({
  amountThb: z.number().positive().max(1_000_000).nullable().optional(),
  /**
   * Generous on purpose. A bank's notification is often a whole HTML email with
   * tracking markup around two useful lines, and a cap the bridge could exceed
   * would make that message unpostable — and therefore retried forever.
   */
  text: z.string().max(20_000).default(''),
  source: z.string().trim().min(1).max(40).default('bank-bridge'),
  externalId: z.string().trim().min(1).max(200).nullable().optional(),
  receivedAt: z.coerce.date().optional(),
});

/** Closing a transfer as not ours. The reason is required; see the route. */
export const dismissInboundSchema = z.object({
  reason: z.string().trim().min(1).max(300),
});

export const auditQuerySchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX).optional(),
  beforeId: z.string().regex(/^\d+$/, 'beforeId must be a numeric id').optional(),
});
