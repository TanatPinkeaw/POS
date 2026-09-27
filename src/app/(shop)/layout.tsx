import { AreaLayout } from '@/components/hope/AreaLayout';
import type { NavItem } from '@/components/hope/AppShell';
import { requireShellUser } from '@/lib/shell';

const SHOP_NAV: NavItem[] = [
  { href: '/shop/products', label: 'สินค้า', glyph: '▤' },
  { href: '/shop/orders', label: 'ออเดอร์ของฉัน', glyph: '▦' },
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
