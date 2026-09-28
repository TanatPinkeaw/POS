/**
 * Attendance rules — SRS §6 / §8.
 *
 * Lateness and overtime are the whole point of the timesheet: a check-in
 * timestamp alone is a log, whereas comparing it to the roster is what a manager
 * actually needs. Those comparisons are pure functions of two clock times, so
 * they live here rather than inside the query layer — which is what lets them be
 * tested without a database, and what keeps the SRS §8 `employee_attendance`
 * export and the on-screen roster board from ever disagreeing.
 *
 * Pure: no Prisma, no `node:` imports.
 */
import { bangkokMinutesOfDay } from './bangkok-time';

/** Parses `HH:mm[:ss]` to minutes past midnight, or null when it isn't a clock. */
export function parseClock(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Minutes late against a scheduled start (positive = late).
 *
 * Null when there is no roster to compare against, so a caller can distinguish
 * "punctual" from "not scheduled" instead of inventing a number.
 */
export function latenessMinutes(checkIn: Date, scheduledStart: string | null): number | null {
  const startMinutes = parseClock(scheduledStart);
  if (startMinutes === null) {
    return null;
  }
  return bangkokMinutesOfDay(checkIn) - startMinutes;
}

/** Minutes past a scheduled end (positive = overtime). */
export function overtimeMinutes(checkOut: Date | null, scheduledEnd: string | null): number | null {
  const endMinutes = parseClock(scheduledEnd);
  if (endMinutes === null || checkOut === null) {
    return null;
  }
  return bangkokMinutesOfDay(checkOut) - endMinutes;
}

/**
 * One phrase describing lateness and overtime, e.g. `สาย 12 นาที`.
 *
 * A manager scanning the column wants one glance, not two columns to subtract,
 * so both facts are folded into a single cell.
 */
export function latenessOvertimeLabel(input: {
  checkIn: Date;
  checkOut: Date | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
}): string {
  const late = latenessMinutes(input.checkIn, input.scheduledStart);
  const overtime = overtimeMinutes(input.checkOut, input.scheduledEnd);

  const parts: string[] = [];
  if (late !== null) {
    parts.push(late > 0 ? `สาย ${late} นาที` : 'ตรงเวลา');
  }
  if (overtime !== null && overtime > 0) {
    parts.push(`ล่วงเวลา ${overtime} นาที`);
  }

  if (parts.length === 0) {
    return '—';
  }
  return parts.join(' · ');
}

/**
 * Why a rostered window is unusable, or null when it is fine.
 *
 * An end that is not after the start would produce a negative shift, which
 * `work_hours` would then faithfully compute; refusing it at the edge is
 * cheaper than explaining a negative timesheet later.
 */
export function scheduleWindowError(start: string, end: string): string | null {
  const startMinutes = parseClock(start);
  const endMinutes = parseClock(end);
  if (startMinutes === null || endMinutes === null) {
    return 'เวลาเข้าและเวลาออกต้องอยู่ในรูปแบบ HH:MM';
  }
  if (endMinutes <= startMinutes) {
    return 'เวลาออกต้องหลังเวลาเข้า';
  }
  return null;
}

/** True when a log has not been closed yet. */
export function isOpenLog(log: { checkOut: Date | null }): boolean {
  return log.checkOut === null;
}
