'use client';

/**
 * Roster management — SRS §6.
 *
 * One card does two jobs: it writes a shift, and it lists the shifts already on
 * the books so a manager can see the week they are shaping. Creating a shift is
 * an upsert, so re-submitting the same employee/day is a correction rather than
 * a duplicate — the form says "บันทึก" (save), not "add", for that reason.
 */
import { useCallback, useState } from 'react';

import { Alert, Card, EmptyState } from '@/components/hope/ui';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import type { ScheduleView, StaffMemberView } from '@/lib/attendance-view';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

const ROLE_LABEL: Record<string, string> = {
  admin: 'ผู้จัดการ',
  employee: 'พนักงาน',
};

export function ScheduleManager({
  staff,
  initialSchedules,
  today,
}: {
  staff: StaffMemberView[];
  initialSchedules: ScheduleView[];
  today: string;
}) {
  const [schedules, setSchedules] = useState(initialSchedules);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(() => defaultTo(today));
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    try {
      await apiFetch(`/api/v1/schedules/${schedule.id}`, { method: 'DELETE' });
      setNotice(`ลบตารางงานของ ${schedule.employeeName} วันที่ ${schedule.shiftDate} แล้ว`);
      await reload(from, to, employeeFilter);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ลบตารางงานไม่สำเร็จ');
    }
  };

  return (
    <div className="d-flex flex-column gap-3">
      <Card title="จัดตารางงาน" subtitle="หนึ่งพนักงานหนึ่งกะต่อวัน — บันทึกทับได้ถ้าต้องแก้">
        {notice && (
          <Alert tone="success" className="py-2 small">
            {notice}
          </Alert>
        )}
        {error && (
          <Alert tone="danger" className="py-2 small">
            {error}
          </Alert>
        )}

        <div className="row g-2 align-items-end">
          <div className="col-12 col-md-5">
            <label className="form-label small" htmlFor="sch-employee">
              พนักงาน
            </label>
            <select
              id="sch-employee"
              name="employeeId"
              autoComplete="off"
              className="form-select form-select-sm"
              value={form.employeeId}
              onChange={(event) => setForm({ ...form, employeeId: event.target.value })}
            >
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.fullName} ({ROLE_LABEL[member.role] ?? member.role})
                </option>
              ))}
            </select>
          </div>
          <div className="col-6 col-md-3">
            <label className="form-label small" htmlFor="sch-date">
              วันที่
            </label>
            <input
              id="sch-date"
              name="shiftDate"
              type="date"
              className="form-control form-control-sm"
              value={form.shiftDate}
              onChange={(event) => setForm({ ...form, shiftDate: event.target.value })}
            />
          </div>
          <div className="col-3 col-md-2">
            <label className="form-label small" htmlFor="sch-start">
              เข้า
            </label>
            <input
              id="sch-start"
              name="startTime"
              type="time"
              className="form-control form-control-sm"
              value={form.startTime}
              onChange={(event) => setForm({ ...form, startTime: event.target.value })}
            />
          </div>
          <div className="col-3 col-md-2">
            <label className="form-label small" htmlFor="sch-end">
              ออก
            </label>
            <input
              id="sch-end"
              name="endTime"
              type="time"
              className="form-control form-control-sm"
              value={form.endTime}
              onChange={(event) => setForm({ ...form, endTime: event.target.value })}
            />
          </div>
          <div className="col-12 col-md-8">
            <label className="form-label small" htmlFor="sch-note">
              หมายเหตุ
            </label>
            <input
              id="sch-note"
              name="note"
              autoComplete="off"
              className="form-control form-control-sm"
              placeholder="เช่น กะเช้า / ดูแลคลัง"
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
          </div>
          <div className="col-12 col-md-4">
            <button
              type="button"
              className="btn btn-primary btn-sm w-100"
              disabled={busy || !form.employeeId}
              onClick={() => void save()}
            >
              {busy ? 'กำลังบันทึก…' : 'บันทึกตารางงาน'}
            </button>
          </div>
        </div>
      </Card>

      <Card
        title={`ตารางงาน (${schedules.length})`}
        subtitle="ช่วงวันที่ที่กำลังดู"
        actions={
          <div className="d-flex gap-1">
            <input
              type="date"
              name="rangeFrom"
              className="form-control form-control-sm"
              aria-label="จากวันที่"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                void reload(event.target.value, to, employeeFilter);
              }}
            />
            <input
              type="date"
              name="rangeTo"
              className="form-control form-control-sm"
              aria-label="ถึงวันที่"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                void reload(from, event.target.value, employeeFilter);
              }}
            />
          </div>
        }
      >
        <div className="mb-2">
          <select
            name="employeeFilter"
            autoComplete="off"
            className="form-select form-select-sm"
            aria-label="กรองตามพนักงาน"
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
          </select>
        </div>

        {schedules.length === 0 ? (
          <EmptyState
            title="ยังไม่มีตารางงานในช่วงนี้"
            description="เพิ่มกะด้านบน แล้วรายงานเวลาทำงานจะคำนวณสาย/ล่วงเวลาให้อัตโนมัติ"
          />
        ) : (
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>พนักงาน</th>
                  <th>กะ</th>
                  <th>หมายเหตุ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id}>
                    <td className="small">{schedule.shiftDate}</td>
                    <td>
                      <span className="d-block small fw-medium">{schedule.employeeName}</span>
                      <span className="text-muted small">{schedule.employeePhone}</span>
                    </td>
                    <td className="pos-numeric small">
                      {schedule.startTime}–{schedule.endTime}
                    </td>
                    <td className="small text-muted">{schedule.note ?? '—'}</td>
                    <td className="text-end">
                      <button
                        type="button"
                        className="btn btn-sm btn-soft-danger"
                        onClick={() => void remove(schedule)}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Two weeks forward: a roster is read ahead, not behind. */
function defaultTo(today: string): string {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + 13));
  return date.toISOString().slice(0, 10);
}
