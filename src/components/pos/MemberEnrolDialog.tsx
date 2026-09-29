'use client';

/**
 * Enrolling a customer without leaving the sale (ADR 0011).
 *
 * The back-office screen (`MembersManager`) is the same act with a different
 * audience, and the differences here are all consequences of who is standing
 * where:
 *
 *   * **It is a dialog, not a screen.** The basket behind it stays mounted, so a
 *     half-rung bill survives somebody deciding to join mid-transaction, which is
 *     exactly when they decide.
 *   * **No email field.** A shop with a customer waiting at the counter has no
 *     address on file and no reason to type one; a manager can add it later. Every
 *     field here is one a cashier can read off the person in front of them.
 *   * **The phone number arrives pre-filled** from the till's search box, because
 *     the only way a cashier gets here is by looking somebody up and not finding
 *     them — so the number is already typed, and pre-filling it is also what stops
 *     the fresh account from being created under a different one than the search.
 *
 * The password is the same temporary credential the back office hands out: said
 * out loud at the counter and changed by the customer from their own screen later.
 * The check that it is at least eight characters is repeated from the server rather
 * than trusted from it, because a form that submits and then reports "too short"
 * makes the cashier read the same sentence twice.
 */
import { useEffect, useState } from 'react';

import { Button, InlineNotice, Overlay, Stack, TextField } from '@/components/ds';
import { apiPost } from '@/lib/client-api';

import type { TillMember } from './useTill';

export function MemberEnrolDialog({
  open,
  initialPhone,
  onClose,
  onEnrolled,
}: {
  open: boolean;
  /** Whatever is in the till's search box — the number the cashier just typed. */
  initialPhone: string;
  onClose: () => void;
  /** Receives the created customer, so the caller can attach them to the bill. */
  onEnrolled: (member: TillMember) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Every open starts from the till's current search box and nothing else.
   *
   * Keyed on `open` rather than reset on close, so a refused attempt — a duplicate
   * number, say — keeps what the cashier typed while they fix it, and the *next*
   * customer they enrol does not inherit the previous one's name.
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    setFullName('');
    setPhone(initialPhone);
    setPassword('');
    setError(null);
  }, [open, initialPhone]);

  const submit = async (): Promise<void> => {
    setError(null);
    if (fullName.trim() === '' || phone.trim() === '') {
      setError('กรอกชื่อและเบอร์โทรก่อนสมัคร');
      return;
    }
    if (password.length < 8) {
      setError('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
      return;
    }

    setBusy(true);
    try {
      const created = await apiPost<TillMember>('/api/v1/members', {
        fullName: fullName.trim(),
        phone: phone.trim(),
        password,
      });
      onEnrolled(created);
    } catch (caught) {
      /*
       * The server's own words. The one refusal a cashier actually meets here is
       * "this number already has an account", and it is already written for them.
       */
      setError(caught instanceof Error ? caught.message : 'สมัครสมาชิกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      title="สมัครสมาชิกใหม่"
      description="บิลที่ค้างอยู่ไม่หาย — สมัครเสร็จลูกค้าคนนี้จะถูกผูกกับบิลให้ทันที"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button icon="plus" loading={busy} onClick={() => void submit()}>
            สมัครสมาชิก
          </Button>
        </>
      }
    >
      <Stack gap="md">
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

        <TextField
          id="enrol-member-name"
          label="ชื่อ-นามสกุล"
          autoComplete="name"
          required
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
        />

        <TextField
          id="enrol-member-phone"
          label="เบอร์โทร"
          autoComplete="tel"
          inputMode="tel"
          className="ln-num"
          required
          help="ใช้เป็นชื่อผู้ใช้ในการเข้าสู่ระบบ — ใส่ขีดหรือไม่ใส่ก็ได้"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />

        <TextField
          id="enrol-member-password"
          label="รหัสผ่านชั่วคราว"
          type="password"
          autoComplete="new-password"
          required
          help="อย่างน้อย 8 ตัวอักษร — บอกรหัสนี้กับลูกค้าตอนนี้ แล้วให้เขาเปลี่ยนเองภายหลัง"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Stack>
    </Overlay>
  );
}
