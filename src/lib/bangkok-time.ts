/**
 * Bangkok wall-clock helpers.
 *
 * The shop runs on Thai time, and two features need to agree on what "today"
 * means: the SRS §8 exports (which bucket rows by calendar day) and the
 * attendance roster (which compares a check-in against the day it was rostered
 * for). Sharing one implementation is the only way those two can't drift.
 *
 * Thailand is UTC+7 year-round — no daylight saving — so shifting by a constant
 * and reading the UTC fields yields Bangkok components exactly, without
 * involving `Intl` and therefore without depending on the host's ICU build.
 *
 * Pure: no Prisma, no `node:` imports.
 */
import { ValidationError } from './errors';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Milliseconds in a day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

const pad2 = (value: number): string => value.toString().padStart(2, '0');

export interface BangkokParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The Bangkok wall-clock components of an instant. */
export function bangkokParts(date: Date): BangkokParts {
  const shifted = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** `YYYY-MM-DD` for the Bangkok calendar day containing `date`. */
export function bangkokDateString(date: Date): string {
  const { year, month, day } = bangkokParts(date);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** `HH:mm` in Bangkok. */
export function bangkokTimeString(date: Date): string {
  const { hour, minute } = bangkokParts(date);
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** `DD/MM/YYYY` in Bangkok. */
export function bangkokDayString(date: Date): string {
  const { year, month, day } = bangkokParts(date);
  return `${pad2(day)}/${pad2(month)}/${year}`;
}

/** `DD/MM/YYYY HH:mm` in Bangkok — the form Excel shows in a text cell. */
export function bangkokDateTimeString(date: Date): string {
  const { year, month, day } = bangkokParts(date);
  return `${pad2(day)}/${pad2(month)}/${year} ${bangkokTimeString(date)}`;
}

/** Minutes past Bangkok midnight. */
export function bangkokMinutesOfDay(date: Date): number {
  const { hour, minute } = bangkokParts(date);
  return hour * 60 + minute;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses `YYYY-MM-DD` as Bangkok midnight, rejecting impossible dates. */
export function parseBangkokDay(value: string): Date {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new ValidationError(`วันที่ "${value}" ต้องอยู่ในรูปแบบ YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00+07:00`);
  // Guards against 2026-02-31 silently rolling over to 3 March.
  if (Number.isNaN(date.getTime()) || bangkokDateString(date) !== value) {
    throw new ValidationError(`วันที่ "${value}" ไม่ใช่วันที่ที่มีอยู่จริงในปฏิทิน`);
  }
  return date;
}

/**
 * The instants a Bangkok calendar day spans: inclusive midnight to the next.
 *
 * The half-open pair is the shape every day-scoped query wants — `>= from` and
 * `< to` — and writing it out at each call site is how a query ends up including
 * the first second of tomorrow and counting a sale twice across two screens.
 */
export function bangkokDayBounds(now: Date = new Date()): { from: Date; to: Date } {
  const day = bangkokDateString(now);
  return {
    from: parseBangkokDay(day),
    to: parseBangkokDay(addBangkokDays(day, 1)),
  };
}

/**
 * True when `value` is a `YYYY-MM-DD` that names a real Bangkok day.
 *
 * The boolean sibling of `parseBangkokDay`, for validators that want to reject a
 * value rather than throw on it.
 */
export function isValidCalendarDay(value: string): boolean {
  try {
    parseBangkokDay(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A `@db.Date` column value from a `YYYY-MM-DD` string.
 *
 * Prisma reads and writes `date` columns at UTC midnight, so anchoring the
 * calendar day to UTC (not to Bangkok) is what makes the value round-trip.
 */
export function dateColumnFromDay(value: string): Date {
  parseBangkokDay(value); // validates
  return new Date(`${value}T00:00:00.000Z`);
}

/** The `YYYY-MM-DD` a `@db.Date` column value represents. */
export function dayFromDateColumn(value: Date): string {
  return value.toISOString().slice(0, 10);
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True when `value` is a valid 24-hour `HH:MM`. */
export function isClock(value: string): boolean {
  return CLOCK_PATTERN.test(value);
}

/**
 * A `@db.Time` column value from an `HH:MM` string.
 *
 * Prisma maps `time` to `Date`, anchored at 1970-01-01 UTC, so the clock is
 * built there and read back with the UTC getters.
 */
export function timeColumnFromClock(value: string): Date {
  if (!isClock(value)) {
    throw new ValidationError(`เวลา "${value}" ต้องอยู่ในรูปแบบ HH:MM`);
  }
  const [hour, minute] = value.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0, 0));
}

/** The `HH:MM` a `@db.Time` column value represents. */
export function clockFromTimeColumn(value: Date): string {
  return `${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}`;
}

const LOCAL_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** True when `value` looks like the `<input type="datetime-local">` shape. */
export function isLocalDateTime(value: string): boolean {
  return LOCAL_DATETIME_PATTERN.test(value);
}

/**
 * An instant from a `YYYY-MM-DDTHH:MM` string read as Bangkok time.
 *
 * `<input type="datetime-local">` has no timezone, so parsing it with `new Date`
 * would silently use the server's locale. Anchoring to +07:00 keeps a manual
 * attendance correction on the hour the manager typed.
 */
export function parseBangkokLocalDateTime(value: string): Date {
  if (!isLocalDateTime(value)) {
    throw new ValidationError(`วันและเวลา "${value}" ต้องอยู่ในรูปแบบ YYYY-MM-DDTHH:MM`);
  }
  const date = new Date(`${value}:00+07:00`);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`วันและเวลา "${value}" ไม่ใช่ช่วงเวลาที่มีอยู่จริง`);
  }
  return date;
}

/** The `YYYY-MM-DDTHH:MM` a Bangkok instant corresponds to (for form fields). */
export function toBangkokLocalDateTime(date: Date): string {
  const { year, month, day } = bangkokParts(date);
  return `${year}-${pad2(month)}-${pad2(day)}T${bangkokTimeString(date)}`;
}

/** `YYYY-MM-DD` for the Bangkok day `offsetDays` away from `from`. */
export function addBangkokDays(day: string, offsetDays: number): string {
  return bangkokDateString(new Date(parseBangkokDay(day).getTime() + offsetDays * MS_PER_DAY));
}

export interface BangkokRange {
  /** Inclusive lower bound, as an instant. */
  fromDate: Date;
  /** Exclusive upper bound, as an instant. */
  toExclusive: Date;
  /** The range as `YYYY-MM-DD`, echoed into filenames and headings. */
  from: string;
  to: string;
}

/**
 * Turns an optional `from`/`to` day range into an instant range.
 *
 * `to` is inclusive of the whole named day, so it becomes an exclusive bound at
 * the next Bangkok midnight — asking for 1–31 August includes all of the 31st.
 * Omitting both parameters defaults to the trailing 30 days.
 */
export function resolveBangkokRange(
  input: { from?: string; to?: string },
  now: Date = new Date(),
): BangkokRange {
  const to = input.to ?? bangkokDateString(now);
  const from = input.from ?? addBangkokDays(to, -29);

  const fromDate = parseBangkokDay(from);
  const toExclusive = new Date(parseBangkokDay(to).getTime() + MS_PER_DAY);

  if (toExclusive <= fromDate) {
    throw new ValidationError('วันที่สิ้นสุดต้องไม่อยู่ก่อนวันที่เริ่ม');
  }

  return { fromDate, toExclusive, from, to };
}
