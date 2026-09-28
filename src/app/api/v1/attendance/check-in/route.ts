import { readJson, withApi } from '@/lib/api';
import { checkIn } from '@/lib/attendance';
import { requireRole } from '@/lib/auth';
import { bangkokDateString } from '@/lib/bangkok-time';
import { notifyAttendanceChanged } from '@/lib/notify';
import { attendanceClockSchema } from '@/lib/schemas';

/**
 * Clocks the signed-in employee in — SRS §6.
 *
 * Always the caller's own id: attendance is something you do, not something you
 * have done to you. An admin back-filling someone else's shift goes through
 * `POST /api/v1/attendance/manual` instead, which is explicit about it.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const body = await readJson(request, attendanceClockSchema);

    const log = await checkIn({ employeeId: session.id, note: body.note ?? null });

    notifyAttendanceChanged({
      employeeId: session.id,
      employeeName: session.fullName,
      action: 'check_in',
      day: bangkokDateString(log.checkIn),
    });

    return log;
  });
}
