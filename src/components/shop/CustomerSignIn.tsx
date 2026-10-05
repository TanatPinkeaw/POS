'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, InlineNotice, TextField } from '@/components/ds';
import { apiPost } from '@/lib/client-api';
import { CURRENT_CUSTOMER_NOTICE_VERSION } from '@/lib/privacy-notice';

import styles from '@/app/shop/shop-signin.module.css';

import { NoticeAcknowledge } from './NoticeAcknowledge';

interface LoginResponse {
  role: 'member' | 'employee' | 'admin';
  redirectTo: string;
}

interface GoogleDoorResponse {
  needsPhone?: boolean;
  id?: string;
  redirectTo?: string;
}

interface SignupResponse {
  redirectTo: string;
}

/* --- the thin slice of Google Identity Services this screen uses --------- */

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
  }): void;
  renderButton(element: HTMLElement, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } };
  }
}

const GOOGLE_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/**
 * The customer's two doors (ADR 0020 §3, §7).
 *
 * The counter door is phone and password — the same thing the shop enrolled the
 * customer with — and the Google door is the self-serve one. Neither hides the
 * other: this is the screen the ticket asks for where a walk-in and a customer who
 * found the shop online both have a way in.
 *
 * The Google half is **data**, not a hard dependency. When the deployment has a
 * `GOOGLE_CLIENT_ID`, Identity Services is loaded (client-side, so no third-party
 * script sits in the served HTML) and its button fills the slot; without one, the
 * door is present but says plainly that it is not configured rather than showing a
 * button that cannot work. That also keeps a shop that never configures Google from
 * fetching anything from Google on its sign-in page.
 */
export function CustomerSignIn({ googleClientId }: { googleClientId: string | null }) {
  const router = useRouter();

  // Stable across renders, so the Google effect is not torn down and rebuilt on
  // every keystroke in the form below it.
  const go = useCallback(
    (path: string) => {
      router.replace(path);
      // Re-render server components so the shell picks up the new session.
      router.refresh();
    },
    [router],
  );

  return (
    <div className={styles.form}>
      <GoogleDoor googleClientId={googleClientId} onSignedIn={go} />
      <p className={styles.divider}>หรือ</p>
      <CounterDoor onSignedIn={go} />
    </div>
  );
}

/* -------------------------------------------------------------- google door */

