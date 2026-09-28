import { withApi } from '@/lib/api';
import { deleteLog, loadAttendanceRow } from '@/lib/attendance';
import { requireRole } from '@/lib/auth';
import { bangkokDateString } from '@/lib/bangkok-time';
import { ValidationError } from '@/lib/errors';
import { notifyAttendanceChanged } from '@/lib/notify';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Removes a timesheet row — an admin correction, not a routine path.
 *
 * There is no soft-delete here on purpose: a wrong row is removed rather than
 * hidden, because a timesheet with invisible rows in it is worse than one with a
 * gap the manager can explain.
 */
export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const { id } = await context.params;

    const logId = Number(id);
    if (!Number.isInteger(logId) || logId <= 0) {
      throw new ValidationError('Time log id must be a whole number');
    }

    // Read first, for the notification's employee name and day.
    const log = await loadAttendanceRow(logId);
    await deleteLog(logId);

    notifyAttendanceChanged({
      employeeId: log.employeeId,
      employeeName: log.employeeName,
      action: 'log_removed',
      day: bangkokDateString(log.checkIn),
    });

    return { deleted: logId };
  });
}
