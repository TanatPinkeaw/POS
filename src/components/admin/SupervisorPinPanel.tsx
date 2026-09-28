'use client';

import { useCallback, useState } from 'react';

import {
  Button,
  Card,
  ConfirmDialog,
  InlineNotice,
  Overlay,
  Pill,
  PinPad,
  Stack,
} from '@/components/ds';
import { apiFetch } from '@/lib/client-api';
import { bangkokTimeString } from '@/lib/bangkok-time';
import {
  PIN_LENGTH,
  pinProblem,
  type SupervisorOption,
  type SupervisorStatus,
} from '@/lib/supervisor-view';

import styles from './SupervisorPinPanel.module.css';

/**
 * The supervisor PIN, on the staff screen.
 *
 * Two-step entry — type it, then type it again — because this is a credential
 * nobody can read back: there is no "forgot my PIN" that does not end in an
 * administrator resetting it for you. Asking twice is the cheapest way to make a
 * typo impossible, and the alternative (showing it) would defeat the point of a
 * PIN entered in front of a queue.
 *
 * The panel also states who can approve *right now*, which is the question an
 * owner actually has when the till starts refusing discounts: is anybody in the
 * shop able to say yes? A list of names with a PIN answers it; a single flag on
 * the signed-in admin does not.
 */
