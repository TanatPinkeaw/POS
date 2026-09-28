/**
 * First-run setup (ADR 0002).
 *
 * This is the only endpoint in the system that writes without a session — it has
 * to be, because it creates the first account that could have one. Its safety
 * therefore rests on a single question, asked twice: *has a shop already been
 * created?*
 *
 *   1. Here, so the common case gets a readable 409 rather than a constraint error.
 *   2. In `initialiseSystem`'s transaction, where the singleton primary key
 *      decides it — because two simultaneous submissions both pass step 1.
 *
 * The proxy deliberately does not gate this path (it cannot query the database
 * from the edge runtime); `/setup` is public in `roles.ts`, and the page refuses
 * to render once the system is initialised.
 */
import { readJson, withApi } from '@/lib/api';
import { ConflictError } from '@/lib/errors';
import { setupSchema } from '@/lib/schemas';
import { hasShop } from '@/lib/shop';
import { initialiseSystem } from '@/lib/setup';

/** Whether this deployment still needs setting up. Drives the wizard's guard. */
export async function GET(): Promise<Response> {
  return withApi(async () => ({ initialized: await hasShop() }));
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    if (await hasShop()) {
      throw new ConflictError('This system has already been set up', 'ALREADY_INITIALISED');
    }

    const body = await readJson(request, setupSchema);
    const result = await initialiseSystem({
      shop: body.shop,
      admin: body.admin,
    });

    // The account is deliberately not echoed back: the caller already knows the
    // phone number and password they chose, and returning them would put a
    // credential in a response body and into any proxy log that records one.
    return { initialized: true, shop: result.shop, adminId: result.admin.id };
  });
}
