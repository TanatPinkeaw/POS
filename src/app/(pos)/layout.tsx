import { AreaLayout } from '@/components/shell/AreaLayout';
import type { NavItem } from '@/components/shell/AppShell';
import { requireShellUser } from '@/lib/shell';

const POS_NAV: NavItem[] = [
  { href: '/pos', label: 'ขายหน้าร้าน', icon: 'cart' },
  { href: '/pos/preorders', label: 'พรีออเดอร์', icon: 'receipt', badgedByPreOrders: true },
  { href: '/pos/attendance', label: 'ลงเวลาทำงาน', icon: 'clock' },
];

/**
 * The way back out of the till, for an administrator only.
 *
 * The admin nav offers `/pos` and `/pos/preorders`, so an owner can step onto the
 * counter from the back office — and until this existed there was no way back:
 * the till's own nav is three items long, none of them `/admin`, and the sidebar in
 * here is the only navigation there is. Leaving the area was a URL somebody had to
 * know.
 *
 * Administrators only. An employee who tapped this would be sent to `/login` by
 * `requireShellUser(['admin'])` — a nav item that logs a cashier out is worse than
 * a nav item that is not there.
 */
const ADMIN_RETURN: NavItem = {
  href: '/admin/dashboard',
  label: 'กลับหน้าจัดการ',
  icon: 'dashboard',
};

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
  const nav = user.role === 'admin' ? [...POS_NAV, ADMIN_RETURN] : POS_NAV;
  return (
    <AreaLayout user={user} nav={nav} density="touch" variant="till">
      {children}
    </AreaLayout>
  );
}