function GoogleDoor({
  googleClientId,
  onSignedIn,
}: {
  googleClientId: string | null;
  onSignedIn: (path: string) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** True once Google's token came back for an account with no customer row yet. */
  const [needsPhone, setNeedsPhone] = useState(false);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  /** Whether the customer has confirmed reading the privacy notice. */
  const [acknowledged, setAcknowledged] = useState(false);

  /*
   * The id token is held in a ref rather than state: it is a credential the
   * follow-up signup re-presents, and nothing renders from it, so putting it in
   * state would be a re-render carrying a secret for no reason.
   */
  const idToken = useRef<string | null>(null);

  const handleCredential = useCallback(
    async (token: string): Promise<void> => {
      idToken.current = token;
      setError(null);
      try {
        const result = await apiPost<GoogleDoorResponse>('/api/v1/auth/google', { idToken: token });
        if (result.needsPhone) {
          setNeedsPhone(true);
          return;
        }
        if (result.redirectTo) {
          onSignedIn(result.redirectTo);
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ');
      }
    },
    [onSignedIn],
  );

  useEffect(() => {
    if (googleClientId === null) {
      return;
    }
    let cancelled = false;

    const script = document.createElement('script');
    script.src = GOOGLE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const api = window.google?.accounts?.id;
      if (cancelled || !api || !slot.current) {
        return;
      }
      api.initialize({
        client_id: googleClientId,
        callback: (response) => {
          if (response.credential) {
            void handleCredential(response.credential);
          }
        },
      });
      api.renderButton(slot.current, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        width: 320,
      });
    };
    document.head.appendChild(script);

    return () => {
      cancelled = true;
      script.remove();
    };
  }, [googleClientId, handleCredential]);

  /**
   * The first sign-in: the phone, the notice, and nothing else.
   *
   * No code is asked for (ADR 0020 §5): Google proves the Google account, and the
   * number is only where the new customer's points and orders will hang. A number that
   * already has a customer is refused by the server rather than linked, which is the
   * one answer the screen has to relay in Thai.
   *
   * **The notice is part of this step, not a step of its own.** The customer arrived
   * here to buy something, and a separate screen between the phone and the button is a
   * screen they will dismiss. So it sits inline, above the button, and the button stays
   * disabled until it has been read — the shop's duty to inform, discharged in the flow
   * rather than parked one click away.
   */
  async function completeSignup(): Promise<void> {
    if (idToken.current === null) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await apiPost<SignupResponse>('/api/v1/auth/signup', {
        idToken: idToken.current,
        phone: phone.trim(),
        noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
      });
      onSignedIn(result.redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'สมัครสมาชิกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.door} aria-label="เข้าสู่ระบบด้วย Google">
      <p className={styles.doorTitle}>ลูกค้าใหม่ หรือมีบัญชี Google</p>

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {googleClientId === null ? (
        <InlineNotice tone="info">
          ร้านนี้ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google — ใช้เบอร์โทรศัพท์และรหัสผ่านด้านล่างได้เลย
        </InlineNotice>
      ) : !needsPhone ? (
        <div className={styles.googleSlot} ref={slot} />
      ) : (
        <div className={styles.door}>
          {/*
            The one step in this flow a customer cannot skip, said as a requirement
            rather than left to be inferred.

            The screen used to show a grey sentence above an empty box, and the
            obvious reading was "optional field, move on" — people tapped through it,
            hit a disabled button with no stated reason, and left. Google proves who
            they are; the number is where their points and their orders hang, so
            without it the account cannot be created at all (ADR 0020 §5).

            So this is a warning-toned banner with the word จำเป็น in it, the field is
            focused, and the button explains itself instead of simply being grey.
            `InlineNotice` already carries its own live region — `assertive` for a
            warning tone — so this step is announced when it appears after the network
            round trip, without a second nested region competing with it.
          */}
          <InlineNotice tone="warning" title="ขั้นตอนที่ 2 จาก 2">
            <strong>จำเป็นต้องกรอกเบอร์มือถือ</strong> เพื่อเปิดบัญชีลูกค้า — เบอร์นี้ใช้ผูกคะแนนสะสม
            ประวัติการซื้อ และใช้ยืนยันตัวตนเวลาจองสินค้า ร้านจะใช้ส่งแจ้งเตือนเรื่องพรีออเดอร์ให้คุณเท่านั้น
          </InlineNotice>
          <TextField
            id="googlePhone"
            label="เบอร์มือถือของคุณ"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            required
            placeholder="08xxxxxxxx"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            help="ใช้เป็นตัวระบุตัวตนของบัญชี และติดต่อกลับได้ในกรณีที่มีปัญหากับออเดอร์"
          />
          <NoticeAcknowledge acknowledged={acknowledged} onChange={setAcknowledged} />
          <Button
            variant="primary"
            size="lg"
            block
            loading={busy}
            disabled={phone.trim().length === 0 || !acknowledged}
            onClick={() => void completeSignup()}
          >
            ยืนยันและเข้าสู่ระบบ
          </Button>
          {/*
            The never-silent half of a button that is disabled for two different
            reasons. Without it the customer sees a grey button and has to guess which
            of the two is still missing.
          */}
          {phone.trim().length === 0 || !acknowledged ? (
            <p className={styles.stepHint} role="alert">
              {phone.trim().length === 0 && !acknowledged
                ? 'กรอกเบอร์มือถือและอ่านนโยบายด้านบนก่อน จึงจะกดยืนยันได้'
                : phone.trim().length === 0
                  ? 'ยังไม่ได้กรอกเบอร์มือถือ'
                  : 'ยังไม่ได้อ่านและยืนยันนโยบายคุ้มครองข้อมูลส่วนบุคคล'}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- counter door */

function CounterDoor({ onSignedIn }: { onSignedIn: (path: string) => void }) {
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
      onSignedIn(result.redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เข้าสู่ระบบไม่สำเร็จ');
      setBusy(false);
    }
  };

  return (
    <section className={styles.door} aria-label="เข้าสู่ระบบด้วยเบอร์โทรศัพท์">
      <p className={styles.doorTitle}>ลูกค้าที่ลงทะเบียนไว้แล้ว</p>
      <form className={styles.form} onSubmit={submit} noValidate>
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

        <TextField
          id="shopIdentifier"
          label="เบอร์โทรศัพท์"
          autoComplete="username"
          inputMode="tel"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          required
        />
        <TextField
          id="shopPassword"
          label="รหัสผ่าน"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          เข้าสู่ระบบ
        </Button>
      </form>
    </section>
  );
}
