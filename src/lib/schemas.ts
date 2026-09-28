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
import { REPORT_TYPES } from './report-spec';
import { PROMPTPAY_ID_TYPES, normalisePromptPayId } from './promptpay';
import { PIN_LENGTH, SUPERVISOR_ACTIONS } from './supervisor-view';

export const loginSchema = z.object({
  /** Either a phone number or an email address. */
  identifier: z.string().trim().min(1, 'Enter your phone number or email'),
  password: z.string().min(1, 'Enter your password'),
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
  imageUrl: z.string().trim().max(2048).nullable().optional(),
  isActive: z.boolean().default(true),
});

export const productUpdateSchema = productCreateSchema.partial();

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

export const posSaleSchema = z.object({
  type: z.literal('pos_walkin'),
  lines: z.array(cartLineSchema).min(1, 'Add at least one item'),
  customerId: z.string().uuid().nullable().optional(),
  shiftId: z.number().int().positive(),
  discountThb: z.number().min(0).optional(),
  settlement: settlementSchema,
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

export const posSaleWithIntentSchema = posSaleSchema.extend({ intentRef: intentRefField });

export const createOrderSchema = z.discriminatedUnion('type', [
  posSaleWithIntentSchema,
  preOrderSchema,
]);

export const confirmOrderSchema = z.object({
  removeItemIds: z.array(z.string().min(1)).optional(),
});

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
export const refundOrderSchema = z.object({
  reason: z.string().trim().min(1, 'บอกเหตุผลการคืนเงิน').max(500),
  refundMethod: z.enum(['cash', 'promptpay']),
  shiftId: z.number().int().positive().nullable().optional(),
});

export const handoverLookupSchema = z.object({
  pin: z.string().trim().regex(/^\d{4}$/, 'A pickup PIN is 4 digits').optional(),
  orderId: z.string().uuid().optional(),
  phone: z.string().trim().min(1).optional(),
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

export const auditQuerySchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX).optional(),
  beforeId: z.string().regex(/^\d+$/, 'beforeId must be a numeric id').optional(),
});
