/**
 * Request schemas.
 *
 * Collecting them here keeps the shape of the API readable in one file, and
 * means a route handler is only ever concerned with what it does, not with
 * re-describing what a valid payload looks like.
 */
import { z } from 'zod';

export const loginSchema = z.object({
  /** Either a phone number or an email address. */
  identifier: z.string().trim().min(1, 'Enter your phone number or email'),
  password: z.string().min(1, 'Enter your password'),
});

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
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

export const orderListQuerySchema = z.object({
  status: z
    .enum(['pending', 'confirmed', 'ready_for_pickup', 'completed', 'cancelled'])
    .optional(),
  type: z.enum(['pos_walkin', 'preorder']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
