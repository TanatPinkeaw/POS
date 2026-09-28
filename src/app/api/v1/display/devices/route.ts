/**
 * Managing the shop's customer screens.
 *
 * Admin-only, because pairing a screen grants a permanent read of the shop's
 * takings and who is buying them. The list is safe to show a cashier — it is a
 * label and a last-seen time — but adding one is not.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { createPairingCode, listDisplayDevices } from '@/lib/display-devices';
import { displayDeviceSchema } from '@/lib/schemas';

export async function GET(): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    return { devices: await listDisplayDevices() };
  });
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const body = await readJson(request, displayDeviceSchema);
    return createPairingCode({ label: body.label ?? null, actorId: session.id });
  });
}
