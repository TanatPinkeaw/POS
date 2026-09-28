/**
 * Request schemas.
 *
 * Collecting them here keeps the shape of the API readable in one file, and
 * means a route handler is only ever concerned with what it does, not with
 * re-describing what a valid payload looks like.
 */
import { z } from 'zod';

import { isClock, isLocalDateTime, isValidCalendarDay } from './bangkok-time';
import { REPORT_TYPES } from './report-spec';

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

export const preOrderSchema = z.object({
  type: z.literal('preorder'),
  lines: z.array(cartLineSchema).min(1, 'Add at least one item'),
});

export const createOrderSchema = z.discriminatedUnion('type', [posSaleSchema, preOrderSchema]);

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
    .enum(['pending', 'confirmed', 'ready_for_pickup', 'completed', 'cancelled'])
    .optional(),
  type: z.enum(['pos_walkin', 'preorder']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
