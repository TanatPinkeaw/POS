'use client';

import { useCallback, useState } from 'react';

import { Button, Card, InlineNotice, Pill, SelectField, Spinner } from '@/components/ds';
import { apiFetch } from '@/lib/client-api';
import { bangkokDayString, bangkokTimeString } from '@/lib/bangkok-time';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_TONES,
  auditTargetLabel,
  type AuditAction,
  type AuditRow,
} from '@/lib/audit-view';

import styles from './AuditTrail.module.css';

interface AuditPayload {
  entries: AuditRow[];
  total: number;
}

/**
 * The audit trail, as a screen.
 *
 * Two columns because that is what the trail is *for*: the left one answers "who
 * let this through", the right one answers "who was at the till". Showing one
 * and calling the row a name is how a trail becomes a list of events nobody can
 * act on — the void has a name, but not the name of the person who did it.
 *
 * Filtering is by action rather than free text, and paging walks backwards by id.
 * The trail grows while it is being read, so an offset would show the same row
 * twice the moment something new is written.
 */
export function AuditTrail({
  initialEntries,
  initialTotal,
}: {
  initialEntries: AuditRow[];
  initialTotal: number;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [total, setTotal] = useState(initialTotal);
  const [action, setAction] = useState<AuditAction | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(initialEntries.length >= initialTotal);

  const load = useCallback(async (filter: AuditAction | '', beforeId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter) {
        params.set('action', filter);
      }
      if (beforeId) {
        params.set('beforeId', beforeId);
      }
      const query = params.toString();
      const payload = await apiFetch<AuditPayload>(
        `/api/v1/audit${query ? `?${query}` : ''}`,
      );

      if (beforeId) {
        setEntries((current) => [...current, ...payload.entries]);
        setExhausted(payload.entries.length === 0 || entries.length + payload.entries.length >= payload.total);
      } else {
        setEntries(payload.entries);
        setExhausted(payload.entries.length >= payload.total);
      }
      setTotal(payload.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'โหลดประวัติไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }, [entries.length]);

  return (
    <Card
      /*
       * The count rides in the title, the way every other list on these screens
       * states its size. It also keeps the card's heading from repeating the
       * page's `<h1>` word for word, which reads as a stutter to a screen reader
       * moving by heading.
       */
      title={`ประวัติการใช้งาน (${total})`}
      subtitle="รายการที่ต้องมีผู้อนุมัติ ระบบบันทึกทั้งคนที่กดและคนที่อนุมัติ — ลบหรือแก้ย้อนหลังไม่ได้"
      toolbar={
        <SelectField
          id="audit-action"
          label="ประเภท"
          hideLabel
          value={action}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value as AuditAction | '';
            setAction(next);
            void load(next);
          }}
        >
          <option value="">ทุกประเภท ({total})</option>
          {AUDIT_ACTIONS.map((value) => (
            <option key={value} value={value}>
              {AUDIT_ACTION_LABELS[value]}
            </option>
          ))}
        </SelectField>
      }
      flush
    >
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {entries.length === 0 ? (
        <p className={styles.empty}>
          ยังไม่มีรายการ — ประวัติจะเริ่มมีเมื่อมีการยกเลิกบิล ส่วนลดเกินวงเงิน
          หรือการเปิดลิ้นชักที่ต้องอนุมัติ
        </p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">เวลา</th>
                <th scope="col">รายการ</th>
                <th scope="col">รายละเอียด</th>
                <th scope="col">ผู้อนุมัติ</th>
                <th scope="col">ผู้ทำรายการ</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((row) => (
                <tr key={row.id}>
                  <td className={styles.time}>
                    <span>{bangkokTimeString(new Date(row.createdAt))}</span>
                    <span className={styles.date}>
                      {bangkokDayString(new Date(row.createdAt))}
                    </span>
                  </td>
                  <td>
                    <Pill tone={AUDIT_ACTION_TONES[row.action]}>{AUDIT_ACTION_LABELS[row.action]}</Pill>
                  </td>
                  <td>{auditTargetLabel(row)}</td>
                  <td className={styles.who}>{row.authorizedBy?.fullName ?? '—'}</td>
                  <td className={styles.who}>{row.actor?.fullName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.foot}>
        <span className={styles.count}>
          แสดง {entries.length} จาก {total} รายการ
        </span>
        {exhausted ? null : (
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => void load(action, entries[entries.length - 1]?.id)}
          >
            โหลดเพิ่ม
          </Button>
        )}
        {busy && entries.length === 0 ? <Spinner label="กำลังโหลด…" /> : null}
      </div>
    </Card>
  );
}
