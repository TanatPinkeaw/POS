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
    <div className="d-flex flex-column gap-3">
      <div>
        {/* `.h4` keeps the size; the element gives the page its missing h1. */}
        <h1 className="h4 mb-1">ลงเวลาทำงาน</h1>
        <p className="text-muted mb-0 small">
          ลงเวลาเข้าเมื่อมาถึง และลงเวลาออกเมื่อเลิกงาน — ชั่วโมงทำงานคำนวณให้อัตโนมัติ
        </p>
      </div>

      <TimeClock initial={toSnapshotView(snapshot)} today={today} />
    </div>
  );
}
