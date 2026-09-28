import { AreaLayout } from '@/components/shell/AreaLayout';
import type { NavItem } from '@/components/shell/AppShell';
import { requireShellUser } from '@/lib/shell';

const SHOP_NAV: NavItem[] = [
  { href: '/shop/products', label: 'สินค้า', icon: 'box' },
  { href: '/shop/orders', label: 'ออเดอร์ของฉัน', icon: 'receipt' },
];

/**
 * SRS §2: members browse, reserve, and track their own orders.
 *
 * This is the one area that is *not* managed from a desk, and its density says so:
 * the member's phone. At compact density a control is 14px with a 34px tap target,
 * which is fine for a mouse and wrong for a thumb — iOS Safari zooms the viewport
 * when a 14px field takes focus, which hides the buttons the customer was about to
 * press. Touch density gives the same markup 16px fields and 48px targets, and the
 * quantity steppers add `ln-tap` on top because they are tapped repeatedly.
 */
export default async function ShopLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireShellUser(['member', 'employee', 'admin']);
  return (
    <AreaLayout user={user} nav={SHOP_NAV} density="touch">
      {children}
    </AreaLayout>
  );
}
