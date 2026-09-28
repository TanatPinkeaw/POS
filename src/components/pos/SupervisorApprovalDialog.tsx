'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button, InlineNotice, Overlay, PinPad, SelectField, Spinner } from '@/components/ds';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import {
  PIN_LENGTH,
  SUPERVISOR_ACTION_LABELS,
  type SupervisorAction,
  type SupervisorOption,
} from '@/lib/supervisor-view';

import styles from './SupervisorApprovalDialog.module.css';

export interface ApprovalGrant {
  token: string;
  approverName: string;
}

interface ApprovalResponse {
  token: string;
  expiresAt: string;
  actionLabel: string;
  approverName: string;
}

const NO_SUPERVISORS_MESSAGE =
  'ยังไม่มีผู้ดูแลที่ตั้ง PIN ไว้ — ให้ผู้จัดการตั้ง PIN ในหน้า "พนักงาน" ก่อน';

/**
 * Asking a supervisor to approve what a cashier may not do alone.
 *
 * The PIN goes in on a pad, into state the component never renders back: no
 * digits, no dots, no count of what has been typed. The line above the pad says
 * how many digits are still wanted, which is what the person typing actually
 * needs, and nothing leaks to the queue behind them.
 *
 * `targetId` is a prop rather than something this component invents, because the
 * approval is bound to it: the till passes the discount amount or the shift, and
 * the gated request then has to present a token for that same value. If this
 * component could choose the target, it could ask for one approval and spend it
 * on something else.
 *
 * Failures are shown in place, with the attempts remaining, because "wrong PIN"
 * and "locked for five minutes" lead to different next actions — try again, or go
 * and find somebody else. Both facts come from the server's `context`; this dialog
 * only renders them.
 */
export function SupervisorApprovalDialog({
  open,
  action,
  targetId,
  summary,
  onCancel,
  onApproved,
}: {
  open: boolean;
  action: SupervisorAction;
  /** What the approval is for: the discount amount, the shift, the bill. */
  targetId: string;
  /** What is being approved, in the operator's own words. */
  summary?: string;
  onCancel: () => void;
  onApproved: (grant: ApprovalGrant) => void;
}) {
  const [supervisors, setSupervisors] = useState<SupervisorOption[] | null>(null);
  const [selected, setSelected] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    setSupervisors(null);
    try {
      const payload = await apiFetch<{ supervisors: SupervisorOption[] }>(
        '/api/v1/pos/approvals',
      );
      setSupervisors(payload.supervisors);
      // One supervisor is the ordinary case in a small shop, so the picker stays
      // out of the way and the name is stated instead.
      setSelected(payload.supervisors.length === 1 ? payload.supervisors[0]!.id : '');
    } catch (caught) {
      setSupervisors([]);
      setError(caught instanceof Error ? caught.message : 'โหลดรายชื่อผู้ดูแลไม่สำเร็จ');
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setPin('');
      setError(null);
      setLocked(false);
      return;
    }
    void load();
  }, [open, load]);

  const submit = useCallback(
    async (candidate: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const grant = await apiPost<ApprovalResponse>('/api/v1/pos/approvals', {
          supervisorId: selected,
          pin: candidate,
          action,
          targetId,
        });
        setPin('');
        onApproved({ token: grant.token, approverName: grant.approverName });
      } catch (caught) {
        setPin('');
        if (caught instanceof ApiError) {
          setError(caught.message);
          if (caught.code === 'PIN_LOCKED') {
            setLocked(true);
          }
        } else {
          setError('ขออนุมัติไม่สำเร็จ');
        }
      } finally {
        setBusy(false);
      }
    },
    [action, onApproved, selected, targetId],
  );

  const append = (digit: string): void => {
    if (busy || locked) {
      return;
    }
    setError(null);
    const next = (pin + digit).slice(0, PIN_LENGTH);
    setPin(next);
    // The fourth digit submits: there is nothing left to type, and one fewer tap
    // between asking and being answered.
    if (next.length === PIN_LENGTH) {
      void submit(next);
    }
  };

  const none = supervisors !== null && supervisors.length === 0;

  return (
    <Overlay
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title={SUPERVISOR_ACTION_LABELS[action]}
      description={summary ?? 'ต้องให้ผู้ดูแลอนุมัติก่อนจึงจะทำรายการนี้ได้'}
      footer={
        none ? (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            ปิด
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              ยกเลิก
            </Button>
            <Button
              variant="primary"
              icon="lock"
              loading={busy}
              disabled={
                busy ||
                locked ||
                selected === '' ||
                pin.length !== PIN_LENGTH ||
                supervisors === null
              }
              onClick={() => void submit(pin)}
            >
              อนุมัติ
            </Button>
          </>
        )
      }
    >
      {supervisors === null ? (
        <div className={styles.center}>
          <Spinner label="กำลังโหลด…" />
        </div>
      ) : none ? (
        <InlineNotice tone="warning">{NO_SUPERVISORS_MESSAGE}</InlineNotice>
      ) : (
        <div className={styles.body}>
          {supervisors.length > 1 ? (
            <SelectField
              id="supervisor"
              label="ผู้อนุมัติ"
              value={selected}
              disabled={busy || locked}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">เลือกผู้ดูแล</option>
              {supervisors.map((supervisor) => (
                <option key={supervisor.id} value={supervisor.id}>
                  {supervisor.fullName}
                </option>
              ))}
            </SelectField>
          ) : (
            <p className={styles.who}>
              ผู้อนุมัติ <strong>{supervisors[0]?.fullName}</strong>
            </p>
          )}

          <div className={styles.pinRow} aria-hidden="true">
            {Array.from({ length: PIN_LENGTH }, (_, index) => (
              <span
                key={index}
                className={`${styles.pinSlot} ${index < pin.length ? styles.pinFilled : ''}`}
              />
            ))}
          </div>

          <p className={styles.pinHint} role="status" aria-live="polite">
            {locked
              ? 'PIN ถูกล็อกชั่วคราว ลองใหม่ภายหลัง'
              : `กรอก PIN ${PIN_LENGTH} หลักของผู้อนุมัติ`}
          </p>

          <PinPad
            disabled={busy || locked || selected === ''}
            onInput={append}
            onBackspace={() => setPin((current) => current.slice(0, -1))}
            onClear={() => setPin('')}
          />

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Overlay>
  );
}
