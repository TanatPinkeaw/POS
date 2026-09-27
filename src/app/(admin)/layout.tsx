import { AreaLayout } from '@/components/hope/AreaLayout';
import type { NavItem } from '@/components/hope/AppShell';
import { requireShellUser } from '@/lib/shell';

const ADMIN_NAV: NavItem[] = [
  { href: '/admin/dashboard', label: 'แดชบอร์ด', glyph: '▦' },
  { href: '/admin/products', label: 'สินค้าและสต็อก', glyph: '▤' },
  { href: '/pos', label: 'หน้าร้าน (POS)', glyph: '▣' },
  { href: '/pos/preorders', label: 'พรีออเดอร์', glyph: '◈', badgedByPreOrders: true },
];

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireShellUser(['admin']);
  return (
    <AreaLayout user={user} nav={ADMIN_NAV}>
      {children}
    </AreaLayout>
  );
}
