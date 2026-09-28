import { AttendanceBoard } from '@/components/admin/AttendanceBoard';
import { ScheduleManager } from '@/components/admin/ScheduleManager';
import { listAttendanceRows, listSchedules, listStaff } from '@/lib/attendance';
import { toAttendanceRowView } from '@/lib/attendance-view';
import { addBangkokDays, bangkokDateString, resolveBangkokRange } from '@/lib/bangkok-time';

/**
 * Staff scheduling and the timesheet — SRS §6.
 *
 * Loaded once on the server and handed to two client boards, which then refresh
 * themselves over HTTP and from the realtime `attendance:updated` event. The
 * page reads "today" from Bangkok rather than from the browser, so the roster
 * and the export always agree on which day they are talking about.
 */
export default async function SchedulesPage() {
  const today = bangkokDateString(new Date());
  const rosterFrom = addBangkokDays(today, -1);
  const rosterTo = addBangkokDays(today, 13);
  const todayRange = resolveBangkokRange({ from: today, to: today });

  const [staff, schedules, attendance] = await Promise.all([
    listStaff(),
    listSchedules({ from: rosterFrom, to: rosterTo }),
    listAttendanceRows({
      from: todayRange.fromDate,
      toExclusive: todayRange.toExclusive,
    }),
  ]);

  return (
    <div className="d-flex flex-column gap-4">
      <div>
        {/* The page's own `h1`: `.h4` keeps the visual size, the element fixes
            the document outline, which previously started at h4. */}
        <h1 className="h4 mb-1">ตารางงานและเวลาทำงาน</h1>
        <p className="text-muted mb-0 small">
          วางตารางกะให้พนักงาน แล้วระบบจะคำนวณสาย/ล่วงเวลาและชั่วโมงทำงานให้เอง
          — ข้อมูลชุดเดียวกับรายงานส่งออก SRS §8
        </p>
      </div>

      <ScheduleManager staff={staff} initialSchedules={schedules} today={today} />

      <AttendanceBoard
        staff={staff}
        initialRows={attendance.map(toAttendanceRowView)}
        initialFrom={today}
        initialTo={today}
        today={today}
      />
    </div>
  );
}
