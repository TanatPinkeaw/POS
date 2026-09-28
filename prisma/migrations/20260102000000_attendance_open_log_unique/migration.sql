-- ---------------------------------------------------------------------------
-- Attendance: at most one open time_log per employee.
--
-- Attendance is a clock you are either on or off. Two open rows for one person
-- would make `work_hours` meaningless and double-count the timesheet, and a
-- double-tapped "ลงเวลาเข้า" is the obvious way to get there. A partial unique
-- index states the invariant in the database, so no application path — a
-- double-tap, a retry, or a future caller — can create a second open row.
--
-- Hand-written for the same reason as the rest of this migration set: a partial
-- index is not expressible in the Prisma schema language, so this database must
-- be kept in sync with `prisma migrate deploy` and never `migrate dev`.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "ux_time_logs_open_per_employee"
    ON "time_logs" ("employee_id")
    WHERE "check_out" IS NULL;
