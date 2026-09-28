/**
 * Staff accounts (ADR 0002).
 *
 * Admin-only in both directions. An employee who could create accounts could
 * create an admin and promote themselves, so this is one of the few surfaces
 * where the SRS's coarse role split really matters.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { staffCreateSchema } from '@/lib/schemas';
import { createStaff, listStaff } from '@/lib/staff';

export async function GET(): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    return listStaff();
  });
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const body = await readJson(request, staffCreateSchema);
    return createStaff(body);
  });
}
