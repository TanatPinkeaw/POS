import { AreaLayout } from '@/components/shell/AreaLayout';
import type { NavItem } from '@/components/shell/AppShell';
import { requireShellUser } from '@/lib/shell';

const SHOP_NAV: NavItem[] = [
  { href: '/shop/products', label: 'สินค้า', icon: 'box' },
  { href: '/shop/orders', label: 'ออเดอร์ของฉัน', icon: 'receipt' },
];

/** SRS §2: members browse, reserve, and track their own orders. */
export default async function ShopLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireShellUser(['member', 'employee', 'admin']);
  return (
    <AreaLayout user={user} nav={SHOP_NAV}>
      {children}
    </AreaLayout>
  );
}
