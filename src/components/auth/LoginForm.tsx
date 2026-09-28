'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, InlineNotice, TextField } from '@/components/ds';
import { apiPost } from '@/lib/client-api';
import { primeAudio } from '@/lib/sound';

import styles from '@/app/login/login.module.css';

interface LoginResponse {
  role: 'member' | 'employee' | 'admin';
  fullName: string;
  redirectTo: string;
}

/**
 * The sign-in form.
 *
 * Rebuilt on the design system rather than on Bootstrap's `form-control` and
 * `alert` classes, which is what the rest of the migration will look like:
 * the same behaviour, the same request, and the same error string — with the
 * field's label, help text and error wired together by `TextField` instead of by
 * hand, so the error is announced and not merely drawn.
 *
 * `noValidate` stays: the browser's own validation bubbles are untranslated and
 * unstyleable, and this form has exactly two required fields whose emptiness the
 * server already reports in Thai.
 */
export function LoginForm() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await apiPost<LoginResponse>('/api/v1/auth/login', {
        identifier: identifier.trim(),
        password,
      });

      router.replace(result.redirectTo);
      // Re-render server components so the shell picks up the new session.
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เข้าสู่ระบบไม่สำเร็จ');
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} onPointerDown={() => primeAudio()} noValidate>
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <TextField
        id="identifier"
        label="เบอร์โทรศัพท์ หรือ อีเมล"
        autoComplete="username"
        inputMode="text"
        autoFocus
        value={identifier}
        onChange={(event) => setIdentifier(event.target.value)}
        required
      />

      <TextField
        id="password"
        label="รหัสผ่าน"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />

      {/*
       * The label does not change while the request is in flight. `loading` adds
       * the spinner and `aria-busy`, and a control whose name changes mid-action
       * is a control a screen reader has to re-read.
       */}
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        เข้าสู่ระบบ
      </Button>
    </form>
  );
}
