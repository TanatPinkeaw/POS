import { readJson, withApi } from '@/lib/api';
import { checkOut } from '@/lib/attendance';
import { requireRole } from '@/lib/auth';
import { bangkokDateString } from '@/lib/bangkok-time';
import { notifyAttendanceChanged } from '@/lib/notify';
import { attendanceClockSchema } from '@/lib/schemas';

/**
 * Clocks the signed-in employee out — SRS §6.
 *
 * The response carries the `work_hours` PostgreSQL just computed, so the till
 * can show the shift length without re-deriving it.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const body = await readJson(request, attendanceClockSchema);

    const log = await checkOut({ employeeId: session.id, note: body.note ?? null });

    notifyAttendanceChanged({
      employeeId: session.id,
      employeeName: session.fullName,
      action: 'check_out',
      // A shift that crosses midnight is attributed to the day it started,
      // which is the day it was rostered for.
      day: bangkokDateString(log.checkIn),
    });

    return log;
  });
}
