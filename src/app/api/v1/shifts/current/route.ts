import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { defaultInitialCash, getOpenShift, openShift } from '@/lib/cash-shifts';
import { prisma } from '@/lib/db';
import { openShiftSchema } from '@/lib/schemas';

/** The drawer this employee currently has open, if any. */
export async function GET(): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const shift = await getOpenShift(prisma, session.id);

    return {
      shift,
      defaultInitialCashThb: defaultInitialCash(),
    };
  });
}

/**
 * Opens a drawer with a starting float — SRS §6.2.
 *
 * The float defaults to the shop's usual amount rather than zero, because a
 * zero float silently turns the first sale's change into a shortage.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const body = await readJson(request, openShiftSchema);

    return openShift({
      userId: session.id,
      initialCash: body.initialCash ?? defaultInitialCash(),
    });
  });
}
