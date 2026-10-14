'use client';

import { useEffect, useState } from 'react';

import { Button, InlineNotice, Spinner } from '@/components/ds';
import { apiPost } from '@/lib/client-api';
import {
  LIFF_SIGN_IN_ENDPOINT,
  liffEntryNotice,
  liffSignedInPath,
  planLiffEntry,
  type LiffEntryState,
} from '@/lib/line-liff-entry';

import { LineClaimStep } from './CustomerSignIn';

// The stylesheet lives beside the route it styles: `/line` is the only screen that renders
// this component, the same way the front door's own sheet lives under `src/app/login/`.
import styles from '@/app/line/line-entry.module.css';

/** What `POST /api/v1/auth/line` answers: a session, or the phone step (ADR 0030 §1). */
interface LineSignInResponse {
  needsPhone?: boolean;
  fullName?: string | null;
  redirectTo?: string;
}

/**
 * The in-LINE entry (ADR 0032 §1) — the adapter around `line-liff-entry.ts`.
 *
 * It holds no rules of its own. Everything it decides is `planLiffEntry`'s answer to facts
 * it hands over, which is what makes the decision testable without LINE's servers: this file
 * is initialise, ask, act, and the three sentences in between come from the module.
 *
 * **Why the SDK is imported dynamically.** `@line/liff` is a browser-only script that
 * reaches LINE's own origin as soon as it loads. A static import would put it in this
 * page's initial chunk *and* invite it into a server render; `await import()` inside the
 * effect keeps it out of both, and keeps the page's first paint as cheap as `/login`'s.
 *
 * **Why there is no `liff.login()` for an external browser.** LIFF does initialise outside
 * LINE, by making the customer log into LINE inside that browser first — a step nobody asked
 * for on a link that was meant to be one tap. The entry says what it is and offers the
 * ordinary doors instead (ADR 0032 §1), which is the honest answer to a link opened from
 * somewhere it was not meant to be opened.
 */
export function LiffEntry({
  configured,
  liffId,
}: {
  /** Whether this deployment has a LIFF app id at all. */
  configured: boolean;
  /** The id, when it has one. */
  liffId: string | null;
}) {
  /*
   * Starting from "we have not asked LINE yet" rather than from a guess: a page that
   * painted "open this in the LINE app" while the SDK was still loading would print a
   * sentence about a browser it had not looked at.
   */
  const [checking, setChecking] = useState(configured && liffId !== null);
  const [state, setState] = useState<LiffEntryState>(() =>
    planLiffEntry({ configured, inLineClient: false }),
  );
  /** The id token the SDK handed this page, kept for the phone step's own POST. */
  const [idToken, setIdToken] = useState<string | null>(null);
  /** This deployment's or LINE's own refusal, in the words it used. */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /*
     * A cancelled flag rather than an AbortController: the only thing that can happen to
     * this page after it starts is being left, and a setState on a left page is the noise
     * this avoids. The SDK call itself has nothing to abort.
     */
    let cancelled = false;

    async function run(): Promise<void> {
      if (!configured || liffId === null) {
        return; // `checking` was seeded false — the page already says it is not set up.
      }

      let liff: typeof import('@line/liff').default;
      try {
        liff = (await import('@line/liff')).default;
        await liff.init({ liffId });
      } catch {
        // The script did not load, or LINE refused this endpoint: offline, blocked, or a
        // LIFF app whose endpoint URL is not this address.
        if (!cancelled) {
          setState(planLiffEntry({ configured: true, inLineClient: false, failure: 'sdk' }));
          setChecking(false);
        }
        return;
      }

      if (cancelled) {
        return;
      }

      const inLineClient = liff.isInClient();
      if (!inLineClient) {
        setState(planLiffEntry({ configured: true, inLineClient: false }));
        setChecking(false);
        return;
      }

      const token = liff.getIDToken();
      if (!token) {
        /*
         * Initialised inside LINE with no id token: the customer did not grant the `openid`
         * scope, or the LIFF app was registered without it. Nothing to verify, so the entry
         * says so rather than showing a button that cannot work.
         */
        setState(planLiffEntry({ configured: true, inLineClient: true, failure: 'token' }));
        setChecking(false);
        return;
      }

      setIdToken(token);

      try {
        const answer = await apiPost<LineSignInResponse>(LIFF_SIGN_IN_ENDPOINT, { idToken: token });
        if (cancelled) {
          return;
        }
        if (answer.needsPhone) {
          setState(
            planLiffEntry({
              configured: true,
              inLineClient: true,
              needsPhone: true,
              displayName: answer.fullName ?? null,
            }),
          );
          setChecking(false);
          return;
        }

        setState(
          planLiffEntry({
            configured: true,
            inLineClient: true,
            redirectTo: answer.redirectTo ?? liffSignedInPath(),
          }),
        );
        // The session cookie is set; the screens are the ones that already exist.
        window.location.assign(answer.redirectTo ?? liffSignedInPath());
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : null);
          setState(planLiffEntry({ configured: true, inLineClient: true, failure: 'refused' }));
          setChecking(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [configured, liffId]);

  const notice = liffEntryNotice(state);

  return (
    <section className={styles.entry} aria-label="เข้าสู่ระบบด้วย LINE">
      {checking ? (
        <Spinner label="กำลังยืนยันบัญชี LINE…" />
      ) : (
        <>
          {/* The refusal the server or LINE itself used, before the entry's own sentence. */}
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          {notice ? <InlineNotice tone={notice.tone}>{notice.body}</InlineNotice> : null}

          {state.stage === 'claim' ? (
            <LineClaimStep
              idToken={idToken}
              onSignedIn={(path) => {
                window.location.assign(path);
              }}
              onRestart={() => {
                window.location.reload();
              }}
            />
          ) : null}

          {state.stage === 'signed_in' ? (
            <Spinner label="เข้าสู่ระบบแล้ว กำลังพาไปหน้าออเดอร์…" />
          ) : null}

          {state.stage === 'sign_in' ? (
            <Spinner label="กำลังเข้าสู่ระบบด้วยบัญชี LINE ของคุณ…" />
          ) : null}

          {/*
            One way out of every stage that is not a doing: a customer who arrived from
            somewhere the entry cannot help with still has the door they came through last
            time, and it is named rather than left to be found.
          */}
          {state.stage !== 'claim' && state.stage !== 'sign_in' && state.stage !== 'signed_in' ? (
            <Button
              variant="secondary"
              size="lg"
              block
              onClick={() => {
                window.location.assign('/login');
              }}
            >
              ไปหน้าเข้าสู่ระบบ
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
