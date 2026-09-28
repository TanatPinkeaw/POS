'use client';

/**
 * Roster management — SRS §6.
 *
 * One screen does two jobs: it writes a shift, and it lists the shifts already on
 * the books so a manager can see the week they are shaping. Creating a shift is
 * an upsert, so re-submitting the same employee/day is a correction rather than
 * a duplicate — the button says "บันทึก" (save), not "add", for that reason.
 *
 * The form stays inline rather than moving into a dialog, unlike the one-off
 * corrections elsewhere: a manager rostering eight people fills it eight times in
 * a row, and eight modal round-trips is a worse deal than a form that is already
 * on screen. Deleting a shift does ask first, because that silently changes what
 * everyone's lateness is measured against.
 */
import { useCallback, useState } from 'react';

import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FieldRow,
  InlineNotice,
  SelectField,
  Stack,
  TextField,
  type Column,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import type { ScheduleView, StaffMemberView } from '@/lib/attendance-view';
import { ROLE_LABEL, type Role } from '@/lib/roles';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

/**
 * The roster only ever shows staff, but the label itself is shared so an admin
 * is called the same thing here as in the sidebar and in a refusal message.
 * A member can never appear in this list, hence the plain-string index.
 */
function staffRoleLabel(role: string): string {
  return ROLE_LABEL[role as Role] ?? role;
}

