import type { NavItem } from '@/components/shell/AppShell';
import { AreaLayout } from '@/components/shell/AreaLayout';
import { requireShellUser } from '@/lib/shell';

const ADMIN_NAV: NavItem[] = [
  { href: '/admin/dashboard', label: 'แดชบอร์ด', icon: 'dashboard' },
  { href: '/admin/products', label: 'สินค้าและสต็อก', icon: 'box' },
  { href: '/admin/staff', label: 'พนักงาน', icon: 'users' },
  { href: '/admin/members', label: 'ลูกค้า', icon: 'user' },
  { href: '/admin/schedules', label: 'ตารางงาน & เวลา', icon: 'calendar' },
  { href: '/admin/reports', label: 'รายงาน & ส่งออก', icon: 'chart' },
  { href: '/admin/audit', label: 'ประวัติการใช้งาน', icon: 'eye' },
  { href: '/admin/settings', label: 'ตั้งค่าร้าน', icon: 'sliders' },
  { href: '/pos', label: 'หน้าร้าน (POS)', icon: 'cart' },
  { href: '/pos/preorders', label: 'พรีออเดอร์', icon: 'receipt', badgedByPreOrders: true },
];

/**
 * What a non-admin sees in this area (ADR 0022).
 *
 * The matrix opens `/admin/dashboard` and `/admin/reports` to an employee,
 * read-only; nothing else under `/admin` is theirs. The nav lists exactly that
 * grant plus the way onto the till, so a cashier is never shown a door the guard
 * would close — and the *pages* left off this list each refuse an employee
 * themselves, which is the enforcement rather than this menu.
 */
const EMPLOYEE_NAV: NavItem[] = [
  { href: '/admin/dashboard', label: 'แดชบอร์ด', icon: 'dashboard' },
  { href: '/admin/reports', label: 'รายงาน & ส่งออก', icon: 'chart' },
  { href: '/pos', label: 'หน้าร้าน (POS)', icon: 'cart' },
  { href: '/pos/preorders', label: 'พรีออเดอร์', icon: 'receipt', badgedByPreOrders: true },
];

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Employees reach this layout only for the two read-only pages the matrix grants
  // them (ADR 0022); every other admin page refuses them on its own.
  const user = await requireShellUser(['admin', 'employee']);
  return (
    <AreaLayout user={user} nav={user.role === 'admin' ? ADMIN_NAV : EMPLOYEE_NAV}>
      {children}
    </AreaLayout>
  );
}
