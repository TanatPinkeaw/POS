'use client';

/**
 * The timesheet board — SRS §6 / §8.
 *
 * Shows the *reality* side of attendance: what people actually clocked, against
 * what they were rostered for. The two admin-only writes here are the back-fill
 * (a shift nobody clocked) and the correction (a row that should not exist);
 * both are corrections to the record rather than everyday actions, which is why
 * the back-fill opens in a dialog with room for its five fields, and why removing
 * a row asks first — a deleted timesheet is a pay dispute with no evidence.
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
  Overlay,
  Pill,
  SelectField,
  Stack,
  TextField,
  type Column,
} from '@/components/ds';
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
  const [removing, setRemoving] = useState<AttendanceRowView | null>(null);

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
      setNotice(`เพิ่มบันทึกเวลาให้ ${created.employeeName} วันที่ ${dayOf(created.checkIn)} แล้ว`);
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
    setBusy(true);
    try {
      await apiFetch(`/api/v1/attendance/${row.logId}`, { method: 'DELETE' });
      setNotice(`ลบบันทึกเวลา #${row.logId} แล้ว`);
      setRemoving(null);
      await reload(from, to, employeeFilter);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ลบบันทึกเวลาไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const pendingNow = rows.filter(isOpen).length;

  const columns: Column<AttendanceRowView>[] = [
    {
      key: 'day',
      header: 'วันที่',
      cardLabel: 'วันที่',
      render: (row) => <span className="ln-num">{dayOf(row.checkIn)}</span>,
    },
    {
      key: 'employee',
      header: 'พนักงาน',
      cardLabel: 'พนักงาน',
      render: (row) => (
        <>
          <span>{row.employeeName}</span>
          <span className="ln-muted ln-mono">{row.employeePhone}</span>
        </>
      ),
    },
    {
      key: 'scheduled',
      header: 'ตาราง (เข้า–ออก)',
      cardLabel: 'ตาราง (เข้า–ออก)',
      render: (row) =>
        row.scheduledStart && row.scheduledEnd ? (
          <span className="ln-num ln-muted">
            {row.scheduledStart}–{row.scheduledEnd}
          </span>
        ) : (
          <span className="ln-muted">—</span>
        ),
    },
    {
      key: 'actual',
      header: 'ลงเวลาจริง',
      cardLabel: 'ลงเวลาจริง',
      render: (row) => (
        <span className="ln-row">
          <span className="ln-num">{timeLabel(row.checkIn)}</span>
          {row.checkOut ? (
            <span className="ln-num">{timeLabel(row.checkOut)}</span>
          ) : (
            <Pill tone="success" icon="clock">
              กำลังทำงาน
            </Pill>
          )}
        </span>
      ),
    },
    {
      key: 'hours',
      header: 'ชั่วโมง',
      cardLabel: 'ชั่วโมง',
      align: 'end',
      render: (row) => <span className="ln-num">{durationLabel(row.workHours)}</span>,
    },
    {
      key: 'lateness',
      header: 'สาย/ล่วงเวลา',
      cardLabel: 'สาย/ล่วงเวลา',
      render: (row) => {
        const label = latenessLabel(row);
        return <Pill tone={latenessTone(label)}>{label}</Pill>;
      },
    },
    {
      key: 'actions',
      header: '',
      cardLabel: 'จัดการ',
      align: 'end',
      render: (row) => (
        <Button variant="ghost" size="sm" icon="trash" onClick={() => setRemoving(row)}>
          ลบ
        </Button>
      ),
    },
  ];

  return (
    <Stack gap="md">
      {notice ? <InlineNotice tone="success">{notice}</InlineNotice> : null}
      {error && !openCorrect ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <Card
        title={`บันทึกเวลาเข้า–ออก (${rows.length})`}
        subtitle={`ช่วง ${from} ถึง ${to}${employeeFilter ? ' · กรองเฉพาะพนักงานที่เลือก' : ''}`}
        actions={
          <Button variant="secondary" size="sm" icon="plus" onClick={() => setOpenCorrect(true)}>
            เพิ่ม/แก้ไขบันทึกเวลา
          </Button>
        }
        toolbar={
          <Stack gap="sm">
            <FieldRow columns={3}>
              <TextField
                  id="att-from"
                label="จากวันที่"
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  void reload(event.target.value, to, employeeFilter);
                }}
              />
              <TextField
                id="att-to"
                label="ถึงวันที่"
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  void reload(from, event.target.value, employeeFilter);
                }}
              />
              <SelectField
                id="att-employee"
                label="พนักงาน"
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
              </SelectField>
            </FieldRow>

            {/*
             * Counted from live data and refreshed by the realtime event, so the
             * change is announced rather than only visible.
             */}
            <span role="status" aria-live="polite">
              <Pill tone={pendingNow > 0 ? 'success' : 'neutral'} icon="clock">
                {pendingNow > 0 ? `กำลังทำงาน ${pendingNow} คน` : 'ไม่มีใครลงเวลาเปิดไว้'}
              </Pill>
            </span>
          </Stack>
        }
        flush
      >
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => String(row.logId)}
          caption="บันทึกเวลาเข้า–ออกของพนักงาน"
          dense
          empty={
            <EmptyState
              icon="clock"
              title="ไม่มีบันทึกเวลาในช่วงนี้"
              description="พนักงานลงเวลาที่หน้า “ลงเวลาทำงาน” หรือผู้จัดการเพิ่มย้อนหลังได้จากปุ่มด้านบน"
            />
          }
        />
      </Card>

      <Overlay
        open={openCorrect}
        onClose={() => setOpenCorrect(false)}
        title="เพิ่ม/แก้ไขบันทึกเวลา"
        description="ใช้เมื่อพนักงานลืมลงเวลา — เวลาที่กรอกหมายถึงเวลาประเทศไทยเสมอ"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpenCorrect(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button loading={busy} disabled={!manual.employeeId} onClick={() => void addManual()}>
              บันทึก
            </Button>
          </>
        }
      >
        <Stack gap="md">
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

          <SelectField
            id="manual-employee"
            label="พนักงาน"
            value={manual.employeeId}
            onChange={(event) => setManual({ ...manual, employeeId: event.target.value })}
          >
            {staff.map((member) => (
              <option key={member.id} value={member.id}>
                {member.fullName}
              </option>
            ))}
          </SelectField>

          <FieldRow columns={2}>
            <TextField
              id="manual-in"
              label="เวลาเข้า"
              type="datetime-local"
              value={manual.checkIn}
              onChange={(event) => setManual({ ...manual, checkIn: event.target.value })}
            />
            <TextField
              id="manual-out"
              label="เวลาออก (เว้นได้)"
              type="datetime-local"
              help="เว้นว่างไว้ได้ ถ้ายังไม่เลิกงาน"
              value={manual.checkOut}
              onChange={(event) => setManual({ ...manual, checkOut: event.target.value })}
            />
          </FieldRow>

          <TextField
            id="manual-note"
            label="หมายเหตุ"
            placeholder="ลืมลงเวลา"
            autoComplete="off"
            value={manual.note}
            onChange={(event) => setManual({ ...manual, note: event.target.value })}
          />

          <InlineNotice tone="info">
            เวลาที่กรอกหมายถึงเวลาประเทศไทย (UTC+7) เสมอ ไม่ขึ้นกับ timezone ของเบราว์เซอร์
          </InlineNotice>
        </Stack>
      </Overlay>

      <ConfirmDialog
        open={removing !== null}
        title="ลบบันทึกเวลานี้?"
        description={
          removing
            ? `บันทึกของ ${removing.employeeName} วันที่ ${dayOf(removing.checkIn)} จะหายไปจากรายงาน — ย้อนกลับไม่ได้`
            : undefined
        }
        confirmLabel="ลบบันทึกเวลา"
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
