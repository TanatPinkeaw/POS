/**
 * Opening the drawer with no sale behind it.
 *
 * Gated because it is the one drawer action that cannot be reconstructed from
 * the money: every other opening has a payment pointing at it, while this one
 * leaves only what it writes here. The approval is bound to the shift, so a PIN
 * given for this drawer cannot be spent on another one.
 */
import { readJson, withApi } from '@/lib/api';
import { recordDrawerOpening } from '@/lib/cash-shifts';
import { drawerOpenSchema } from '@/lib/schemas';
import { requireApproval } from '@/lib/supervisor';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const body = await readJson(request, drawerOpenSchema);

    const target = String(body.shiftId);
    const { actor, approverId } = await requireApproval(request, 'drawer_open', target);

    return recordDrawerOpening({
      shiftId: body.shiftId,
      openedByUserId: actor.id,
      authorizedByUserId: approverId,
      reason: body.reason ?? null,
    });
  });
}