export function SupervisorPinPanel({
  status: initialStatus,
  supervisors: initialSupervisors,
  fullName,
}: {
  status: SupervisorStatus;
  supervisors: SupervisorOption[];
  /** The signed-in admin — whose PIN this is. */
  fullName: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [supervisors, setSupervisors] = useState(initialSupervisors);
  const [step, setStep] = useState<'enter' | 'confirm' | null>(null);
  const [pin, setPin] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const [nextStatus, nextList] = await Promise.all([
      apiFetch<SupervisorStatus>('/api/v1/pos/pin'),
      apiFetch<{ supervisors: SupervisorOption[] }>('/api/v1/pos/approvals'),
    ]);
    setStatus(nextStatus);
    setSupervisors(nextList.supervisors);
  }, []);

  const close = (): void => {
    setStep(null);
    setPin('');
    setFirstPin('');
    setError(null);
  };

  const submit = async (candidate: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch<SupervisorStatus>('/api/v1/pos/pin', {
        method: 'POST',
        body: JSON.stringify({ pin: candidate }),
      });
      await refresh();
      setNotice(status.hasPin ? 'เปลี่ยน PIN เรียบร้อยแล้ว' : 'ตั้ง PIN เรียบร้อยแล้ว');
      close();
    } catch (caught) {
      setPin('');
      setFirstPin('');
      setStep('enter');
      setError(caught instanceof Error ? caught.message : 'ตั้ง PIN ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const clearPin = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch<SupervisorStatus>('/api/v1/pos/pin', { method: 'DELETE' });
      await refresh();
      setNotice('ลบ PIN แล้ว — บัญชีนี้จะอนุมัติรายการที่ต้องใช้ PIN ไม่ได้');
      setConfirmClear(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ลบ PIN ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  /** The pad the open step writes into, and where its digits live. */
  const append = (digit: string): void => {
    setError(null);
    if (step === 'enter') {
      const next = (pin + digit).slice(0, PIN_LENGTH);
      setPin(next);
      if (next.length === PIN_LENGTH) {
        // Wait a beat so the fourth dot is visible before the step changes.
        window.setTimeout(() => {
          setFirstPin(next);
          setPin('');
          setStep('confirm');
        }, 120);
      }
      return;
    }

    const next = (pin + digit).slice(0, PIN_LENGTH);
    setPin(next);
    if (next.length === PIN_LENGTH) {
      if (next !== firstPin) {
        setPin('');
        setError('PIN ทั้งสองครั้งไม่ตรงกัน เริ่มใหม่');
        return;
      }
      void submit(next);
    }
  };

  const locked = status.lockedUntil !== null && new Date(status.lockedUntil) > new Date();
  const actionable = supervisors.filter((supervisor) => supervisor.fullName !== fullName);

  return (
    <Card
      title="PIN ผู้ดูแล (อนุมัติรายการพิเศษ)"
      subtitle="ใช้ยืนยันการยกเลิกบิล ส่วนลดเกินวงเงิน เปิดลิ้นชักโดยไม่มีการขาย และยืนยันเงินเข้า"
    >
      <Stack gap="md">
        <div className={styles.row}>
          <span className={styles.label}>สถานะ PIN ของคุณ</span>
          <span className={styles.value}>
            {status.hasPin ? (
              <Pill tone={locked ? 'warning' : 'success'} icon={locked ? 'warning' : 'check'}>
                {locked
                  ? `ถูกล็อกชั่วคราวถึง ${bangkokTimeString(new Date(status.lockedUntil as string))}`
                  : 'ตั้ง PIN ไว้แล้ว'}
              </Pill>
            ) : (
              <Pill tone="neutral">ยังไม่ได้ตั้ง PIN</Pill>
            )}
          </span>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>อนุมัติได้ตอนนี้</span>
          <span className={styles.value}>
            {supervisors.length === 0
              ? 'ยังไม่มีใครตั้ง PIN — รายการที่ต้องอนุมัติจะทำไม่ได้'
              : [...actionable, { id: 'self', fullName: `${fullName} (คุณ)` }]
                  .filter(
                    (entry) =>
                      entry.id !== 'self' || status.hasPin,
                  )
                  .map((entry) => entry.fullName)
                  .join(' · ')}
          </span>
        </div>

        {notice ? <InlineNotice tone="success">{notice}</InlineNotice> : null}
        {error && step === null ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

        <div className={styles.actions}>
          <Button variant="primary" icon="pin" onClick={() => setStep('enter')}>
            {status.hasPin ? 'เปลี่ยน PIN' : 'ตั้ง PIN'}
          </Button>
          {status.hasPin ? (
            <Button variant="secondary" icon="trash" onClick={() => setConfirmClear(true)}>
              ลบ PIN
            </Button>
          ) : null}
        </div>

        <p className={styles.small}>
          PIN เป็นตัวเลข {PIN_LENGTH} หลัก ใช้ได้เฉพาะบัญชีผู้จัดการ (แอดมิน) เท่านั้น
          และเก็บเป็นค่าแฮช — ระบบอ่าน PIN ของคุณกลับมาไม่ได้
        </p>
      </Stack>

      <Overlay
        open={step !== null}
        onClose={busy ? () => undefined : close}
        title={step === 'confirm' ? 'ยืนยัน PIN อีกครั้ง' : status.hasPin ? 'เปลี่ยน PIN' : 'ตั้ง PIN'}
        description={
          step === 'confirm'
            ? 'กรอก PIN เดิมอีกครั้งเพื่อยืนยันว่าไม่พิมพ์ผิด'
            : `เลือกตัวเลข ${PIN_LENGTH} หลักที่จำได้ และไม่เรียงติดกันหรือซ้ำกันทั้งสี่ตัว`
        }
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              ยกเลิก
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={busy || pin.length !== PIN_LENGTH || pinProblem(pin) !== null}
              onClick={() => {
                if (step === 'enter') {
                  setFirstPin(pin);
                  setPin('');
                  setStep('confirm');
                } else {
                  void submit(pin);
                }
              }}
            >
              {step === 'confirm' ? 'บันทึก PIN' : 'ต่อไป'}
            </Button>
          </>
        }
      >
        <div className={styles.body}>
          <div className={styles.pinRow} aria-hidden="true">
            {Array.from({ length: PIN_LENGTH }, (_, index) => (
              <span
                key={index}
                className={`${styles.pinSlot} ${index < pin.length ? styles.pinFilled : ''}`}
              />
            ))}
          </div>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <PinPad
            disabled={busy}
            onInput={append}
            onBackspace={() => setPin((current) => current.slice(0, -1))}
            onClear={() => setPin('')}
          />
          {pin.length > 0 && pinProblem(pin) ? (
            <p className={styles.error}>{pinProblem(pin)}</p>
          ) : null}
        </div>
      </Overlay>

      <ConfirmDialog
        open={confirmClear}
        title="ลบ PIN ผู้ดูแล"
        description="หลังลบแล้ว บัญชีนี้จะอนุมัติรายการที่ต้องใช้ PIN ไม่ได้ จนกว่าจะตั้งใหม่"
        confirmLabel="ลบ PIN"
        busy={busy}
        onConfirm={() => void clearPin()}
        onCancel={() => setConfirmClear(false)}
      />
    </Card>
  );
}
