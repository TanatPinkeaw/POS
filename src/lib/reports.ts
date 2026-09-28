/**
 * Report queries — SRS §8.
 *
 * Each loader returns a fully materialised `ReportTable`, so the Excel renderer
 * never has to know what a report is about. Values are formatted as they are
 * read (money as THB numbers, timestamps as Bangkok strings) so what lands in a
 * cell is exactly what the domain means, with no hidden column formatting Excel
 * could reinterpret.
 *
 * The reads are plain Prisma queries, except `employee_attendance`, which
 * delegates to the attendance module — that is where the raw read of the
 * generated `time_logs.work_hours` column lives.
 */
import { listAttendanceRows } from './attendance';
import { prisma } from './db';
import { fromDecimal } from './money';
import {
  REPORT_TITLES,
  adjustmentReasonLabel,
  bangkokDateTimeString,
  bangkokDayString,
  grossMarginPercent,
  latenessOvertimeLabel,
  orderTypeLabel,
  paymentMethodLabel,
  reportColumns,
  resolveReportRange,
  stockMovementLabel,
  type ReportCell,
  type ReportRange,
  type ReportTable,
  type ReportType,
} from './report-spec';

export { resolveReportRange };
export type { ReportRange };

/**
 * Builds the requested workbook data.
 *
 * Admin-only at the route layer (SRS §2), because these reports expose margins
 * and per-employee figures that a cashier should not see.
 */
export async function buildReport(input: {
  type: ReportType;
  from?: string;
  to?: string;
  now?: Date;
}): Promise<ReportTable> {
  const range = resolveReportRange(input, input.now);

  const rows = await loadRows(input.type, range);

  return {
    type: input.type,
    title: REPORT_TITLES[input.type],
    sheetName: input.type,
    columns: reportColumns(input.type),
    rows,
    from: range.from,
    to: range.to,
  };
}

async function loadRows(type: ReportType, range: ReportRange): Promise<ReportCell[][]> {
  switch (type) {
    case 'sales_summary':
      return salesSummaryRows(range);
    case 'product_performance':
      return productPerformanceRows(range);
    case 'employee_attendance':
      return employeeAttendanceRows(range);
    case 'stock_audit':
      return stockAuditRows(range);
  }
}

// --------------------------------------------------------- sales summary

async function salesSummaryRows(range: ReportRange): Promise<ReportCell[][]> {
  const orders = await prisma.orders.findMany({
    where: {
      /*
       * Gross, so a refunded sale is still a sale here — the reversal belongs to
       * the day it happened, and rewriting the row that recorded it would make
       * this sheet disagree with the till's own history.
       *
       * The column set is fixed by SRS §8 and therefore gains nothing to hold the
       * refund; where the reversal *is* visible is the stock-audit sheet (a
       * `pos_refund` movement per returned line) and the audit trail, which
       * records the credit note, the amount, the reason and both people. That is
       * written down in ADR 0004 rather than left as a surprise in a spreadsheet.
       */
      status: { in: ['completed', 'refunded'] },
      completed_at: { gte: range.fromDate, lt: range.toExclusive },
    },
    orderBy: { completed_at: 'asc' },
    include: {
      cashier: { select: { full_name: true } },
      /*
       * The `Payment Method` column answers "how did this customer pay", so the
       * refund leg is filtered out: a bill paid by transfer and refunded in cash
       * must not read as a mixed-payment sale.
       */
      payments: {
        where: { direction: 'sale' },
        select: { method: true },
        orderBy: { id: 'asc' },
      },
    },
  });

  return orders.map((order) => [
    order.order_number,
    bangkokDateTimeString(order.completed_at ?? order.created_at),
    orderTypeLabel(order.order_type),
    fromDecimal(order.subtotal_amount),
    fromDecimal(order.discount_amount),
    fromDecimal(order.final_amount),
    paymentMethodLabel(order.payments.map((payment) => payment.method)),
    order.cashier?.full_name ?? '—',
  ]);
}

// ---------------------------------------------------- product performance

interface ProductAggregate {
  barcode: string;
  name: string;
  quantity: number;
  revenue: number;
  cost: number;
}

async function productPerformanceRows(range: ReportRange): Promise<ReportCell[][]> {
  const items = await prisma.order_items.findMany({
    where: {
      // Gross, exactly as the sales summary is: a unit that was sold and later
      // returned did sell. Excluding it here would make the two sheets of the
      // same period disagree about the same transaction.
      order: {
        status: { in: ['completed', 'refunded'] },
        completed_at: { gte: range.fromDate, lt: range.toExclusive },
      },
    },
    select: {
      quantity: true,
      total_price: true,
      unit_cost: true,
      product: { select: { barcode: true, name: true } },
    },
  });

  // Aggregated in JS rather than SQL: a few thousand order lines a month is
  // nothing, and keeping it here means the margin rule lives beside its test.
  const byProduct = new Map<string, ProductAggregate>();
  for (const item of items) {
    const key = `${item.product.barcode ?? ''}\u0000${item.product.name}`;
    const existing = byProduct.get(key) ?? {
      barcode: item.product.barcode ?? '—',
      name: item.product.name,
      quantity: 0,
      revenue: 0,
      cost: 0,
    };
    existing.quantity += item.quantity;
    existing.revenue += fromDecimal(item.total_price);
    existing.cost += fromDecimal(item.unit_cost) * item.quantity;
    byProduct.set(key, existing);
  }

  return [...byProduct.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .map((row) => [
      row.barcode,
      row.name,
      row.quantity,
      round2(row.revenue),
      round2(row.cost),
      grossMarginPercent(row.revenue, row.cost),
    ]);
}

// ---------------------------------------------------- employee attendance

/**
 * The timesheet reads the same attendance projection the roster board does, so
 * an export and an on-screen figure can never disagree — including the raw read
 * of the generated `work_hours` column and the Bangkok-shifted roster join.
 */
async function employeeAttendanceRows(range: ReportRange): Promise<ReportCell[][]> {
  const logs = await listAttendanceRows({
    from: range.fromDate,
    toExclusive: range.toExclusive,
  });

  return logs.map((log) => [
    log.employeePhone,
    log.employeeName,
    bangkokDayString(log.checkIn),
    log.scheduledStart ?? '—',
    log.scheduledEnd ?? '—',
    bangkokDateTimeString(log.checkIn),
    log.checkOut ? bangkokDateTimeString(log.checkOut) : '—',
    log.workHours,
    latenessOvertimeLabel({
      checkIn: log.checkIn,
      checkOut: log.checkOut,
      scheduledStart: log.scheduledStart,
      scheduledEnd: log.scheduledEnd,
    }),
  ]);
}

// ---------------------------------------------------------- stock audit

async function stockAuditRows(range: ReportRange): Promise<ReportCell[][]> {
  const logs = await prisma.stock_logs.findMany({
    where: { created_at: { gte: range.fromDate, lt: range.toExclusive } },
    orderBy: { created_at: 'asc' },
    include: {
      product: { select: { name: true } },
      user: { select: { full_name: true } },
    },
  });

  return logs.map((log) => {
    const reason = log.reason ? adjustmentReasonLabel(log.reason) : null;
    const note = log.note?.trim() ? log.note.trim() : null;
    return [
      bangkokDateTimeString(log.created_at),
      log.product.name,
      stockMovementLabel(log.movement_type),
      log.qty_changed,
      log.balance_after,
      log.user.full_name,
      [reason, note].filter(Boolean).join(' — ') || '—',
    ];
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
