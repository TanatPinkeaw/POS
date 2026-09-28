/**
 * `GET /api/v1/reports/export?type=…&from=…&to=…` — SRS §8.
 *
 * The one endpoint in the app whose success body is not the `{ data }` envelope:
 * it is a binary workbook, so it bypasses `withApi/ok` and writes the response
 * itself. The failure path still goes through `errorResponse`, so a bad report
 * type or a forbidden caller answers with the same JSON shape as everywhere
 * else and the client never gets a corrupt download.
 *
 * Admin-only per SRS §2 — these workbooks carry margins and per-employee data.
 */
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { renderReportWorkbook } from '@/lib/excel';
import { buildReport } from '@/lib/reports';
import { reportQuerySchema } from '@/lib/schemas';

/** ExcelJS needs Node APIs, so this route cannot run on the edge runtime. */
export const runtime = 'nodejs';

/** Always computed from live data; never cached. */
export const dynamic = 'force-dynamic';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireRole(['admin']);

    const params = new URL(request.url).searchParams;
    const query = reportQuerySchema.parse({
      type: params.get('type') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
    });

    const table = await buildReport(query);
    const file = await renderReportWorkbook(table);
    const filename = `${table.type}_${table.from}_${table.to}.xlsx`;

    return new NextResponse(file, {
      status: 200,
      headers: {
        'content-type': XLSX_MIME,
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(file.byteLength),
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
