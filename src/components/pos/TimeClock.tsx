'use client';

/**
 * The staff time clock — SRS §6.
 *
 * One button, because that is the whole interaction: you are either on the clock
 * or off it. The roster is shown next to the button so an employee can see the
 * shift they are being measured against, and the day's total is shown so nobody
 * has to add it up themselves before going home.
 */
import { useCallback, useState } from 'react';

import { Alert, Badge, Card, EmptyState } from '@/components/hope/ui';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import {
  durationLabel,
  latenessLabel,
  latenessTone,
  timeLabel,
  type AttendanceRowView,
  type StaffAttendanceSnapshotView,
} from '@/lib/attendance-view';

export function TimeClock({
  initial,
  today,
}: {
  initial: StaffAttendanceSnapshotView;
  today: string;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const fresh = await apiFetch<StaffAttendanceSnapshotView>(
        `/api/v1/attendance/current?day=${today}`,
      );
      setSnapshot(fresh);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'อ่านข้อมูลการลงเวลาไม่สำเร็จ');
    }
  }, [today]);

  const toggle = async (): Promise<void> => {
    const action = snapshot.openLog ? 'check-out' : 'check-in';
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const row = await apiPost<AttendanceRowView>(`/api/v1/attendance/${action}`, {
        note: note || null,
      });
      setNote('');
      await refresh();
      setNotice(
        action === 'check-in'
          ? `ลงเวลาเข้าแล้วเมื่อ ${timeLabel(row.checkIn)}`
          : `ลงเวลาออกแล้ว — กะนี้ ${durationLabel(row.workHours)}`,
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ลงเวลาไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const onClock = snapshot.openLog !== null;

  return (
    <div className="row g-3">
      <div className="col-12 col-xl-5">
        <Card title="ลงเวลาทำงาน" subtitle={`วันนี้ ${today} (เวลาประเทศไทย)`}>
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

          <div className="d-flex align-items-center gap-3 mb-3">
            <div
              className={`rounded-circle d-flex align-items-center justify-content-center ${onClock ? 'bg-soft-success text-success' : 'bg-soft-secondary text-secondary'}`}
              style={{ width: 56, height: 56 }}
              aria-hidden="true"
            >
              <span className="fs-4">{onClock ? '●' : '○'}</span>
            </div>
            <div>
              {/* `.h5` keeps the size; `h3` is the right level inside a card body. */}
              <h3 className="h5 mb-0">{onClock ? 'กำลังทำงานอยู่' : 'ยังไม่ลงเวลาเข้า'}</h3>
              <span className="text-muted small">
                {onClock && snapshot.openLog
                  ? `ลงเวลาเข้าเมื่อ ${timeLabel(snapshot.openLog.checkIn)}`
                  : 'กดปุ่มด้านล่างเมื่อมาถึงร้าน'}
              </span>
            </div>
          </div>

          <label className="form-label small" htmlFor="clock-note">
            หมายเหตุ (ไม่บังคับ)
          </label>
          <input
            id="clock-note"
            name="note"
            autoComplete="off"
            className="form-control form-control-sm mb-2"
            placeholder="เช่น ออกไปส่งของ"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />

          <button
            type="button"
            className={`btn w-100 ${onClock ? 'btn-outline-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={() => void toggle()}
          >
            {busy ? 'กำลังบันทึก…' : onClock ? 'ลงเวลาออก' : 'ลงเวลาเข้า'}
          </button>
        </Card>
      </div>

      <div className="col-12 col-xl-7">
        <div className="d-flex flex-column gap-3">
          <Card title="ตารางงานวันนี้" subtitle="กะที่ผู้จัดการจัดไว้">
            {snapshot.schedule ? (
              <dl className="row mb-0 small">
                <dt className="col-5 fw-normal text-muted">เวลาเข้า–ออกตามตาราง</dt>
                <dd className="col-7 pos-numeric mb-1">
                  {snapshot.schedule.startTime}–{snapshot.schedule.endTime}
                </dd>
                <dt className="col-5 fw-normal text-muted">หมายเหตุ</dt>
                <dd className="col-7 mb-1">{snapshot.schedule.note ?? '—'}</dd>
                <dt className="col-5 fw-normal text-muted">ชั่วโมงที่ทำไปแล้ววันนี้</dt>
                <dd className="col-7 mb-0 fw-bold pos-numeric">
                  {durationLabel(snapshot.hoursToday)}
                </dd>
              </dl>
            ) : (
              <div className="d-flex justify-content-between align-items-center">
                <span className="text-muted small">วันนี้ยังไม่มีตารางงาน</span>
                <span className="pos-numeric small">
                  ชั่วโมงที่ทำไปแล้ว {durationLabel(snapshot.hoursToday)}
                </span>
              </div>
            )}
          </Card>

          <Card title={`บันทึกของวันนี้ (${snapshot.logs.length})`}>
            {snapshot.logs.length === 0 ? (
              <EmptyState title="ยังไม่มีบันทึกเวลาในวันนี้" />
            ) : (
              <div className="table-responsive">
                <table className="table table-sm align-middle mb-0">
                  <thead>
                    <tr>
                      <th>เข้า</th>
                      <th>ออก</th>
                      <th className="pos-numeric">ชั่วโมง</th>
                      <th>สาย/ล่วงเวลา</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.logs.map((row) => {
                      const label = latenessLabel(row);
                      return (
                        <tr key={row.logId}>
                          <td className="pos-numeric small">{timeLabel(row.checkIn)}</td>
                          <td className="small pos-numeric">
                            {row.checkOut ? (
                              timeLabel(row.checkOut)
                            ) : (
                              <Badge tone="success">กำลังทำงาน</Badge>
                            )}
                          </td>
                          <td className="pos-numeric small">{durationLabel(row.workHours)}</td>
                          <td>
                            <Badge tone={latenessTone(label)}>{label}</Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
