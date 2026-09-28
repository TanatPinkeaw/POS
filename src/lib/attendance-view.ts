/**
 * Attendance shapes as the browser sees them.
 *
 * A deliberately separate module from `attendance.ts`: that one owns the
 * database and can only run on the server, whereas these types cross the wire.
 * Over HTTP every `Date` becomes an ISO string, so the client types say so,
 * rather than pretending a `Date` survived JSON.
 *
 * The display helpers are built on the same `bangkok-time` and
 * `attendance-rules` functions the export uses, so a figure a manager reads on
 * screen and the same figure in the SRS §8 workbook cannot disagree.
 */
import { bangkokDateString, bangkokDateTimeString, bangkokTimeString } from './bangkok-time';
import { latenessOvertimeLabel } from './attendance-rules';

export interface AttendanceRowView {
  logId: number;
  employeeId: string;
  employeeName: string;
  employeePhone: string;
  /** ISO instant. */
  checkIn: string;
  checkOut: string | null;
  workHours: number | null;
  note: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduleId: number | null;
}

export interface ScheduleView {
  id: number;
  employeeId: string;
  employeeName: string;
  employeePhone: string;
  /** `YYYY-MM-DD`. */
  shiftDate: string;
  /** `HH:mm`. */
  startTime: string;
  endTime: string;
  note: string | null;
}

export interface StaffMemberView {
  id: string;
  fullName: string;
  phone: string;
  role: string;
}

export interface StaffAttendanceSnapshotView {
  openLog: AttendanceRowView | null;
  schedule: ScheduleView | null;
  logs: AttendanceRowView[];
  hoursToday: number;
}

/** An attendance row as the server holds it, with real `Date`s. */
export type AttendanceRowDates = Omit<AttendanceRowView, 'checkIn' | 'checkOut'> & {
  checkIn: Date;
  checkOut: Date | null;
};

/**
 * Flattens a server row's instants to ISO strings.
 *
 * Returned by the API this happens automatically in JSON; passed from a server
 * component as an RSC prop it does not, so this pins both paths to the same
 * shape and the client never has to ask which one it received.
 */
export function toAttendanceRowView(row: AttendanceRowDates): AttendanceRowView {
  return {
    ...row,
    checkIn: row.checkIn.toISOString(),
    checkOut: row.checkOut === null ? null : row.checkOut.toISOString(),
  };
}

/** Flattens a whole server snapshot the same way. */
export function toSnapshotView(snapshot: {
  openLog: AttendanceRowDates | null;
  schedule: ScheduleView | null;
  logs: AttendanceRowDates[];
  hoursToday: number;
}): StaffAttendanceSnapshotView {
  return {
    openLog: snapshot.openLog ? toAttendanceRowView(snapshot.openLog) : null,
    schedule: snapshot.schedule,
    logs: snapshot.logs.map(toAttendanceRowView),
    hoursToday: snapshot.hoursToday,
  };
}

/** Whether the log is still running. */
export function isOpen(row: { checkOut: string | null }): boolean {
  return row.checkOut === null;
}

/** `HH:mm` for an ISO instant, in Bangkok. */
export function timeLabel(iso: string): string {
  return bangkokTimeString(new Date(iso));
}

/** `DD/MM/YYYY HH:mm` for an ISO instant, in Bangkok. */
export function dateTimeLabel(iso: string): string {
  return bangkokDateTimeString(new Date(iso));
}

/** Bangkok calendar day of an ISO instant. */
export function dayOf(iso: string): string {
  return bangkokDateString(new Date(iso));
}

/**
 * Lateness/overtime for a row, e.g. `สาย 12 นาที`.
 *
 * Null end times are still passed through, so a running shift reports its
 * lateness without inventing an overtime figure it cannot know yet.
 */
export function latenessLabel(row: Pick<AttendanceRowView, 'checkIn' | 'checkOut' | 'scheduledStart' | 'scheduledEnd'>): string {
  return latenessOvertimeLabel({
    checkIn: new Date(row.checkIn),
    checkOut: row.checkOut === null ? null : new Date(row.checkOut),
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
  });
}

/** `8.55` → `8 ชม. 33 นาที`, the way a manager reads a timesheet. */
export function durationLabel(hours: number | null): string {
  if (hours === null) {
    return '—';
  }
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) {
    return `${m} นาที`;
  }
  return m === 0 ? `${h} ชม.` : `${h} ชม. ${m} นาที`;
}

/** A tone for a lateness/label cell, so late arrivals stand out. */
export function latenessTone(label: string): 'success' | 'warning' | 'neutral' {
  if (label.includes('สาย')) {
    return 'warning';
  }
  if (label === 'ตรงเวลา') {
    return 'success';
  }
  return 'neutral';
}
