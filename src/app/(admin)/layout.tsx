import type { NavItem } from '@/components/shell/AppShell';
import { AreaLayout } from '@/components/shell/AreaLayout';
import { canReachPage } from '@/lib/roles';
import { requireShellUser } from '@/lib/shell';

const ADMIN_NAV: NavItem[] = [
  { href: '/admin/dashboard', label: 'แดชบอร์ด', icon: 'dashboard' },
  { href: '/admin/products', label: 'สินค้าและสต็อก', icon: 'box' },
  { href: '/admin/consignors', label: 'ฝากขาย & จ่ายเงิน', icon: 'cash' },
  { href: '/admin/staff', label: 'พนักงาน', icon: 'users' },
  { href: '/admin/members', label: 'ลูกค้า', icon: 'user' },
  { href: '/admin/schedules', label: 'ตารางงาน & เวลา', icon: 'calendar' },
  { href: '/admin/reports', label: 'รายงาน & ส่งออก', icon: 'chart' },
  { href: '/admin/audit', label: 'ประวัติการใช้งาน', icon: 'eye' },
  { href: '/admin/settings', label: 'ตั้งค่าร้าน', icon: 'sliders' },
  { href: '/pos', label: 'หน้าร้าน (POS)', icon: 'cart' },
  { href: '/pos/preorders', label: 'พรีออเดอร์', icon: 'receipt', badgedByPreOrders: true },
];


export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Employees reach this layout only for the two read-only pages the matrix grants
  // them (ADR 0022); every other admin page refuses them on its own. The nav is the
  // full list *filtered by the same matrix the guard reads*, so a menu item and the
  // route it points at cannot disagree about who may see it — a hand-written employee
  // list would be a second answer to keep in step by hand.
  const user = await requireShellUser(['admin', 'employee']);
  const nav = ADMIN_NAV.filter((item) => canReachPage(user.role, item.href));
  return (
    <AreaLayout user={user} nav={nav}>
      {children}
    </AreaLayout>
  );
}
