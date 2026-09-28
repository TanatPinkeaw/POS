import { readJson, withApi } from '@/lib/api';
import { listSchedules, upsertSchedule } from '@/lib/attendance';
import { requireRole } from '@/lib/auth';
import { addBangkokDays, bangkokDateString } from '@/lib/bangkok-time';
import { notifyAttendanceChanged } from '@/lib/notify';
import { attendanceQuerySchema, scheduleUpsertSchema } from '@/lib/schemas';

/**
 * The roster — SRS §6.
 *
 * Admin-only: rostering is the manager's job, and the SRS keeps scheduling and
 * attendance administration with the `canAdminister` permission. Defaults to a
 * two-week window starting today, because a roster is looked at forwards.
 */
export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);

    const params = new URL(request.url).searchParams;
    const query = attendanceQuerySchema.parse({
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      employeeId: params.get('employeeId') ?? undefined,
    });

    const today = bangkokDateString(new Date());
    const from = query.from ?? addBangkokDays(today, -1);
    const to = query.to ?? addBangkokDays(today, 13);

    const rows = await listSchedules({ from, to, employeeId: query.employeeId });
    return { rows, from, to, today };
  });
}

/**
 * Creates or replaces one roster shift.
 *
 * Upsert rather than insert: `work_schedules` is unique per employee per day, so
 * "put มาลี on 09:00–17:00 on Tuesday" is one idempotent operation whether or
 * not a row already exists — which is also what makes the form safe to resubmit.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const body = await readJson(request, scheduleUpsertSchema);

    const schedule = await upsertSchedule({
      employeeId: body.employeeId,
      shiftDate: body.shiftDate,
      startTime: body.startTime,
      endTime: body.endTime,
      note: body.note ?? null,
      createdBy: session.id,
    });

    notifyAttendanceChanged({
      employeeId: schedule.employeeId,
      employeeName: schedule.employeeName,
      action: 'schedule_set',
      day: schedule.shiftDate,
    });

    return schedule;
  });
}
