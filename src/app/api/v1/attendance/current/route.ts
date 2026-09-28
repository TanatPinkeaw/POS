import { withApi } from '@/lib/api';
import { staffAttendanceSnapshot } from '@/lib/attendance';
import { requireRole } from '@/lib/auth';
import { bangkokDateString } from '@/lib/bangkok-time';
import { attendanceQuerySchema } from '@/lib/schemas';

/**
 * The signed-in employee's own day.
 *
 * A snapshot rather than three separate calls, so the time-clock screen paints
 * from one consistent moment: reading the open log, the roster, and the day's
 * hours separately could straddle a clock-out and show a closed log as open.
 */
export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);

    const params = new URL(request.url).searchParams;
    const query = attendanceQuerySchema.parse({
      from: params.get('day') ?? undefined,
      to: params.get('day') ?? undefined,
    });

    return staffAttendanceSnapshot({
      employeeId: session.id,
      day: query.from ?? bangkokDateString(new Date()),
    });
  });
}
