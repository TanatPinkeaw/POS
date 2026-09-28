/**
 * Report specification — SRS §8.
 *
 * The column sets live here, away from the queries and away from ExcelJS, for
 * two reasons: the SRS fixes these headers verbatim (so they are worth asserting
 * in a test), and the formatters must not depend on the host's ICU build for the
 * same reason `formatThb` doesn't — a workbook exported on a developer's machine
 * and one exported on the shop's till must be byte-identical.
 *
 * Everything in this file is pure: no Prisma, no `node:` imports.
 */
// Bangkok wall-clock formatting, day-range resolution, and the lateness and
// overtime rules now live with the code that owns them: `bangkok-time` and the
// attendance roster. Re-exported here so the report queries and their tests keep
// one import site, and so the export and the roster board cannot drift.
export {
  bangkokDateString,
  bangkokDateTimeString,
  bangkokDayString,
  bangkokTimeString,
} from './bangkok-time';
export type { BangkokRange as ReportRange } from './bangkok-time';
export { resolveBangkokRange as resolveReportRange } from './bangkok-time';
export {
  latenessMinutes,
  latenessOvertimeLabel,
  overtimeMinutes,
} from './attendance-rules';

/** The four workbooks named by SRS §8. */
export const REPORT_TYPES = [
  'sales_summary',
  'product_performance',
  'employee_attendance',
  'stock_audit',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/** A cell value as written into the sheet. `null` renders as an empty cell. */
export type ReportCell = string | number | null;

/** One worksheet, fully materialised, ready to be handed to the renderer. */
export interface ReportTable {
  type: ReportType;
  /** Human title shown in the UI and on the sheet's header. */
  title: string;
  /** Excel sheet name (max 31 chars, no `[]:*?/\\`). */
  sheetName: string;
  /** Column headers, exactly as SRS §8 names them. */
  columns: string[];
  rows: ReportCell[][];
  /** Range the report covers, as `YYYY-MM-DD` (Bangkok calendar days). */
  from: string;
  to: string;
}

/**
 * SRS §8 column headers, per report type.
 *
 * Kept as the single source of truth so `buildReport` shapes rows to match and
 * the tests can pin the contract.
 */
export const REPORT_COLUMNS: Record<ReportType, readonly string[]> = {
  sales_summary: [
    'Order ID',
    'Date/Time',
    'Type (POS/Online)',
    'Subtotal',
    'Discount',
    'Net Total',
    'Payment Method',
    'Cashier Name',
  ],
  product_performance: [
    'Barcode',
    'Product Name',
    'Quantity Sold',
    'Total Revenue',
    'Total Cost',
    'Gross Profit Margin (%)',
  ],
  employee_attendance: [
    'Employee ID',
    'Name',
    'Date',
    'Scheduled In',
    'Scheduled Out',
    'Actual Check-In',
    'Actual Check-Out',
    'Total Hours Worked',
    'Lateness/Overtime',
  ],
  stock_audit: [
    'Timestamp',
    'Product Name',
    'Adjustment Type',
    'Quantity Delta',
    'Ending Stock',
    'Adjusted By',
    'Reason/Note',
  ],
};

/** Thai titles for the admin screen and the workbook. */
export const REPORT_TITLES: Record<ReportType, string> = {
  sales_summary: 'สรุปยอดขายรายวัน/รายเดือน',
  product_performance: 'ผลการขายและกำไรต่อสินค้า',
  employee_attendance: 'รายงานเวลาทำงานพนักงาน',
  stock_audit: 'บันทึกการเคลื่อนไหวสต็อก',
};

export function isReportType(value: string): value is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(value);
}

/** Columns for a report type. */
export function reportColumns(type: ReportType): string[] {
  return [...REPORT_COLUMNS[type]];
}

// --------------------------------------------------------------- labels

const ORDER_TYPE_LABELS: Record<string, string> = {
  pos_walkin: 'หน้าร้าน (POS)',
  preorder: 'ออนไลน์',
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'เงินสด',
  promptpay: 'พร้อมเพย์',
  points: 'แต้มสะสม',
  mixed: 'ผสม',
};

const STOCK_MOVEMENT_LABELS: Record<string, string> = {
  manual_adjust: 'ปรับด้วยมือ',
  pos_sale: 'ขายหน้าร้าน',
  pos_refund: 'คืนสินค้า (ใบลดหนี้)',
  preorder_reserve: 'จองพรีออเดอร์',
  preorder_cancel: 'คืนการจอง',
  restock: 'รับสินค้าเข้า',
};

const ADJUSTMENT_REASON_LABELS: Record<string, string> = {
  REASON_RESTOCK: 'รับสินค้าเข้า',
  REASON_DAMAGED: 'สินค้าเสียหาย',
  REASON_EXPIRED: 'สินค้าหมดอายุ',
  REASON_CORRECTION: 'แก้ไขยอดผิดพลาด',
};

/** Human label for an enum value, falling back to the raw value. */
function labelOf(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value;
}

export function orderTypeLabel(value: string): string {
  return labelOf(ORDER_TYPE_LABELS, value);
}

export function stockMovementLabel(value: string): string {
  return labelOf(STOCK_MOVEMENT_LABELS, value);
}

export function adjustmentReasonLabel(value: string): string {
  return labelOf(ADJUSTMENT_REASON_LABELS, value);
}

/**
 * Renders the payment leg(s) of an order as one cell.
 *
 * An order can be settled by more than one method (SRS §5 mixed payments), so
 * distinct methods are joined rather than only the first being reported.
 */
export function paymentMethodLabel(methods: readonly string[]): string {
  const distinct = [...new Set(methods)];
  if (distinct.length === 0) {
    return '—';
  }
  return distinct.map((method) => labelOf(PAYMENT_METHOD_LABELS, method)).join(' + ');
}

// --------------------------------------------------------------- metrics

/**
 * Gross margin as a percentage of revenue.
 *
 * A product sold at zero revenue has no meaningful margin, so it reports 0
 * rather than dividing by zero. Rounded to two decimals so the figure in the
 * sheet matches the figure in a summary line.
 */
export function grossMarginPercent(revenue: number, cost: number): number {
  if (revenue <= 0) {
    return 0;
  }
  return roundTo((revenue - cost) / revenue, 4) * 100;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
