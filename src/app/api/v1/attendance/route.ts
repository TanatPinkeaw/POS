import { withApi } from '@/lib/api';
import { listAttendanceRows } from '@/lib/attendance';
import { requireRole } from '@/lib/auth';
import { bangkokDateString, resolveBangkokRange } from '@/lib/bangkok-time';
import { attendanceQuerySchema } from '@/lib/schemas';

/**
 * The timesheet board — SRS §8.
 *
 * Admin-only: it shows every employee's actual hours and their lateness, which
 * is performance data a cashier has no business reading. Defaults to today,
 * because the board is normally opened to answer "who is in right now".
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
    const range = resolveBangkokRange({
      from: query.from ?? today,
      to: query.to ?? today,
    });

    const rows = await listAttendanceRows({
      from: range.fromDate,
      toExclusive: range.toExclusive,
      employeeId: query.employeeId,
    });

    return {
      rows,
      from: range.from,
      to: range.to,
      // Hint for the date pickers, so the client and the server agree on
      // "today" even when the browser is in another timezone.
      today,
    };
  });
}
