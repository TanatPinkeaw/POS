import type { NavItem } from '@/components/shell/AppShell';
import { AreaLayout } from '@/components/shell/AreaLayout';
import { requireShellUser } from '@/lib/shell';

const ADMIN_NAV: NavItem[] = [
  { href: '/admin/dashboard', label: 'แดชบอร์ด', icon: 'dashboard' },
  { href: '/admin/products', label: 'สินค้าและสต็อก', icon: 'box' },
  { href: '/admin/staff', label: 'พนักงาน', icon: 'users' },
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
  const user = await requireShellUser(['admin']);
  return (
    <AreaLayout user={user} nav={ADMIN_NAV}>
      {children}
    </AreaLayout>
  );
}
