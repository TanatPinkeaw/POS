/**
 * Staff scheduling and attendance — SRS §6 / §8.
 *
 * Two tables, two distinct jobs. `work_schedules` is the *plan*: who is rostered,
 * for which day, between which hours. `time_logs` is the *reality*: when someone
 * actually clocked in and out, with `work_hours` computed by PostgreSQL. Keeping
 * them apart is what makes lateness and overtime computable at all — the SRS §8
 * `employee_attendance` export is nothing more than these two joined on the day.
 *
 * The reads go through raw SQL for one reason: `time_logs.work_hours` is a
 * STORED generated column, which Prisma cannot model, and the roster join has to
 * shift the check-in into Bangkok time to land on the right `shift_date`.
 */
import { Prisma } from '../generated/prisma/client';

import {
  clockFromTimeColumn,
  dateColumnFromDay,
  dayFromDateColumn,
  resolveBangkokRange,
  timeColumnFromClock,
} from './bangkok-time';
import { prisma } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import type { Db } from './inventory';
import { scheduleWindowError } from './attendance-rules';

const TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 30_000 } as const;

/** A rostered or actual attendance row, with its roster already resolved. */
export interface AttendanceRow {
  logId: number;
  employeeId: string;
  employeeName: string;
  employeePhone: string;
  checkIn: Date;
  checkOut: Date | null;
  /** From the generated column; null while the log is still open. */
  workHours: number | null;
  note: string | null;
  /** `HH:mm` from the roster for that day, or null when nobody was rostered. */
  scheduledStart: string | null;
  scheduledEnd: string | null;
  scheduleId: number | null;
}

export interface ScheduleRow {
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

export interface StaffMember {
  id: string;
  fullName: string;
  phone: string;
  role: string;
}

/** A staff member's own view of their day. */
export interface StaffAttendanceSnapshot {
  openLog: AttendanceRow | null;
  schedule: ScheduleRow | null;
  logs: AttendanceRow[];
  /** Sum of the day's closed logs, in hours. */
  hoursToday: number;
}

// ------------------------------------------------------------- raw reads

interface RawAttendance {
  log_id: unknown;
  employee_id: string;
  employee_name: string;
  employee_phone: string;
  check_in: Date;
  check_out: Date | null;
  work_hours: unknown;
  note: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  schedule_id: number | null;
}

/**
 * The projection every attendance read shares.
 *
 * `AT TIME ZONE 'Asia/Bangkok'` is what ties a check-in to the roster row for
 * the day it happened on: comparing a UTC timestamp to a `date` column directly
 * would file a 06:00 Bangkok check-in under the previous day.
 */
const ATTENDANCE_SELECT = `
  SELECT t."id"                          AS log_id,
         t."employee_id"                 AS employee_id,
         u."full_name"                   AS employee_name,
         u."phone"                       AS employee_phone,
         t."check_in"                    AS check_in,
         t."check_out"                   AS check_out,
         t."work_hours"                  AS work_hours,
         t."note"                        AS note,
         to_char(s."start_time", 'HH24:MI') AS scheduled_start,
         to_char(s."end_time", 'HH24:MI')   AS scheduled_end,
         s."id"                          AS schedule_id
    FROM "time_logs" t
    JOIN "users" u ON u."id" = t."employee_id"
    LEFT JOIN "work_schedules" s
           ON s."employee_id" = t."employee_id"
          AND s."shift_date"  = (t."check_in" AT TIME ZONE 'Asia/Bangkok')::date
`;

function toAttendanceRow(raw: RawAttendance): AttendanceRow {
  return {
    logId: Number(raw.log_id),
    employeeId: raw.employee_id,
    employeeName: raw.employee_name,
    employeePhone: raw.employee_phone,
    checkIn: raw.check_in,
    checkOut: raw.check_out,
    workHours: raw.work_hours === null || raw.work_hours === undefined ? null : Number(raw.work_hours),
    note: raw.note,
    scheduledStart: raw.scheduled_start,
    scheduledEnd: raw.scheduled_end,
    scheduleId: raw.schedule_id === null ? null : Number(raw.schedule_id),
  };
}

/** Attendance rows in a half-open instant range, oldest first. */
export async function listAttendanceRows(input: {
  from: Date;
  toExclusive: Date;
  employeeId?: string;
}): Promise<AttendanceRow[]> {
  const rows = await prisma.$queryRawUnsafe<RawAttendance[]>(
    `${ATTENDANCE_SELECT}
      WHERE t."check_in" >= $1
        AND t."check_in" <  $2
        AND ($3::uuid IS NULL OR t."employee_id" = $3::uuid)
      ORDER BY t."check_in" ASC`,
    input.from,
    input.toExclusive,
    input.employeeId ?? null,
  );
  return rows.map(toAttendanceRow);
}

/** One attendance row by id, or throws. */
export async function loadAttendanceRow(logId: number): Promise<AttendanceRow> {
  const rows = await prisma.$queryRawUnsafe<RawAttendance[]>(
    `${ATTENDANCE_SELECT} WHERE t."id" = $1`,
    logId,
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`Time log #${logId}`);
  }
  return toAttendanceRow(row);
}

