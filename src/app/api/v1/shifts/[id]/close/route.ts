import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { closeShift } from '@/lib/cash-shifts';
import { ValidationError } from '@/lib/errors';
import { REALTIME_EVENTS, emitToAdmins } from '@/lib/realtime';
import { closeShiftSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * SRS §6.2 — close the drawer and record the physical count.
 *
 * The response carries the discrepancy and its direction, so the till can show
 * a shortage or an overage without the client recomputing the formula.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const { id } = await context.params;
    const body = await readJson(request, closeShiftSchema);

    const shiftId = Number(id);
    if (!Number.isInteger(shiftId) || shiftId <= 0) {
      throw new ValidationError('รหัสลิ้นชักต้องเป็นจำนวนเต็ม');
    }

    const shift = await closeShift({
      shiftId,
      userId: session.id,
      actualCash: body.actualCash,
    });

    // A shortage or overage is an admin concern, not a till concern, so it goes
    // to the admin room rather than to everyone on the floor.
    if (shift.discrepancyKind && shift.discrepancyKind !== 'balanced') {
      emitToAdmins(REALTIME_EVENTS.shiftDiscrepancy, {
        shiftId: shift.id,
        kind: shift.discrepancyKind,
        discrepancyThb: shift.discrepancyThb,
        expectedCashThb: shift.expectedCashThb,
        actualCashThb: shift.actualCashThb,
      });
    }

    return shift;
  });
}
