import { withApi } from '@/lib/api';
import { deleteSchedule, loadSchedule } from '@/lib/attendance';
import { requireRole } from '@/lib/auth';
import { ValidationError } from '@/lib/errors';
import { notifyAttendanceChanged } from '@/lib/notify';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Removes a roster shift — someone is no longer working that day.
 *
 * Deleting the plan leaves any actual `time_logs` for that day untouched, which
 * is deliberate: the timesheet records what happened, and un-rostering a shift
 * must not rewrite history. The export then shows actual hours with blank
 * scheduled columns, which is exactly the truth.
 */
export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const { id } = await context.params;

    const scheduleId = Number(id);
    if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
      throw new ValidationError('รหัสตารางงานต้องเป็นจำนวนเต็ม');
    }

    const schedule = await loadSchedule(scheduleId);
    await deleteSchedule(scheduleId);

    notifyAttendanceChanged({
      employeeId: schedule.employeeId,
      employeeName: schedule.employeeName,
      action: 'schedule_removed',
      day: schedule.shiftDate,
    });

    return { deleted: scheduleId };
  });
}
