import { AreaLayout } from '@/components/hope/AreaLayout';
import type { NavItem } from '@/components/hope/AppShell';
import { requireShellUser } from '@/lib/shell';

const POS_NAV: NavItem[] = [
  { href: '/pos', label: 'ขายหน้าร้าน', glyph: '▣' },
  { href: '/pos/preorders', label: 'พรีออเดอร์', glyph: '◈', badgedByPreOrders: true },
];

/** SRS §2: the POS terminal is for employees and admins. */
export default async function PosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireShellUser(['employee', 'admin']);
  return (
    <AreaLayout user={user} nav={POS_NAV}>
      {children}
    </AreaLayout>
  );
}
