/**
 * `PATCH /api/v1/auth/phone` — a customer moves their number, proving the new one
 * (ADR 0020 §5).
 *
 * The one self-service act this ticket adds, and it is deliberately the *hard* one.
 * Signing in is not re-proved (a customer checking their points should not read an
 * SMS), but changing a number always is: the number is the identity, so moving it is
 * the act that can capture a balance, and the proof is of the number being moved
 * *to*. The whole rule — including that a code for the old number is useless here and
 * that a number somebody else holds is refused — lives in `changeCustomerPhone`,
 * because it is a property of the data rather than of this surface.
 *
 * The session is re-issued once the write lands. The cookie names the phone, and a
 * token still carrying the old number would disagree with the row it describes — for
 * the change's own response, and for any screen that reads the claim before reloading
 * the user. Re-signing keeps the two in step at the instant of the change.
 */
import { readJson, withApi } from '@/lib/api';
import { requireActiveUser, startSession } from '@/lib/auth';
import { changeCustomerPhone } from '@/lib/identity';
import { homePathForRole } from '@/lib/roles';
import { customerPhoneChangeSchema } from '@/lib/schemas';

export async function PATCH(request: Request): Promise<Response> {
  return withApi(async () => {
    /* The live row, not just the token: a deactivated account must not move a number. */
    const { user } = await requireActiveUser();
    const { phone, code } = await readJson(request, customerPhoneChangeSchema);

    const customer = await changeCustomerPhone({ userId: user.id, newPhone: phone, code });

    await startSession({
      id: customer.id,
      role: 'member',
      fullName: customer.fullName,
      phone: customer.phone,
    });

    return {
      id: customer.id,
      role: 'member',
      fullName: customer.fullName,
      phone: customer.phone,
      pointsBalance: customer.pointsBalance,
      redirectTo: homePathForRole('member'),
    };
  });
}
