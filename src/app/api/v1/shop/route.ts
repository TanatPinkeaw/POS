/**
 * Shop settings — read for staff, write for admins (ADR 0002).
 *
 * Reading is open to employees because the till has to print the shop's name and
 * tax id on a receipt; only an administrator can change them.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { ConflictError } from '@/lib/errors';
import { shopSettingsSchema } from '@/lib/schemas';
import { loadShop, updateShop } from '@/lib/shop';
import { UNCONFIGURED_SHOP } from '@/lib/shop-view';

export async function GET(): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);
    return (await loadShop()) ?? UNCONFIGURED_SHOP;
  });
}

export async function PUT(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);

    if ((await loadShop()) === null) {
      throw new ConflictError(
        'This system has not been set up yet; run the setup wizard first',
        'SHOP_NOT_CONFIGURED',
      );
    }

    const body = await readJson(request, shopSettingsSchema);
    return updateShop(body);
  });
}
