'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { PinPad, QrCode, QrPanel, Spinner, Thumb } from '@/components/ds';
import { apiFetch } from '@/lib/client-api';
import { bangkokTimeString } from '@/lib/bangkok-time';
import { DISPLAY_THANKS_MS } from '@/lib/display-view';
import { formatThb } from '@/lib/money';

import styles from './DisplayScreen.module.css';
import {
  clearStoredToken,
  readStoredToken,
  storeToken,
  useDisplaySocket,
} from './useDisplaySocket';
import { checkoutStepIndex } from './checkout-step';
import { CheckoutSteps } from './CheckoutSteps';

/**
 * The customer's screen: what the till is doing, from where the customer stands.
 *
 * Four stages, and which one is showing is a question this screen answers alone
 * from what it has been told — no mode to set, nothing to configure at the
 * counter:
 *
 *   * **idle** — nobody is being served. The shop's name, its logo, and what it
 *     actually sells most of. Not a promotions engine; an idle screen that is
 *     never wrong is worth more than one that needs configuring.
 *   * **selling** — the bill as it is rung up, line by line, so the customer can
 *     see what is being scanned instead of asking.
 *   * **paying** — the PromptPay QR, the amount, and the clock. This is the stage
 *     that earns its keep: the customer scans their own screen, and the till
 *     closes the bill the moment the money lands.
 *   * **ready** — pre-orders waiting to be collected, by order number and an
 *     initial, because a queue needs to be called without naming anyone.
 *
 * Sized for a screen standing three metres away: everything is set in the largest
 * type the layout allows, and there is no interactive control anywhere in the
 * selling and paying stages — nothing on this screen can change the sale.
 */
