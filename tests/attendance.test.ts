// Seam under test: the pure time/attendance arithmetic that sits between the
// roster and the timesheet. No database: these are exactly the functions that,
// if wrong, shift a whole shift into the wrong day.
import { describe, expect, it } from 'vitest';

import {
  addBangkokDays,
  clockFromTimeColumn,
  dateColumnFromDay,
  dayFromDateColumn,
  isClock,
  parseBangkokLocalDateTime,
  resolveBangkokRange,
  timeColumnFromClock,
  toBangkokLocalDateTime,
} from '@/lib/bangkok-time';
import {
  latenessMinutes,
  latenessOvertimeLabel,
  overtimeMinutes,
  scheduleWindowError,
} from '@/lib/attendance-rules';
import { ValidationError } from '@/lib/errors';

describe('clock columns', () => {
  it('round-trips an HH:MM through the @db.Time representation', () => {
    const column = timeColumnFromClock('09:30');
    // Prisma anchors `time` at 1970-01-01 UTC.
    expect(column.toISOString()).toBe('1970-01-01T09:30:00.000Z');
    expect(clockFromTimeColumn(column)).toBe('09:30');
  });

  it('keeps midnight and end-of-day distinct', () => {
    expect(clockFromTimeColumn(timeColumnFromClock('00:00'))).toBe('00:00');
    expect(clockFromTimeColumn(timeColumnFromClock('23:59'))).toBe('23:59');
  });

  it('rejects a malformed clock', () => {
    expect(isClock('9:30')).toBe(false);
    expect(isClock('24:00')).toBe(false);
    expect(isClock('09:60')).toBe(false);
    expect(isClock('09:30')).toBe(true);
    expect(() => timeColumnFromClock('9:5')).toThrow(ValidationError);
  });
});

describe('date columns', () => {
  it('round-trips a calendar day through the @db.Date representation', () => {
    const column = dateColumnFromDay('2026-09-27');
    expect(column.toISOString()).toBe('2026-09-27T00:00:00.000Z');
    expect(dayFromDateColumn(column)).toBe('2026-09-27');
  });
});

describe('Bangkok local date-time', () => {
  it('reads a datetime-local value as Bangkok time, not server-local time', () => {
    // 14:30 in Bangkok is 07:30 UTC.
    expect(parseBangkokLocalDateTime('2026-09-27T14:30').toISOString()).toBe(
      '2026-09-27T07:30:00.000Z',
    );
  });

  it('round-trips back into the form field shape', () => {
    const instant = parseBangkokLocalDateTime('2026-09-27T00:05');
    expect(toBangkokLocalDateTime(instant)).toBe('2026-09-27T00:05');
  });

  it('rejects a value with no time or a bad clock', () => {
    expect(() => parseBangkokLocalDateTime('2026-09-27')).toThrow(ValidationError);
    expect(() => parseBangkokLocalDateTime('2026-09-27T25:00')).toThrow(ValidationError);
  });
});

describe('addBangkokDays', () => {
  it('crosses a month boundary', () => {
    expect(addBangkokDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addBangkokDays('2026-09-01', -1)).toBe('2026-08-31');
  });
});

describe('resolveBangkokRange', () => {
  it('makes the end day inclusive', () => {
    const range = resolveBangkokRange({ from: '2026-09-01', to: '2026-09-30' });
    expect(range.fromDate.toISOString()).toBe('2026-08-31T17:00:00.000Z');
    expect(range.toExclusive.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(range).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('defaults to the trailing 30 days', () => {
    const range = resolveBangkokRange({}, new Date('2026-09-27T07:00:00Z'));
    expect(range.to).toBe('2026-09-27');
    expect(range.from).toBe('2026-08-29');
  });

  it('refuses a reversed range', () => {
    expect(() => resolveBangkokRange({ from: '2026-09-30', to: '2026-09-01' })).toThrow(
      /before/i,
    );
  });
});

describe('scheduleWindowError', () => {
  it('accepts a normal shift', () => {
    expect(scheduleWindowError('09:00', '17:30')).toBeNull();
  });

  it('refuses an end that is not after the start', () => {
    expect(scheduleWindowError('17:00', '09:00')).toBeTruthy();
    expect(scheduleWindowError('09:00', '09:00')).toBeTruthy();
  });
});

describe('lateness and overtime', () => {
  const onTime = new Date('2026-09-27T02:00:00Z'); // 09:00 Bangkok
  const late = new Date('2026-09-27T02:12:00Z'); // 09:12 Bangkok
  const early = new Date('2026-09-27T01:55:00Z'); // 08:55 Bangkok

  it('measures lateness in minutes', () => {
    expect(latenessMinutes(late, '09:00')).toBe(12);
    expect(latenessMinutes(early, '09:00')).toBe(-5);
  });

  it('is null when there is no roster to compare against', () => {
    expect(latenessMinutes(late, null)).toBeNull();
    expect(overtimeMinutes(late, null)).toBeNull();
    expect(overtimeMinutes(null, '17:30')).toBeNull();
  });

  it('measures overtime past the rostered end', () => {
    const checkOut = new Date('2026-09-27T10:45:00Z'); // 17:45 Bangkok
    expect(overtimeMinutes(checkOut, '17:30')).toBe(15);
  });

  it('folds both into one phrase', () => {
    expect(
      latenessOvertimeLabel({
        checkIn: late,
        checkOut: new Date('2026-09-27T10:45:00Z'),
        scheduledStart: '09:00',
        scheduledEnd: '17:30',
      }),
    ).toBe('สาย 12 นาที · ล่วงเวลา 15 นาที');
  });

  it('says on-time when the roster was met with no overtime', () => {
    expect(
      latenessOvertimeLabel({
        checkIn: early,
        checkOut: onTime,
        scheduledStart: '09:00',
        scheduledEnd: '09:00',
      }),
    ).toBe('ตรงเวลา');
  });
});
