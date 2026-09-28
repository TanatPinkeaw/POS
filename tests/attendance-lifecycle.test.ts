// Seam under test: clock in/out and the roster, against a real database.
// The interesting parts are PostgreSQL's: the generated `work_hours` column and
// the partial unique index that makes a second open log impossible.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  checkIn,
  checkOut,
  createManualLog,
  deleteLog,
  getOpenLog,
  getScheduleForDay,
  listAttendanceRows,
  listSchedules,
  listStaff,
  loadAttendanceRow,
  loadSchedule,
  staffAttendanceSnapshot,
  upsertSchedule,
  deleteSchedule,
} from '@/lib/attendance';
import { latenessOvertimeLabel } from '@/lib/attendance-rules';
import { resolveBangkokRange } from '@/lib/bangkok-time';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';

import { prisma, resetDatabase, seedPeople, type TestPeople } from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The Bangkok day the fixtures below all fall on. */
const DAY = '2026-09-27';

describe('clocking in and out', () => {
  it('leaves the log open and work_hours null until the clock-out', async () => {
    const log = await checkIn({ employeeId: people.employeeId, note: 'เริ่มงาน' });

    expect(log.checkOut).toBeNull();
    expect(log.workHours).toBeNull();
    expect(log.employeeName).toBe('แคชเชียร์');

    const open = await getOpenLog(people.employeeId);
    expect(open?.logId).toBe(log.logId);
  });

  it('computes work_hours in the database on clock-out', async () => {
    // 09:00 → 11:30 Bangkok is 2.5 hours.
    await checkIn({ employeeId: people.employeeId, at: new Date('2026-09-27T02:00:00Z') });
    const closed = await checkOut({
      employeeId: people.employeeId,
      at: new Date('2026-09-27T04:30:00Z'),
    });

    expect(closed.workHours).toBe(2.5);
    expect(closed.checkOut?.toISOString()).toBe('2026-09-27T04:30:00.000Z');
    expect(await getOpenLog(people.employeeId)).toBeNull();
  });

  it('refuses a second clock-in while one is open', async () => {
    await checkIn({ employeeId: people.employeeId });
    await expect(checkIn({ employeeId: people.employeeId })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses a clock-out when nobody is clocked in', async () => {
    await expect(checkOut({ employeeId: people.employeeId })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('cannot create a second open log even bypassing the application guard', async () => {
    // The partial unique index is the real invariant; the ConflictError above is
    // only the friendly path to it.
    await checkIn({ employeeId: people.employeeId });
    const failure = await prisma.time_logs
      .create({ data: { employee_id: people.employeeId, check_in: new Date() } })
      .then(() => null)
      .catch((error: unknown) => error as { code?: string });
    expect(failure?.code).toBe('P2002');
  });

  it('allows a new clock-in once the previous log is closed', async () => {
    await checkIn({ employeeId: people.employeeId, at: new Date('2026-09-27T01:00:00Z') });
    await checkOut({ employeeId: people.employeeId, at: new Date('2026-09-27T09:00:00Z') });
    // A second shift on the same day is unusual but legitimate.
    const second = await checkIn({ employeeId: people.employeeId });
    expect(second.checkOut).toBeNull();
  });
});

describe('the roster', () => {
  it('round-trips a shift through the date and time columns', async () => {
    const created = await upsertSchedule({
      employeeId: people.employeeId,
      shiftDate: DAY,
      startTime: '09:00',
      endTime: '17:30',
      note: 'กะเช้า',
      createdBy: people.adminId,
    });

    expect(created).toMatchObject({
      shiftDate: DAY,
      startTime: '09:00',
      endTime: '17:30',
      employeeName: 'แคชเชียร์',
    });

    const fetched = await getScheduleForDay(people.employeeId, DAY);
    expect(fetched?.id).toBe(created.id);
    expect(await loadSchedule(created.id)).toMatchObject({ startTime: '09:00' });
  });

  it('replaces rather than duplicates the same employee and day', async () => {
    const first = await upsertSchedule({
      employeeId: people.employeeId,
      shiftDate: DAY,
      startTime: '09:00',
      endTime: '17:00',
      createdBy: people.adminId,
    });
    const second = await upsertSchedule({
      employeeId: people.employeeId,
      shiftDate: DAY,
      startTime: '10:00',
      endTime: '18:00',
      createdBy: people.adminId,
    });

    expect(second.id).toBe(first.id);
    expect(second.startTime).toBe('10:00');
    await expect(prisma.work_schedules.count()).resolves.toBe(1);
  });

  it('rejects a shift that ends before it starts', async () => {
    await expect(
      upsertSchedule({
        employeeId: people.employeeId,
        shiftDate: DAY,
        startTime: '17:00',
        endTime: '09:00',
        createdBy: people.adminId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('lists a range and deletes a row', async () => {
    const created = await upsertSchedule({
      employeeId: people.employeeId,
      shiftDate: DAY,
      startTime: '09:00',
      endTime: '17:00',
      createdBy: people.adminId,
    });

    const range = resolveBangkokRange({ from: DAY, to: DAY });
    expect(await listSchedules({ from: range.from, to: range.to })).toHaveLength(1);

    await deleteSchedule(created.id);
    expect(await listSchedules({ from: range.from, to: range.to })).toHaveLength(0);
    await expect(deleteSchedule(created.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the timesheet read', () => {
  it('joins a check-in to the roster for the day it happened on', async () => {
    await upsertSchedule({
      employeeId: people.employeeId,
      shiftDate: DAY,
      startTime: '09:00',
      endTime: '17:30',
      createdBy: people.adminId,
    });

    // 09:12 → 17:45 Bangkok: 12 minutes late, 15 minutes overtime.
    await checkIn({ employeeId: people.employeeId, at: new Date('2026-09-27T02:12:00Z') });
    await checkOut({ employeeId: people.employeeId, at: new Date('2026-09-27T10:45:00Z') });

    const range = resolveBangkokRange({ from: DAY, to: DAY });
    const rows = await listAttendanceRows({
      from: range.fromDate,
      toExclusive: range.toExclusive,
    });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      employeeName: 'แคชเชียร์',
      employeePhone: '0800000002',
      scheduledStart: '09:00',
      scheduledEnd: '17:30',
      workHours: 8.55,
    });
    expect(
      latenessOvertimeLabel({
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        scheduledStart: row.scheduledStart,
        scheduledEnd: row.scheduledEnd,
      }),
    ).toBe('สาย 12 นาที · ล่วงเวลา 15 นาที');
  });

  it('still reports a log for a day with no roster, with blank scheduled columns', async () => {
    await checkIn({ employeeId: people.employeeId, at: new Date('2026-09-27T02:00:00Z') });
    await checkOut({ employeeId: people.employeeId, at: new Date('2026-09-27T05:00:00Z') });

    const range = resolveBangkokRange({ from: DAY, to: DAY });
    const rows = await listAttendanceRows({
      from: range.fromDate,
      toExclusive: range.toExclusive,
    });

    expect(rows[0]).toMatchObject({ scheduledStart: null, scheduledEnd: null });
    expect(latenessOvertimeLabel({
      checkIn: rows[0]!.checkIn,
      checkOut: rows[0]!.checkOut,
      scheduledStart: null,
      scheduledEnd: null,
    })).toBe('—');
  });

  it('filters by employee and excludes other days', async () => {
    await checkIn({ employeeId: people.employeeId, at: new Date('2026-09-27T02:00:00Z') });
    await checkIn({ employeeId: people.adminId, at: new Date('2026-09-28T02:00:00Z') });

    const range = resolveBangkokRange({ from: DAY, to: DAY });
    const mine = await listAttendanceRows({
      from: range.fromDate,
      toExclusive: range.toExclusive,
      employeeId: people.employeeId,
    });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.employeeId).toBe(people.employeeId);
  });
});

describe('an admin back-filled timesheet row', () => {
  it('computes hours and can be removed', async () => {
    const log = await createManualLog({
      employeeId: people.employeeId,
      checkIn: new Date('2026-09-27T02:00:00Z'),
      checkOut: new Date('2026-09-27T10:00:00Z'),
      note: 'ลืมลงเวลา',
    });

    expect(log.workHours).toBe(8);
    expect(await loadAttendanceRow(log.logId)).toMatchObject({ note: 'ลืมลงเวลา' });

    await deleteLog(log.logId);
    await expect(loadAttendanceRow(log.logId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a row whose end precedes its start', async () => {
    await expect(
      createManualLog({
        employeeId: people.employeeId,
        checkIn: new Date('2026-09-27T10:00:00Z'),
        checkOut: new Date('2026-09-27T02:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the staff snapshot', () => {
  it('sums the day, exposes the open log, and finds the roster', async () => {
    await upsertSchedule({
      employeeId: people.employeeId,
      shiftDate: DAY,
      startTime: '09:00',
      endTime: '17:30',
      createdBy: people.adminId,
    });

    // One closed 6-hour shift, then clocked back in and still on the clock.
    await checkIn({ employeeId: people.employeeId, at: new Date('2026-09-27T01:00:00Z') });
    await checkOut({ employeeId: people.employeeId, at: new Date('2026-09-27T07:00:00Z') });
    await checkIn({ employeeId: people.employeeId, at: new Date('2026-09-27T08:00:00Z') });

    const snapshot = await staffAttendanceSnapshot({
      employeeId: people.employeeId,
      day: DAY,
    });

    expect(snapshot.openLog).not.toBeNull();
    expect(snapshot.schedule?.startTime).toBe('09:00');
    expect(snapshot.logs).toHaveLength(2);
    // Only the closed shift contributes hours.
    expect(snapshot.hoursToday).toBe(6);
  });

});

describe('listStaff', () => {
  it('returns employees and admins, but never members', async () => {
    const staff = await listStaff();
    expect(staff.map((member) => member.phone)).toContain('0800000002');
    expect(staff.some((member) => member.role === 'member')).toBe(false);
    // The seeded system actor is inactive and must not be rosterable.
    expect(staff).toHaveLength(2);
  });
});
