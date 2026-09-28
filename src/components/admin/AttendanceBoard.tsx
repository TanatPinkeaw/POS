'use client';

/**
 * The timesheet board — SRS §6 / §8.
 *
 * Shows the *reality* side of attendance: what people actually clocked, against
 * what they were rostered for. The two admin-only writes here are the back-fill
 * (a shift nobody clocked) and the correction (a row that should not exist);
 * both are corrections to the record rather than everyday actions, which is why
 * they are tucked behind explicit forms.
 */
import { useCallback, useState } from 'react';

import { Alert, Badge, Card, EmptyState } from '@/components/hope/ui';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import {
  dayOf,
  durationLabel,
  isOpen,
  latenessLabel,
  latenessTone,
  timeLabel,
  type AttendanceRowView,
  type StaffMemberView,
} from '@/lib/attendance-view';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

export function AttendanceBoard({
  staff,
  initialRows,
  initialFrom,
  initialTo,
  today,
}: {
  staff: StaffMemberView[];
  initialRows: AttendanceRowView[];
  initialFrom: string;
  initialTo: string;
  today: string;
}) {
  const [rows, setRows] = useState(initialRows);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openCorrect, setOpenCorrect] = useState(false);

  const [manual, setManual] = useState({
    employeeId: staff[0]?.id ?? '',
    checkIn: `${today}T09:00`,
    checkOut: `${today}T17:30`,
    note: '',
  });

  const reload = useCallback(async (rangeFrom: string, rangeTo: string, employeeId: string) => {
    try {
      const params = new URLSearchParams({ from: rangeFrom, to: rangeTo });
      if (employeeId) {
        params.set('employeeId', employeeId);
      }
      const result = await apiFetch<{ rows: AttendanceRowView[] }>(
        `/api/v1/attendance?${params.toString()}`,
      );
      setRows(result.rows);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'อ่านบันทึกเวลาไม่สำเร็จ');
    }
  }, []);

  useRealtimeEvent(REALTIME_EVENTS.attendanceUpdated, () => {
    void reload(from, to, employeeFilter);
  });

  const addManual = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const created = await apiPost<AttendanceRowView>('/api/v1/attendance/manual', {
        employeeId: manual.employeeId,
        checkIn: manual.checkIn,
        checkOut: manual.checkOut || null,
        note: manual.note || null,
      });
      setNotice(
        `เพิ่มบันทึกเวลาให้ ${created.employeeName} วันที่ ${dayOf(created.checkIn)} แล้ว`,
      );
      setOpenCorrect(false);
      await reload(from, to, employeeFilter);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'เพิ่มบันทึกเวลาไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: AttendanceRowView): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/v1/attendance/${row.logId}`, { method: 'DELETE' });
      setNotice(`ลบบันทึกเวลา #${row.logId} แล้ว`);
      await reload(from, to, employeeFilter);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ลบบันทึกเวลาไม่สำเร็จ');
    }
  };

  const pendingNow = rows.filter(isOpen).length;

  return (
    <Card
      title={`บันทึกเวลาเข้า–ออก (${rows.length})`}
      subtitle={`ช่วง ${from} ถึง ${to}${employeeFilter ? ' · กรองเฉพาะพนักงานที่เลือก' : ''}`}
      actions={
        <button
          type="button"
          className="btn btn-sm btn-soft-primary"
          aria-expanded={openCorrect}
          aria-controls="correction-form"
          onClick={() => setOpenCorrect((value) => !value)}
        >
          {openCorrect ? 'ปิดฟอร์ม' : 'เพิ่ม/แก้ไขบันทึกเวลา'}
        </button>
      }
    >
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

      <div className="row g-2 align-items-end mb-3">
        <div className="col-6 col-md-3">
          <label className="form-label small" htmlFor="att-from">
            จากวันที่
          </label>
          <input
            id="att-from"
            name="rangeFrom"
            type="date"
            className="form-control form-control-sm"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              void reload(event.target.value, to, employeeFilter);
            }}
          />
        </div>
        <div className="col-6 col-md-3">
          <label className="form-label small" htmlFor="att-to">
            ถึงวันที่
          </label>
          <input
            id="att-to"
            name="rangeTo"
            type="date"
            className="form-control form-control-sm"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              void reload(from, event.target.value, employeeFilter);
            }}
          />
        </div>
        <div className="col-12 col-md-3">
          <label className="form-label small" htmlFor="att-employee">
            พนักงาน
          </label>
          <select
            id="att-employee"
            name="employeeFilter"
            autoComplete="off"
            className="form-select form-select-sm"
            value={employeeFilter}
            onChange={(event) => {
              setEmployeeFilter(event.target.value);
              void reload(from, to, event.target.value);
            }}
          >
            <option value="">ทุกคน</option>
            {staff.map((member) => (
              <option key={member.id} value={member.id}>
                {member.fullName}
              </option>
            ))}
          </select>
        </div>
        <div className="col-12 col-md-3">
          {/* Counted from live data and refreshed by the realtime event, so the
              change is announced rather than only visible. */}
          <span role="status" aria-live="polite">
            <Badge tone={pendingNow > 0 ? 'success' : 'secondary'}>
              {pendingNow > 0 ? `กำลังทำงาน ${pendingNow} คน` : 'ไม่มีใครลงเวลาเปิดไว้'}
            </Badge>
          </span>
        </div>
      </div>

      {openCorrect && (
        <div id="correction-form" className="border rounded p-2 mb-3">
          <div className="row g-2 align-items-end">
            <div className="col-12 col-md-3">
              <label className="form-label small" htmlFor="manual-employee">
                พนักงาน
              </label>
              <select
                id="manual-employee"
                name="employeeId"
                autoComplete="off"
                className="form-select form-select-sm"
                value={manual.employeeId}
                onChange={(event) => setManual({ ...manual, employeeId: event.target.value })}
              >
                {staff.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-6 col-md-3">
              <label className="form-label small" htmlFor="manual-in">
                เวลาเข้า
              </label>
              <input
                id="manual-in"
                name="checkIn"
                type="datetime-local"
                className="form-control form-control-sm"
                value={manual.checkIn}
                onChange={(event) => setManual({ ...manual, checkIn: event.target.value })}
              />
            </div>
            <div className="col-6 col-md-3">
              <label className="form-label small" htmlFor="manual-out">
                เวลาออก (เว้นได้)
              </label>
              <input
                id="manual-out"
                name="checkOut"
                type="datetime-local"
                className="form-control form-control-sm"
                value={manual.checkOut}
                onChange={(event) => setManual({ ...manual, checkOut: event.target.value })}
              />
            </div>
            <div className="col-8 col-md-2">
              <label className="form-label small" htmlFor="manual-note">
                หมายเหตุ
              </label>
              <input
                id="manual-note"
                name="note"
                autoComplete="off"
                className="form-control form-control-sm"
                placeholder="ลืมลงเวลา"
                value={manual.note}
                onChange={(event) => setManual({ ...manual, note: event.target.value })}
              />
            </div>
            <div className="col-4 col-md-1">
              <button
                type="button"
                className="btn btn-primary btn-sm w-100"
                disabled={busy || !manual.employeeId}
                onClick={() => void addManual()}
              >
                {busy ? '…' : 'บันทึก'}
              </button>
            </div>
          </div>
          <p className="text-muted small mb-0 mt-2">
            เวลาที่กรอกหมายถึงเวลาประเทศไทย (UTC+7) เสมอ ไม่ขึ้นกับ timezone ของเบราว์เซอร์
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="ไม่มีบันทึกเวลาในช่วงนี้"
          description="พนักงานลงเวลาที่หน้า “ลงเวลาทำงาน” หรือผู้จัดการเพิ่มย้อนหลังได้จากปุ่มด้านบน"
        />
      ) : (
        <div className="table-responsive">
          <table className="table table-sm align-middle mb-0">
            <thead>
              <tr>
                <th>วันที่</th>
                <th>พนักงาน</th>
                <th>ตาราง (เข้า–ออก)</th>
                <th>ลงเวลาจริง</th>
                <th className="pos-numeric">ชั่วโมง</th>
                <th>สาย/ล่วงเวลา</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const label = latenessLabel(row);
                return (
                  <tr key={row.logId}>
                    <td className="small">{dayOf(row.checkIn)}</td>
                    <td>
                      <span className="d-block small fw-medium">{row.employeeName}</span>
                      <span className="text-muted small">{row.employeePhone}</span>
                    </td>
                    <td className="small text-muted pos-numeric">
                      {row.scheduledStart && row.scheduledEnd
                        ? `${row.scheduledStart}–${row.scheduledEnd}`
                        : '—'}
                    </td>
                    <td className="small pos-numeric">
                      {timeLabel(row.checkIn)}
                      {' → '}
                      {row.checkOut ? timeLabel(row.checkOut) : (
                        <Badge tone="success">กำลังทำงาน</Badge>
                      )}
                    </td>
                    <td className="pos-numeric">{durationLabel(row.workHours)}</td>
                    <td>
                      <Badge tone={latenessTone(label)}>{label}</Badge>
                    </td>
                    <td className="text-end">
                      <button
                        type="button"
                        className="btn btn-sm btn-soft-danger"
                        onClick={() => void remove(row)}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
