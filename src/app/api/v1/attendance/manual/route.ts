import { readJson, withApi } from '@/lib/api';
import { createManualLog } from '@/lib/attendance';
import { requireRole } from '@/lib/auth';
import { bangkokDateString, parseBangkokLocalDateTime } from '@/lib/bangkok-time';
import { notifyAttendanceChanged } from '@/lib/notify';
import { manualLogSchema } from '@/lib/schemas';

/**
 * An admin-entered timesheet row — the back-fill path.
 *
 * Real shops have shifts nobody clocked: a forgotten phone, a power cut, a new
 * starter. Without this the timesheet would only ever be as complete as the
 * discipline of the floor, and the §8 export would under-report hours. It is
 * admin-only precisely because it is the one way to write a log for somebody
 * else.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const body = await readJson(request, manualLogSchema);

    // Read as Bangkok wall-clock time, not the server's locale.
    const checkIn = parseBangkokLocalDateTime(body.checkIn);
    const checkOut = body.checkOut ? parseBangkokLocalDateTime(body.checkOut) : null;

    const log = await createManualLog({
      employeeId: body.employeeId,
      checkIn,
      checkOut,
      note: body.note ?? null,
    });

    notifyAttendanceChanged({
      employeeId: log.employeeId,
      employeeName: log.employeeName,
      action: 'manual_log',
      day: bangkokDateString(log.checkIn),
    });

    return log;
  });
}
