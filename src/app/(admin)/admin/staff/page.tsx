import { StaffManager, type StaffRow } from '@/components/admin/StaffManager';
import { SupervisorPinPanel } from '@/components/admin/SupervisorPinPanel';
import { PageHeader, Stack } from '@/components/ds';
import { requireShellUser } from '@/lib/shell';
import { listStaff } from '@/lib/staff';
import { listSupervisors, supervisorStatus } from '@/lib/supervisor';

/**
 * Staff accounts (ADR 0002) and the supervisor PIN (Phase F).
 *
 * Admin-only, enforced by the layout and by every API this page calls. The PIN
 * panel is loaded here rather than fetching itself, so the screen answers "who
 * can approve a void right now" in the same paint as the roster.
 */
export const dynamic = 'force-dynamic';

export default async function AdminStaffPage() {
  const [staff, user] = await Promise.all([listStaff(), requireShellUser(['admin'])]);
  const [pinStatus, supervisors] = await Promise.all([
    supervisorStatus(user.id),
    listSupervisors(),
  ]);

  const initialStaff: StaffRow[] = staff.map((member) => ({
    id: member.id,
    fullName: member.fullName,
    phone: member.phone,
    email: member.email,
    role: member.role === 'admin' ? 'admin' : 'employee',
    isActive: member.isActive,
  }));

  return (
    <Stack gap="lg">
      <PageHeader
        title="พนักงานและสิทธิ์การใช้งาน"
        subtitle="เพิ่มบัญชีให้พนักงาน กำหนดว่าใครเป็นผู้จัดการ และปิดการใช้งานเมื่อลาออก"
      />

      <Stack gap="lg">
        <SupervisorPinPanel
          status={pinStatus}
          supervisors={supervisors}
          fullName={user.fullName}
        />

        <StaffManager initialStaff={initialStaff} currentUserId={user.id} />
      </Stack>
    </Stack>
  );
}