export function DisplayScreen() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    setToken(readStoredToken());
    setReady(true);
  }, []);

  const state = useDisplaySocket(ready ? token : null);

  /*
   * The thank-you is a timeout rather than a stage: it is the *absence* of a
   * stage, so nothing has to tell the screen the sale is over.
   *
   * The timer is held in a ref and cancelled only by a *newer* payment, never by
   * the effect's cleanup. A cleanup that cancelled it would fire the moment
   * `paid` changed, and `paid` changes on the very next event after a sale — the
   * till resetting its basket, or the next customer's QR. The message would then
   * stay up until somebody reloaded the screen, because nothing was left to take
   * it down.
   */
  const thanksTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!state.paid) {
      return;
    }
    if (thanksTimer.current !== null) {
      window.clearTimeout(thanksTimer.current);
    }
    setThanks(true);
    thanksTimer.current = window.setTimeout(() => {
      thanksTimer.current = null;
      setThanks(false);
    }, DISPLAY_THANKS_MS);
  }, [state.paid]);

  useEffect(
    () => () => {
      if (thanksTimer.current !== null) {
        window.clearTimeout(thanksTimer.current);
      }
    },
    [],
  );

  /*
   * A revoked screen loses its token. The server refuses it at both the socket
   * and the state fetch, so there is nothing to keep showing — and leaving the
   * screen on a dead stage would look like the till had crashed rather than like
   * somebody had deliberately switched this display off.
   */
  useEffect(() => {
    if (!state.revoked) {
      return;
    }
    clearStoredToken();
    setToken(null);
    setPairError('จอนี้ถูกยกเลิกการเชื่อมต่อแล้ว — กรุณาจับคู่ใหม่');
  }, [state.revoked]);

  const pair = useCallback(async (candidate: string): Promise<void> => {
    setPairBusy(true);
    setPairError(null);
    try {
      const result = await apiFetch<{ token: string; label: string }>('/api/v1/display/pair', {
        method: 'POST',
        body: JSON.stringify({ code: candidate }),
      });
      storeToken(result.token);
      setToken(result.token);
      setCode('');
    } catch (caught) {
      setCode('');
      setPairError(caught instanceof Error ? caught.message : 'จับคู่ไม่สำเร็จ');
    } finally {
      setPairBusy(false);
    }
  }, []);

  const append = (digit: string): void => {
    if (pairBusy) {
      return;
    }
    setPairError(null);
    const next = (code + digit).slice(0, 6);
    setCode(next);
    if (next.length === 6) {
      void pair(next);
    }
  };

  if (!ready) {
    return (
      <main className={styles.screen}>
        <Spinner label="กำลังโหลด…" />
      </main>
    );
  }

  if (!token) {
    return (
      <main className={styles.screen}>
        <div className={styles.pairCard}>
          <p className={styles.pairKicker}>จอลูกค้า</p>
          <h1 className={styles.pairTitle}>ใส่รหัสจับคู่ 6 หลัก</h1>
          <p className={styles.pairHint}>
            ดูรหัสได้จากหน้า “ตั้งค่าร้าน” → จอลูกค้า บนเครื่องขาย
          </p>

          <div className={styles.pinRow} aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <span
                key={index}
                className={`${styles.pinSlot} ${index < code.length ? styles.pinFilled : ''}`}
              />
            ))}
          </div>

          <PinPad
            label="แป้นรหัสจับคู่"
            disabled={pairBusy}
            onInput={append}
            onBackspace={() => setCode((current) => current.slice(0, -1))}
            onClear={() => setCode('')}
          />

          {pairError ? (
            <p className={styles.pairError} role="alert">
              {pairError}
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  const lines = state.cart?.lines ?? [];
  const paying = state.intent !== null;
  /* A cart snapshot is a bill, never a payment: the till re-pushes the basket
   * the moment the QR appears (received/change go null while a QR is live), so
   * a `selling` bill under a live QR is the old basket, not a second mode. Only
   * when the QR is gone — paid, cancelled, expired — does the bill own the
   * screen again. */
  const selling = lines.length > 0;
  /*
   * What the customer handed over, shown only while the till is still counting
   * it on screen. After a QR is dropped the till cancels the intent but the
   * next basket push can lag a beat behind, and a stale received/change is a
   * promise about a payment that no longer exists — it rejoins only with a
   * fresh snapshot taken while no intent is live.
   */
  const showTendered = !paying;
  /* The Steps show only at checkout: a null step is the idle and collection
   * board, where no sale is on any circle. */
  const step = checkoutStepIndex({ selling, paying, thanks });

  return (
    <main className={styles.screen}>
      <header className={styles.bar}>
        <span className={styles.stageLabel}>
          {paying
            ? 'สแกนจ่ายด้วยพร้อมเพย์'
            : selling
              ? 'รายการที่กำลังคิดเงิน'
              : thanks
                ? 'ขอบคุณที่ใช้บริการ'
                : 'ยินดีต้อนรับ'}
        </span>
        <span className={styles.connection} aria-live="polite">
          {state.connected ? null : 'การเชื่อมต่อขาด — กำลังเชื่อมใหม่'}
        </span>
      </header>

      {step !== null ? <CheckoutSteps current={step} /> : null}

      {paying && state.intent ? (
        <section className={`${styles.stage} ${styles.paySplit}`}>
          <div className={styles.payBill}>
            {lines.length > 0 ? (
              <>
                <ul className={styles.lines}>
                  {lines.map((line, index) => (
                    <li key={`${line.name}-${index}`} className={styles.line}>
                      <Thumb url={line.imageUrl} size="lg" />
                      <span className={styles.lineName}>
                        {line.name}
                        {line.quantity > 1 ? (
                          <span className={styles.qty}>
                            {' '}
                            × {line.quantity} · {formatThb(line.unitPrice)} ต่อชิ้น
                          </span>
                        ) : null}
                      </span>
                      <span className={styles.linePrice}>{formatThb(line.totalPrice)}</span>
                    </li>
                  ))}
                </ul>
                <div className={styles.totals}>
                  <div className={`${styles.totalRow} ${styles.grand}`}>
                    <span>รวมทั้งสิ้น</span>
                    <span>{formatThb(state.cart?.totalThb ?? 0)}</span>
                  </div>
                </div>
              </>
            ) : null}
          </div>
          <div className={styles.payQr}>
            <QrPanel intent={state.intent} size={320} />
            <p className={styles.instruction}>
              เปิดแอปธนาคารแล้วสแกน QR นี้ · ยอดเงินถูกล็อกไว้แล้ว
            </p>
          </div>
        </section>
      ) : null}

      {selling ? (
        <section className={styles.stage}>
          <ul className={styles.lines}>
            {lines.map((line, index) => (
              <li key={`${line.name}-${index}`} className={styles.line}>
                {/*
                 * The same photograph the cashier is bagging (ADR 0014). It is the
                 * one thing on this screen that answers "is that what I asked for"
                 * without either of them having to read: the customer matches the
                 * picture on the shelf, the name confirms it.
                 */}
                <Thumb url={line.imageUrl} size="lg" />
                <span className={styles.lineName}>
                  {line.name}
                  {line.quantity > 1 ? (
                    <span className={styles.qty}>
                      {' '}
                      × {line.quantity} · {formatThb(line.unitPrice)} ต่อชิ้น
                    </span>
                  ) : null}
                </span>
                <span className={styles.linePrice}>{formatThb(line.totalPrice)}</span>
              </li>
            ))}
          </ul>

          <div className={styles.totals}>
            {/*
             * The same four rows the till's pay sheet shows, in the same order and
             * the same words, because the customer is reading both screens at once
             * and a difference between them is a question at the counter. Two of
             * these — the subtotal and what they handed over — the payload has been
             * carrying since the start and this stage never drew them.
             */}
            {state.cart && state.cart.subtotalThb > 0 ? (
              <div className={styles.totalRow}>
                <span>ยอดก่อนส่วนลด</span>
                <span>{formatThb(state.cart.subtotalThb)}</span>
              </div>
            ) : null}
            {state.cart && state.cart.discountThb > 0 ? (
              <div className={styles.totalRow}>
                <span>ส่วนลด</span>
                <span>-{formatThb(state.cart.discountThb)}</span>
              </div>
            ) : null}
            <div className={`${styles.totalRow} ${styles.grand}`}>
              <span>รวมทั้งสิ้น</span>
              <span>{formatThb(state.cart?.totalThb ?? 0)}</span>
            </div>
            {showTendered && state.cart && state.cart.receivedThb !== null && state.cart.receivedThb > 0 ? (
              <div className={styles.totalRow}>
                <span>ลูกค้ายื่นมา</span>
                <span>{formatThb(state.cart.receivedThb)}</span>
              </div>
            ) : null}
            {showTendered && state.cart && state.cart.changeThb !== null && state.cart.changeThb > 0 ? (
              <div className={`${styles.totalRow} ${styles.change}`}>
                <span>เงินทอน</span>
                <span>{formatThb(state.cart.changeThb)}</span>
              </div>
            ) : null}
          </div>

          {state.cart?.memberFirstName ? (
            <p className={styles.member}>
              สมาชิก <strong>{state.cart.memberFirstName}</strong> — แต้มจะถูกบันทึกให้อัตโนมัติ
            </p>
          ) : null}
        </section>
      ) : null}

      {!paying &&
      !selling &&
      state.receipt !== null ? (
        <section className={styles.stage}>
          {/*
           * The till's receipt link, drawn here so the customer scans the screen
           * in front of them rather than the cashier's. The URL is the receipt
           * *page* on this origin, not the API path the server issued — the same
           * one the till's own dialog draws, so the two QRs agree. The Display
           * is the till's mirror, not a second minter, so it never invents a
           * link of its own.
           */}
          <QrCode
            value={`${window.location.origin}/receipts?t=${encodeURIComponent(state.receipt.token)}`}
            size={320}
            alt={`ใบเสร็จ ${state.receipt.orderNumber}`}
          />
          <p className={styles.instruction}>
            สแกนเพื่อเก็บบิล {state.receipt.orderNumber} ไว้ในมือถือ · ลิงก์มีอายุ ใช้อีกครั้งต้องขอใหม่ที่เคาน์เตอร์
          </p>
        </section>
      ) : null}

      {!paying &&
      !selling &&
      ((state.ready?.calls.length ?? 0) > 0 || (state.ready?.orders.length ?? 0) > 0) ? (
        <section className={styles.stage}>
          {/*
           * The walk-in calls first, and biggest: these are numbers somebody is
           * being called by right now, and the customer looking for theirs has
           * been waiting since before they sat down (ADR 0018). A pre-order below
           * them is a parcel to collect, which has already been waited for.
           */}
          {(state.ready?.calls.length ?? 0) > 0 ? (
            <>
              <p className={styles.instruction}>เรียกคิวแล้ว</p>
              <ul className={styles.callList} data-testid="display-calls">
                {state.ready?.calls.map((number) => (
                  <li key={number} className={styles.callNumber}>
                    {number}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {(state.ready?.orders.length ?? 0) > 0 ? (
            <>
              <p className={styles.instruction}>พร้อมรับของแล้ว</p>
              <ul className={styles.readyList}>
                {state.ready?.orders.map((order) => (
                  <li key={order.orderNumber} className={styles.readyItem}>
                    <span className={styles.readyNumber}>{order.orderNumber}</span>
                    <span className={styles.readyWho}>
                      {order.customerInitial ?? ''} · {bangkokTimeString(new Date(order.readyAt))}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {!paying &&
      !selling &&
      (state.ready?.orders.length ?? 0) === 0 &&
      (state.ready?.calls.length ?? 0) === 0 ? (
        <section className={`${styles.stage} ${styles.idle}`}>
          {/*
           * The logo is plain `<img>` rather than `next/image`: the shop's logo is
           * an arbitrary URL an owner pasted in, and the optimizer would have to
           * be told to trust every host a shop might use.
           */}
          {!thanks && state.idle?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.logo} src={state.idle.logoUrl} alt="" />
          ) : null}

          <p className={styles.shopName}>
            {thanks ? 'ขอบคุณที่ใช้บริการ' : (state.idle?.shopName ?? 'ยินดีต้อนรับ')}
          </p>

          {thanks ? null : (
            <p className={styles.idleHint}>
              {state.idle && !state.idle.sessionOpen
                ? 'ร้านยังไม่เปิดกะ — สอบถามพนักงานได้เลย'
                : 'สแกนจ่ายที่จอนี้ได้เมื่อพนักงานเริ่มคิดเงิน'}
            </p>
          )}

          {!thanks && (state.idle?.popular.length ?? 0) > 0 ? (
            <div className={styles.popular}>
              <p className={styles.popularKicker}>ขายดีที่ร้านนี้</p>
              <div className={styles.marquee}>
                <div className={styles.marqueeTrack}>
                  <ul className={styles.marqueeGroup}>
                    {state.idle?.popular.map((name, index) => (
                      <li key={`first-${index}`} className={styles.popularItem}>
                        {name}
                      </li>
                    ))}
                  </ul>
                  {/*
                   * The loop's second half: an exact duplicate the track scrolls
                   * into, hidden from assistive technology so the list is
                   * announced once rather than twice.
                   */}
                  <ul className={styles.marqueeGroup} aria-hidden="true">
                    {state.idle?.popular.map((name, index) => (
                      <li key={`second-${index}`} className={styles.popularItem}>
                        {name}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <footer className={styles.foot}>
        <button type="button" className={styles.unpair} onClick={() => {
          clearStoredToken();
          setToken(null);
        }}>
          ยกเลิกการจับคู่จอนี้
        </button>
      </footer>
    </main>
  );
}