/** The employee's currently-open log, if they are clocked in. */
export async function getOpenLog(employeeId: string): Promise<AttendanceRow | null> {
  const rows = await prisma.$queryRawUnsafe<RawAttendance[]>(
    `${ATTENDANCE_SELECT}
      WHERE t."employee_id" = $1::uuid
        AND t."check_out" IS NULL
      ORDER BY t."check_in" DESC
      LIMIT 1`,
    employeeId,
  );
  const row = rows[0];
  return row ? toAttendanceRow(row) : null;
}

// ------------------------------------------------------------- clocking

const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION
  );
}

/**
 * Clocks an employee in.
 *
 * The pre-check gives a readable 409 in the common case; the partial unique
 * index from the `attendance_open_log_unique` migration is what makes it *true*
 * under a double-tap, and the violation is translated to the same 409. Relying
 * on the pre-check alone would leave a race between the SELECT and the INSERT.
 */
export async function checkIn(input: {
  employeeId: string;
  note?: string | null;
  at?: Date;
}): Promise<AttendanceRow> {
  const existing = await getOpenLog(input.employeeId);
  if (existing) {
    throw new ConflictError('คุณลงเวลาเข้าไว้แล้ว กรุณาลงเวลาออกก่อน', 'ALREADY_CHECKED_IN');
  }

  try {
    const created = await prisma.time_logs.create({
      data: {
        employee_id: input.employeeId,
        check_in: input.at ?? new Date(),
        note: input.note ?? null,
      },
      select: { id: true },
    });
    return loadAttendanceRow(Number(created.id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('คุณลงเวลาเข้าไว้แล้ว กรุณาลงเวลาออกก่อน', 'ALREADY_CHECKED_IN');
    }
    throw error;
  }
}

/**
 * Clocks an employee out.
 *
 * The open row is locked `FOR UPDATE` first, so two simultaneous taps cannot
 * both read "you are clocked in" and then both write a `check_out` — the second
 * transaction waits, sees the row already closed, and is refused.
 */
export async function checkOut(input: {
  employeeId: string;
  note?: string | null;
  at?: Date;
}): Promise<AttendanceRow> {
  const logId = await prisma.$transaction(async (tx) => {
    const open = await tx.$queryRaw<{ id: unknown }[]>`
      SELECT "id" FROM "time_logs"
       WHERE "employee_id" = ${input.employeeId}::uuid
         AND "check_out" IS NULL
       FOR UPDATE
    `;
    const row = open[0];
    if (!row) {
      throw new ConflictError('คุณยังไม่ได้ลงเวลาเข้า', 'NOT_CHECKED_IN');
    }

    const checkOutAt = input.at ?? new Date();
    await tx.$executeRaw`
      UPDATE "time_logs"
         SET "check_out" = ${checkOutAt},
             "note" = COALESCE(${input.note ?? null}, "note")
       WHERE "id" = ${Number(row.id)}
    `;
    return Number(row.id);
  }, TRANSACTION_OPTIONS);

  return loadAttendanceRow(logId);
}

/**
 * An admin-entered timesheet row, for a shift nobody clocked.
 *
 * `check_out` is optional so a manager can back-fill a still-running shift, and
 * a reversed window is rejected rather than stored as negative hours.
 */
export async function createManualLog(input: {
  employeeId: string;
  checkIn: Date;
  checkOut: Date | null;
  note?: string | null;
}): Promise<AttendanceRow> {
  if (input.checkOut && input.checkOut <= input.checkIn) {
    throw new ValidationError('เวลาออกต้องหลังเวลาเข้า');
  }

  const created = await prisma.time_logs.create({
    data: {
      employee_id: input.employeeId,
      check_in: input.checkIn,
      check_out: input.checkOut,
      note: input.note ?? null,
    },
    select: { id: true },
  });
  return loadAttendanceRow(Number(created.id));
}

/** Removes a timesheet row — an admin correction, not a routine path. */
export async function deleteLog(logId: number): Promise<void> {
  const result = await prisma.time_logs.deleteMany({ where: { id: logId } });
  if (result.count === 0) {
    throw new NotFoundError(`Time log #${logId}`);
  }
}

// ------------------------------------------------------------ schedules

interface RawSchedule {
  id: number;
  employee_id: string;
  employee_name: string;
  employee_phone: string;
  shift_date: Date;
  start_time: Date;
  end_time: Date;
  note: string | null;
}

function toScheduleRow(raw: RawSchedule): ScheduleRow {
  return {
    id: Number(raw.id),
    employeeId: raw.employee_id,
    employeeName: raw.employee_name,
    employeePhone: raw.employee_phone,
    shiftDate: dayFromDateColumn(new Date(raw.shift_date)),
    startTime: clockFromTimeColumn(new Date(raw.start_time)),
    endTime: clockFromTimeColumn(new Date(raw.end_time)),
    note: raw.note,
  };
}

/**
 * Rosters in a date range.
 *
 * Prisma is used rather than raw SQL here because every column it needs is
 * modellable; the `time` and `date` columns come back as dates and are flattened
 * to `HH:mm` / `YYYY-MM-DD` by the same helpers the write path uses, so the
 * round-trip is symmetric.
 */
export async function listSchedules(input: {
  from: string;
  to: string;
  employeeId?: string;
}): Promise<ScheduleRow[]> {
  const rows = await prisma.work_schedules.findMany({
    where: {
      shift_date: { gte: dateColumnFromDay(input.from), lte: dateColumnFromDay(input.to) },
      ...(input.employeeId ? { employee_id: input.employeeId } : {}),
    },
    orderBy: [{ shift_date: 'asc' }, { start_time: 'asc' }],
    include: { employee: { select: { full_name: true, phone: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee.full_name,
    employeePhone: row.employee.phone,
    shiftDate: dayFromDateColumn(row.shift_date),
    startTime: clockFromTimeColumn(row.start_time),
    endTime: clockFromTimeColumn(row.end_time),
    note: row.note,
  }));
}

/** The roster row for one employee on one Bangkok day, if any. */
export async function getScheduleForDay(
  employeeId: string,
  day: string,
): Promise<ScheduleRow | null> {
  const rows = await listSchedules({ from: day, to: day, employeeId });
  return rows[0] ?? null;
}

/**
 * Creates or replaces the roster for an employee on a day.
 *
 * Challenging a day rather than appending, because `work_schedules` has a unique
 * `(employee_id, shift_date)`: one shift per person per day is the schema's own
 * statement of the rule, and silently adding a second row is not an option.
 */
export async function upsertSchedule(input: {
  employeeId: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
  note?: string | null;
  createdBy: string;
}): Promise<ScheduleRow> {
  const windowError = scheduleWindowError(input.startTime, input.endTime);
  if (windowError) {
    throw new ValidationError(windowError);
  }

  const shiftDate = dateColumnFromDay(input.shiftDate);
  const startTime = timeColumnFromClock(input.startTime);
  const endTime = timeColumnFromClock(input.endTime);

  const row = await prisma.work_schedules.upsert({
    where: { employee_id_shift_date: { employee_id: input.employeeId, shift_date: shiftDate } },
    update: { start_time: startTime, end_time: endTime, note: input.note ?? null },
    create: {
      employee_id: input.employeeId,
      shift_date: shiftDate,
      start_time: startTime,
      end_time: endTime,
      note: input.note ?? null,
      created_by: input.createdBy,
    },
    include: { employee: { select: { full_name: true, phone: true } } },
  });

  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee.full_name,
    employeePhone: row.employee.phone,
    shiftDate: dayFromDateColumn(row.shift_date),
    startTime: clockFromTimeColumn(row.start_time),
    endTime: clockFromTimeColumn(row.end_time),
    note: row.note,
  };
}

/** One roster row by id, or throws. */
export async function loadSchedule(scheduleId: number): Promise<ScheduleRow> {
  const row = await prisma.work_schedules.findUnique({
    where: { id: scheduleId },
    include: { employee: { select: { full_name: true, phone: true } } },
  });
  if (!row) {
    throw new NotFoundError(`Work schedule #${scheduleId}`);
  }

  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee.full_name,
    employeePhone: row.employee.phone,
    shiftDate: dayFromDateColumn(row.shift_date),
    startTime: clockFromTimeColumn(row.start_time),
    endTime: clockFromTimeColumn(row.end_time),
    note: row.note,
  };
}

/** Removes a roster row. */
export async function deleteSchedule(scheduleId: number): Promise<void> {
  const result = await prisma.work_schedules.deleteMany({ where: { id: scheduleId } });
  if (result.count === 0) {
    throw new NotFoundError(`Work schedule #${scheduleId}`);
  }
}

/** Active employees and admins who can be rostered or clocked in. */
export async function listStaff(): Promise<StaffMember[]> {
  const users = await prisma.users.findMany({
    where: { is_active: true, role: { in: ['employee', 'admin'] } },
    orderBy: { full_name: 'asc' },
    select: { id: true, full_name: true, phone: true, role: true },
  });

  return users.map((user) => ({
    id: user.id,
    fullName: user.full_name,
    phone: user.phone,
    role: user.role,
  }));
}

// ------------------------------------------------------- staff snapshot

/**
 * Everything the staff time-clock screen shows, in one round trip.
 *
 * Assembled from the same readers the admin board uses, so the employee and the
 * manager are looking at one set of numbers rather than two implementations that
 * happen to agree today.
 */
export async function staffAttendanceSnapshot(input: {
  employeeId: string;
  day: string;
  now?: Date;
}): Promise<StaffAttendanceSnapshot> {
  // One day, turned into instants by the same resolver the reports use.
  const day = resolveBangkokRange({ from: input.day, to: input.day }, input.now);

  const [openLog, schedule, logs] = await Promise.all([
    getOpenLog(input.employeeId),
    getScheduleForDay(input.employeeId, input.day),
    listAttendanceRows({
      from: day.fromDate,
      toExclusive: day.toExclusive,
      employeeId: input.employeeId,
    }),
  ]);

  const hoursToday = logs.reduce(
    (total, log) => total + (log.workHours ?? 0),
    0,
  );

  return {
    openLog,
    schedule,
    logs,
    hoursToday: Math.round(hoursToday * 100) / 100,
  };
}

/** Re-exported for callers that need a transaction client type. */
export type { Db };
