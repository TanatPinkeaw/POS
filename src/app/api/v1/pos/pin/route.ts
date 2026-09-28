/**
 * A supervisor's own PIN.
 *
 * Admin-only in every direction, which is a rule about *holding* the credential
 * rather than about changing it: a PIN is the ability to approve your own voids
 * and discounts, so giving one to an employee would hand them the exact control
 * the PIN exists to withhold. `setSupervisorPin` enforces that on the role of the
 * account being given the PIN, not on the caller, so it cannot be bypassed by
 * reaching this route as a different admin.
 *
 * An admin may set or clear another admin's PIN by passing `userId` — that is how
 * a shop recovers when the owner forgets theirs and the second admin is standing
 * right there. It is audited either way, and the trail distinguishes the two.
 *
 * Note what is *not* here: no endpoint returns a PIN, and none can. The column
 * holds a bcrypt hash and the API has no way to read it back, which is the same
 * property the password column has had all along.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { supervisorPinSchema } from '@/lib/schemas';
import { clearSupervisorPin, setSupervisorPin, supervisorStatus } from '@/lib/supervisor';

/** The caller's own PIN state — enough for the settings screen to show it. */
export async function GET(): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    return supervisorStatus(session.id);
  });
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const body = await readJson(request, supervisorPinSchema);
    return setSupervisorPin({
      userId: session.id,
      pin: body.pin,
      actorId: session.id,
    });
  });
}

export async function DELETE(): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    return clearSupervisorPin({ userId: session.id, actorId: session.id });
  });
}
