'use client';

/**
 * The staff time clock — SRS §6.
 *
 * One button, because that is the whole interaction: you are either on the clock
 * or off it. The roster is shown next to the button so an employee can see the
 * shift they are being measured against, and the day's total is shown so nobody
 * has to add it up themselves before going home.
 *
 * The clock is a `SplitPane` rather than two Bootstrap columns: the button keeps
 * its width while the log beside it grows, and below the breakpoint the pane the
 * employee came for — the button — comes first, with the timesheet underneath.
 */
import { useCallback, useState } from 'react';

import {
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineNotice,
  Pill,
  SplitPane,
  Stack,
  Stat,
  TextField,
  type Column,
} from '@/components/ds';
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

  const columns: Column<AttendanceRowView>[] = [
    {
      key: 'in',
      header: 'เข้า',
      cardLabel: 'เข้า',
      render: (row) => <span className="ln-num">{timeLabel(row.checkIn)}</span>,
    },
    {
      key: 'out',
      header: 'ออก',
      cardLabel: 'ออก',
      render: (row) =>
        row.checkOut ? (
          <span className="ln-num">{timeLabel(row.checkOut)}</span>
        ) : (
          <Pill tone="success" icon="clock">
            กำลังทำงาน
          </Pill>
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
  ];

  return (
    <SplitPane
      side="start"
      panelWidth="24rem"
      stackOrder="panel-first"
      label="ลงเวลาทำงาน"
      panel={
        <Card title="ลงเวลาทำงาน" subtitle={`วันนี้ ${today} (เวลาประเทศไทย)`}>
          <Stack gap="md">
            {notice ? <InlineNotice tone="success">{notice}</InlineNotice> : null}
            {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

            <Stat
              label="สถานะ"
              value={onClock ? 'กำลังทำงานอยู่' : 'ยังไม่ลงเวลาเข้า'}
              hint={
                onClock && snapshot.openLog
                  ? `ลงเวลาเข้าเมื่อ ${timeLabel(snapshot.openLog.checkIn)}`
                  : 'กดปุ่มด้านล่างเมื่อมาถึงร้าน'
              }
              tone={onClock ? 'success' : 'neutral'}
              icon="clock"
            />

            <TextField
              id="clock-note"
              label="หมายเหตุ (ไม่บังคับ)"
              placeholder="เช่น ออกไปส่งของ"
              autoComplete="off"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />

            <Button
              block
              variant={onClock ? 'danger' : 'primary'}
              icon={onClock ? 'logOut' : 'check'}
              loading={busy}
              onClick={() => void toggle()}
            >
              {onClock ? 'ลงเวลาออก' : 'ลงเวลาเข้า'}
            </Button>
          </Stack>
        </Card>
      }
    >
      <Stack gap="lg">
        <Card title="ตารางงานวันนี้" subtitle="กะที่ผู้จัดการจัดไว้">
          {snapshot.schedule ? (
            <dl>
              <Stack gap="sm">
                <div className="ln-row">
                  <dt className="ln-muted">เวลาเข้า–ออกตามตาราง</dt>
                  <dd className="ln-num">
                    {snapshot.schedule.startTime}–{snapshot.schedule.endTime}
                  </dd>
                </div>
                <div className="ln-row">
                  <dt className="ln-muted">หมายเหตุ</dt>
                  <dd className="ln-break">{snapshot.schedule.note ?? '—'}</dd>
                </div>
                <div className="ln-row">
                  <dt className="ln-muted">ชั่วโมงที่ทำไปแล้ววันนี้</dt>
                  <dd className="ln-num">{durationLabel(snapshot.hoursToday)}</dd>
                </div>
              </Stack>
            </dl>
          ) : (
            <Stack gap="sm">
              <p className="ln-muted">วันนี้ยังไม่มีตารางงาน</p>
              <p className="ln-num">ชั่วโมงที่ทำไปแล้ว {durationLabel(snapshot.hoursToday)}</p>
            </Stack>
          )}
        </Card>

        <Card title={`บันทึกของวันนี้ (${snapshot.logs.length})`} flush>
          <DataTable
            columns={columns}
            rows={snapshot.logs}
            getRowKey={(row) => String(row.logId)}
            caption="บันทึกการลงเวลาของวันนี้"
            dense
            empty={
              <EmptyState
                icon="clock"
                title="ยังไม่มีบันทึกเวลาในวันนี้"
                description="กดลงเวลาเข้าเพื่อเริ่มกะแรก"
              />
            }
          />
        </Card>
      </Stack>
    </SplitPane>
  );
}
