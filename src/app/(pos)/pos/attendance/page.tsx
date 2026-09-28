import { PageHeader, Stack } from '@/components/ds';
import { TimeClock } from '@/components/pos/TimeClock';
import { staffAttendanceSnapshot } from '@/lib/attendance';
import { toSnapshotView } from '@/lib/attendance-view';
import { requireUser } from '@/lib/auth';
import { bangkokDateString } from '@/lib/bangkok-time';

/**
 * The staff time clock — SRS §6.
 *
 * The snapshot is loaded on the server so the page renders the employee's real
 * state on first paint, rather than flashing "not clocked in" while a client
 * fetch catches up.
 */
export default async function AttendancePage() {
  const session = await requireUser();
  const today = bangkokDateString(new Date());

  const snapshot = await staffAttendanceSnapshot({ employeeId: session.id, day: today });

  return (
    <Stack gap="lg">
      <PageHeader
        title="ลงเวลาทำงาน"
        subtitle="ลงเวลาเข้าเมื่อมาถึง และลงเวลาออกเมื่อเลิกงาน — ชั่วโมงทำงานคำนวณให้อัตโนมัติ"
      />
      <TimeClock initial={toSnapshotView(snapshot)} today={today} />
    </Stack>
  );
}
