// Seam under test: the report specification from SRS §8.
// The column headers are the contract the SRS fixes verbatim, and the date
// helpers are what keeps an export timezone-stable, so both are pinned here.
import { describe, expect, it } from 'vitest';

import {
  REPORT_COLUMNS,
  REPORT_TYPES,
  bangkokDateString,
  bangkokDateTimeString,
  bangkokDayString,
  bangkokTimeString,
  grossMarginPercent,
  latenessOvertimeLabel,
  orderTypeLabel,
  paymentMethodLabel,
  reportColumns,
  resolveReportRange,
  stockMovementLabel,
} from '@/lib/report-spec';

describe('SRS §8 column sets', () => {
  it('names exactly the four reports', () => {
    expect(REPORT_TYPES).toEqual([
      'sales_summary',
      'product_performance',
      'employee_attendance',
      'stock_audit',
    ]);
  });

  it('matches the sales summary columns verbatim', () => {
    expect(reportColumns('sales_summary')).toEqual([
      'Order ID',
      'Date/Time',
      'Type (POS/Online)',
      'Subtotal',
      'Discount',
      'Net Total',
      'Payment Method',
      'Cashier Name',
    ]);
  });

  it('matches the product performance columns verbatim', () => {
    expect(reportColumns('product_performance')).toEqual([
      'Barcode',
      'Product Name',
      'Quantity Sold',
      'Total Revenue',
      'Total Cost',
      'Gross Profit Margin (%)',
    ]);
  });

  it('matches the employee attendance columns verbatim', () => {
    expect(reportColumns('employee_attendance')).toEqual([
      'Employee ID',
      'Name',
      'Date',
      'Scheduled In',
      'Scheduled Out',
      'Actual Check-In',
      'Actual Check-Out',
      'Total Hours Worked',
      'Lateness/Overtime',
    ]);
  });

  it('matches the stock audit columns verbatim', () => {
    expect(reportColumns('stock_audit')).toEqual([
      'Timestamp',
      'Product Name',
      'Adjustment Type',
      'Quantity Delta',
      'Ending Stock',
      'Adjusted By',
      'Reason/Note',
    ]);
  });

  it('returns a fresh array so a caller cannot mutate the table', () => {
    const first = reportColumns('stock_audit');
    first.push('injected');
    expect(REPORT_COLUMNS.stock_audit).toHaveLength(7);
  });
});

describe('Bangkok formatting', () => {
  // 2026-09-27T17:30:00Z is 2026-09-28 00:30 in Bangkok (+07), i.e. the next day.
  const lateUtc = new Date('2026-09-27T17:30:00Z');
  const afternoonUtc = new Date('2026-09-27T07:05:00Z');

  it('renders the Bangkok calendar day, not the UTC one', () => {
    expect(bangkokDateString(lateUtc)).toBe('2026-09-28');
    expect(bangkokDateString(afternoonUtc)).toBe('2026-09-27');
  });

  it('renders HH:mm in Bangkok', () => {
    expect(bangkokTimeString(lateUtc)).toBe('00:30');
    expect(bangkokTimeString(afternoonUtc)).toBe('14:05');
  });

  it('renders DD/MM/YYYY HH:mm', () => {
    expect(bangkokDateTimeString(afternoonUtc)).toBe('27/09/2026 14:05');
  });

  it('renders DD/MM/YYYY', () => {
    expect(bangkokDayString(afternoonUtc)).toBe('27/09/2026');
  });
});

describe('resolveReportRange', () => {
  const now = new Date('2026-09-27T07:00:00Z'); // 27 Sep Bangkok

  it('defaults to the trailing 30 days ending today', () => {
    const range = resolveReportRange({}, now);
    expect(range.to).toBe('2026-09-27');
    expect(range.from).toBe('2026-08-29');
  });

  it('makes the end date inclusive of the whole day', () => {
    const range = resolveReportRange({ from: '2026-09-01', to: '2026-09-30' });
    // Exclusive bound is the next Bangkok midnight, i.e. 2026-10-01T00:00+07.
    expect(range.toExclusive.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(range.fromDate.toISOString()).toBe('2026-08-31T17:00:00.000Z');
  });

  it('rejects a reversed range', () => {
    expect(() => resolveReportRange({ from: '2026-09-30', to: '2026-09-01' })).toThrow(
      /ไม่อยู่ก่อนวันที่เริ่ม/,
    );
  });

  it('rejects a day that does not exist', () => {
    expect(() => resolveReportRange({ from: '2026-02-31', to: '2026-03-01' })).toThrow(
      /ไม่ใช่วันที่ที่มีอยู่จริงในปฏิทิน/,
    );
  });
});

describe('grossMarginPercent', () => {
  it('is the share of revenue kept after cost', () => {
    // 100 revenue, 60 cost → 40%.
    expect(grossMarginPercent(100, 60)).toBe(40);
  });

  it('is negative when sold below cost', () => {
    expect(grossMarginPercent(100, 125)).toBe(-25);
  });

  it('is zero rather than infinite when nothing was sold', () => {
    expect(grossMarginPercent(0, 0)).toBe(0);
  });

  it('rounds to two decimals', () => {
    // 100 - 33.33 = 66.67 → 66.67%.
    expect(grossMarginPercent(100, 33.33)).toBe(66.67);
  });
});

describe('latenessOvertimeLabel', () => {
  const checkIn = new Date('2026-09-27T02:12:00Z'); // 09:12 Bangkok
  const checkOut = new Date('2026-09-27T10:45:00Z'); // 17:45 Bangkok

  it('describes lateness and overtime together', () => {
    expect(
      latenessOvertimeLabel({
        checkIn,
        checkOut,
        scheduledStart: '09:00',
        scheduledEnd: '17:30',
      }),
    ).toBe('สาย 12 นาที · ล่วงเวลา 15 นาที');
  });

  it('says on-time when the schedule was met and no overtime', () => {
    expect(
      latenessOvertimeLabel({
        checkIn: new Date('2026-09-27T01:55:00Z'), // 08:55
        checkOut: new Date('2026-09-27T10:30:00Z'), // 17:30
        scheduledStart: '09:00',
        scheduledEnd: '17:30',
      }),
    ).toBe('ตรงเวลา');
  });

  it('falls back to a dash when there is no schedule', () => {
    expect(
      latenessOvertimeLabel({
        checkIn,
        checkOut: null,
        scheduledStart: null,
        scheduledEnd: null,
      }),
    ).toBe('—');
  });
});

describe('enum labels', () => {
  it('labels order types for the Type (POS/Online) column', () => {
    expect(orderTypeLabel('pos_walkin')).toBe('หน้าร้าน (POS)');
    expect(orderTypeLabel('preorder')).toBe('ออนไลน์');
  });

  it('joins mixed payment methods instead of dropping legs', () => {
    expect(paymentMethodLabel(['cash', 'points'])).toBe('เงินสด + แต้มสะสม');
    expect(paymentMethodLabel([])).toBe('—');
  });

  it('labels stock movements and falls back to the raw value', () => {
    expect(stockMovementLabel('pos_sale')).toBe('ขายหน้าร้าน');
    expect(stockMovementLabel('mystery')).toBe('mystery');
  });
});
