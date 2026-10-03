/**
 * `POST /api/v1/consignors/[id]/payouts` — settle what the shop owes a consignor.
 *
 * Admin-only, and that is the whole decision: this is money leaving the shop to
 * somebody outside it, and the person who owns the relationship is the owner. Unlike a
 * refund it asks for no supervisor PIN, because there is no cashier to override here —
 * the admin is the authority, and the audit row names them (ADR 0023 §6).
 *
 * Everything else lives in `payConsignor`: the balance check, the drawer rule for cash,
 * the statement row, the ledger debit and the audit row, all in one transaction. This
 * file is only the authorisation and the request shape.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { payConsignor } from '@/lib/consignment-payout';
import { prisma } from '@/lib/db';
import { consignmentPayoutSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const { id } = await context.params;
    const body = await readJson(request, consignmentPayoutSchema);

    return prisma.$transaction((tx) =>
      payConsignor(tx, {
        consignorUserId: id,
        amountThb: body.amountThb,
        method: body.method,
        shiftId: body.shiftId ?? null,
        note: body.note ?? null,
        actorId: session.id,
      }),
    );
  });
}
