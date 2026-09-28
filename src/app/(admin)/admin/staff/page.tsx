import { StaffManager, type StaffRow } from '@/components/admin/StaffManager';
import { requireShellUser } from '@/lib/shell';
import { listStaff } from '@/lib/staff';

/** Staff accounts (ADR 0002). Admin-only, enforced by the layout and the API. */
export const dynamic = 'force-dynamic';

export default async function AdminStaffPage() {
  const [staff, user] = await Promise.all([listStaff(), requireShellUser(['admin'])]);

  const initialStaff: StaffRow[] = staff.map((member) => ({
    id: member.id,
    fullName: member.fullName,
    phone: member.phone,
    email: member.email,
    role: member.role === 'admin' ? 'admin' : 'employee',
    isActive: member.isActive,
  }));

  return (
    <>
      <h1 className="h4 mb-1">พนักงานและสิทธิ์การใช้งาน</h1>
      <p className="text-muted small mb-4">
        เพิ่มบัญชีให้พนักงาน กำหนดว่าใครเป็นผู้จัดการ และปิดการใช้งานเมื่อลาออก
      </p>

      <StaffManager initialStaff={initialStaff} currentUserId={user.id} />
    </>
  );
}
