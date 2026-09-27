'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { apiPost } from '@/lib/client-api';
import { primeAudio } from '@/lib/sound';

interface LoginResponse {
  role: 'member' | 'employee' | 'admin';
  fullName: string;
  redirectTo: string;
}

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
    <form onSubmit={submit} onPointerDown={() => primeAudio()} noValidate>
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      <div className="form-group mb-3">
        <label className="form-label" htmlFor="identifier">
          เบอร์โทรศัพท์ หรือ อีเมล
        </label>
        <input
          id="identifier"
          className="form-control"
          autoComplete="username"
          inputMode="text"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          required
        />
      </div>

      <div className="form-group mb-3">
        <label className="form-label" htmlFor="password">
          รหัสผ่าน
        </label>
        <input
          id="password"
          type="password"
          className="form-control"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>

      <button type="submit" className="btn btn-primary w-100" disabled={busy}>
        {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
      </button>
    </form>
  );
}
