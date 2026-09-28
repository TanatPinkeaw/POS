import { AreaLayout } from '@/components/shell/AreaLayout';
import type { NavItem } from '@/components/shell/AppShell';
import { requireShellUser } from '@/lib/shell';

const POS_NAV: NavItem[] = [
  { href: '/pos', label: 'ขายหน้าร้าน', icon: 'cart' },
  { href: '/pos/preorders', label: 'พรีออเดอร์', icon: 'receipt', badgedByPreOrders: true },
  { href: '/pos/attendance', label: 'ลงเวลาทำงาน', icon: 'clock' },
];

/**
 * SRS §2: the POS terminal is for employees and admins.
 *
 * The one area that runs at `touch`: it is used on a tablet on a counter, with a
 * thumb, often while looking at the customer, so its controls are 48px and up and
 * its type is 16px. The till variant also gives the selling area the whole
 * viewport instead of padding it like a document.
 */
export default async function PosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireShellUser(['employee', 'admin']);
  return (
    <AreaLayout user={user} nav={POS_NAV} density="touch" variant="till">
      {children}
    </AreaLayout>
  );
}