export function ScheduleManager({
  staff,
  initialSchedules,
  initialFrom,
  initialTo,
  today,
}: {
  staff: StaffMemberView[];
  initialSchedules: ScheduleView[];
  initialFrom: string;
  initialTo: string;
  today: string;
}) {
  const [schedules, setSchedules] = useState(initialSchedules);
  // Seeded from the window the server actually loaded, never from a locally
  // recomputed guess: a date control that disagrees with its own table is a
  // control that silently denies a day it is currently showing.
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ScheduleView | null>(null);

  const [form, setForm] = useState({
    employeeId: staff[0]?.id ?? '',
    shiftDate: today,
    startTime: '09:00',
    endTime: '17:30',
    note: '',
  });

  const reload = useCallback(async (rangeFrom: string, rangeTo: string, employeeId: string) => {
    try {
      const params = new URLSearchParams({ from: rangeFrom, to: rangeTo });
      if (employeeId) {
        params.set('employeeId', employeeId);
      }
      const result = await apiFetch<{ rows: ScheduleView[] }>(
        `/api/v1/schedules?${params.toString()}`,
      );
      setSchedules(result.rows);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'อ่านตารางงานไม่สำเร็จ');
    }
  }, []);

  // Any roster change anywhere refreshes this board.
  useRealtimeEvent(REALTIME_EVENTS.attendanceUpdated, () => {
    void reload(from, to, employeeFilter);
  });

  const save = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const saved = await apiPost<ScheduleView>('/api/v1/schedules', {
        employeeId: form.employeeId,
        shiftDate: form.shiftDate,
        startTime: form.startTime,
        endTime: form.endTime,
        note: form.note || null,
      });
      setNotice(
        `บันทึกตารางงานของ ${saved.employeeName} วันที่ ${saved.shiftDate} (${saved.startTime}–${saved.endTime})`,
      );
      await reload(from, to, employeeFilter);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'บันทึกตารางงานไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (schedule: ScheduleView): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiFetch(`/api/v1/schedules/${schedule.id}`, { method: 'DELETE' });
      setNotice(`ลบตารางงานของ ${schedule.employeeName} วันที่ ${schedule.shiftDate} แล้ว`);
      setRemoving(null);
      await reload(from, to, employeeFilter);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ลบตารางงานไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<ScheduleView>[] = [
    {
      key: 'date',
      header: 'วันที่',
      cardLabel: 'วันที่',
      render: (schedule) => <span className="ln-num">{schedule.shiftDate}</span>,
    },
    {
      key: 'employee',
      header: 'พนักงาน',
      cardLabel: 'พนักงาน',
      render: (schedule) => (
        <>
          <span>{schedule.employeeName}</span>
          <span className="ln-muted ln-mono">{schedule.employeePhone}</span>
        </>
      ),
    },
    {
      key: 'shift',
      header: 'กะ',
      cardLabel: 'กะ',
      render: (schedule) => (
        <span className="ln-num">
          {schedule.startTime}–{schedule.endTime}
        </span>
      ),
    },
    {
      key: 'note',
      header: 'หมายเหตุ',
      cardLabel: 'หมายเหตุ',
      render: (schedule) =>
        schedule.note ? <span className="ln-break">{schedule.note}</span> : <span className="ln-muted">—</span>,
    },
    {
      key: 'actions',
      header: '',
      cardLabel: 'จัดการ',
      align: 'end',
      render: (schedule) => (
        <Button variant="ghost" size="sm" icon="trash" onClick={() => setRemoving(schedule)}>
          ลบ
        </Button>
      ),
    },
  ];

  return (
    <Stack gap="lg">
      {notice ? <InlineNotice tone="success">{notice}</InlineNotice> : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <Card title="จัดตารางงาน" subtitle="หนึ่งพนักงานหนึ่งกะต่อวัน — บันทึกทับได้ถ้าต้องแก้">
        <Stack gap="md">
          <FieldRow columns={3}>
            <SelectField
              id="sch-employee"
              label="พนักงาน"
              value={form.employeeId}
              onChange={(event) => setForm({ ...form, employeeId: event.target.value })}
            >
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.fullName} ({staffRoleLabel(member.role)})
                </option>
              ))}
            </SelectField>
            <TextField
              id="sch-date"
              label="วันที่"
              type="date"
              value={form.shiftDate}
              onChange={(event) => setForm({ ...form, shiftDate: event.target.value })}
            />
            <TextField
              id="sch-note"
              label="หมายเหตุ"
              placeholder="เช่น กะเช้า / ดูแลคลัง"
              autoComplete="off"
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
          </FieldRow>

          <FieldRow columns={2}>
            <TextField
              id="sch-start"
              label="เข้า"
              type="time"
              className="ln-num"
              value={form.startTime}
              onChange={(event) => setForm({ ...form, startTime: event.target.value })}
            />
            <TextField
              id="sch-end"
              label="ออก"
              type="time"
              className="ln-num"
              value={form.endTime}
              onChange={(event) => setForm({ ...form, endTime: event.target.value })}
            />
          </FieldRow>

          <div>
            <Button
              icon="check"
              loading={busy}
              disabled={!form.employeeId}
              onClick={() => void save()}
            >
              บันทึกตารางงาน
            </Button>
          </div>
        </Stack>
      </Card>

      <Card
        title={`ตารางงาน (${schedules.length})`}
        subtitle={`ช่วง ${from} ถึง ${to}${employeeFilter ? ' · กรองเฉพาะพนักงานที่เลือก' : ''}`}
        toolbar={
          <FieldRow columns={3}>
            <TextField
              id="sch-from"
              label="จากวันที่"
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                void reload(event.target.value, to, employeeFilter);
              }}
            />
            <TextField
              id="sch-to"
              label="ถึงวันที่"
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                void reload(from, event.target.value, employeeFilter);
              }}
            />
            <SelectField
              id="sch-filter"
              label="กรองตามพนักงาน"
              value={employeeFilter}
              onChange={(event) => {
                setEmployeeFilter(event.target.value);
                void reload(from, to, event.target.value);
              }}
            >
              <option value="">พนักงานทุกคน</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.fullName}
                </option>
              ))}
            </SelectField>
          </FieldRow>
        }
        flush
      >
        <DataTable
          columns={columns}
          rows={schedules}
          getRowKey={(schedule) => String(schedule.id)}
          caption="ตารางงานของพนักงาน"
          dense
          empty={
            <EmptyState
              icon="calendar"
              title="ยังไม่มีตารางงานในช่วงนี้"
              description="เพิ่มกะด้านบน แล้วรายงานเวลาทำงานจะคำนวณสาย/ล่วงเวลาให้อัตโนมัติ"
            />
          }
        />
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title="ลบตารางงานนี้?"
        description={
          removing
            ? `กะของ ${removing.employeeName} วันที่ ${removing.shiftDate} จะหายไป และการคำนวณสาย/ล่วงเวลาของวันนั้นจะไม่เทียบกับตารางอีก`
            : undefined
        }
        confirmLabel="ลบตารางงาน"
        busy={busy}
        onConfirm={() => {
          if (removing) {
            void remove(removing);
          }
        }}
        onCancel={() => setRemoving(null)}
      />
    </Stack>
  );
}

/** Two weeks forward: a roster is read ahead, not behind. */
