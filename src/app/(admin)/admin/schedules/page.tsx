import { AttendanceBoard } from '@/components/admin/AttendanceBoard';
import { ScheduleManager } from '@/components/admin/ScheduleManager';
import { PageHeader, Stack } from '@/components/ds';
import { listAttendanceRows, listSchedules, listStaff } from '@/lib/attendance';
import { toAttendanceRowView } from '@/lib/attendance-view';
import { addBangkokDays, bangkokDateString, resolveBangkokRange } from '@/lib/bangkok-time';
import { requireShellUser } from '@/lib/shell';

/**
 * Staff scheduling and the timesheet — SRS §6.
 *
 * Loaded once on the server and handed to two client boards, which then refresh
 * themselves over HTTP and from the realtime `attendance:updated` event. The
 * page reads "today" from Bangkok rather than from the browser, so the roster
 * and the export always agree on which day they are talking about.
 */
export default async function SchedulesPage() {
  // Admin-only under the page matrix (ADR 0022).
  await requireShellUser(['admin']);

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
    <Stack gap="lg">
      <PageHeader
        title="ตารางงานและเวลาทำงาน"
        subtitle="วางตารางกะให้พนักงาน แล้วระบบจะคำนวณสาย/ล่วงเวลาและชั่วโมงทำงานให้เอง — ข้อมูลชุดเดียวกับรายงานส่งออก SRS §8"
      />

      <ScheduleManager
        staff={staff}
        initialSchedules={schedules}
        initialFrom={rosterFrom}
        initialTo={rosterTo}
        today={today}
      />

      <AttendanceBoard
        staff={staff}
        initialRows={attendance.map(toAttendanceRowView)}
        initialFrom={today}
        initialTo={today}
        today={today}
      />
    </Stack>
  );
}
