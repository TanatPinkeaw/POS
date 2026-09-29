/**
 * First-run setup (ADR 0002).
 *
 * The reason this is one function rather than two calls is the failure mode it
 * avoids: if the shop row were written and the administrator were not, the
 * deployment would be *closed* — `hasShop()` would report true, so the wizard
 * would refuse to run again — while nobody existed who could sign in to fix it.
 * The singleton primary key makes the shop row already written unrepeatable, so
 * the two writes have to share a transaction.
 */
import { prisma } from './db';
import { ConflictError } from './errors';
import { hashPassword } from './password';
import { normalisePhone } from './phone';
import { SHOP_ROW_ID, shopColumns, toShopView, type ShopSettingsInput } from './shop';
import type { ShopView } from './shop-view';
import { toStaffMember, type StaffMember } from './staff';

export interface SystemSetupInput {
  shop: ShopSettingsInput;
  admin: {
    fullName: string;
    phone: string;
    email?: string | null;
    password: string;
  };
}

export interface SystemSetupResult {
  shop: ShopView;
  admin: StaffMember;
}

/** Creates the shop and the first administrator, or neither. */
export async function initialiseSystem(input: SystemSetupInput): Promise<SystemSetupResult> {
  const passwordHash = await hashPassword(input.admin.password);
  const phone = normalisePhone(input.admin.phone);
  const email = blankToNull(input.admin.email);

  return prisma.$transaction(
    async (tx) => {
      let shopRow;
      try {
        shopRow = await tx.shops.create({
          data: { id: SHOP_ROW_ID, ...shopColumns(input.shop) },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Two wizard submissions raced, and this is the loser.
          throw new ConflictError('This system has already been set up', 'ALREADY_INITIALISED');
        }
        throw error;
      }

      let adminRow;
      try {
        adminRow = await tx.users.create({
          data: {
            full_name: input.admin.fullName.trim(),
            phone,
            email,
            password_hash: passwordHash,
            role: 'admin',
            is_active: true,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(
            `มีบัญชีที่ใช้ ${phone}${email ? ` หรือ ${email}` : ''} อยู่แล้ว — ลองใช้เบอร์อื่น`,
            'DUPLICATE_ACCOUNT',
          );
        }
        throw error;
      }

      return { shop: toShopView(shopRow), admin: toStaffMember(adminRow) };
    },
    { timeout: 30_000, maxWait: 30_000 },
  );
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}
