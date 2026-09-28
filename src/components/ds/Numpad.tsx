'use client';

import styles from './Numpad.module.css';

/**
 * An on-screen number pad.
 *
 * The reference design's checkout keeps cash entry on the glass instead of relying
 * on a keyboard, and the reason holds for a grocery counter: the keyboard is
 * usually under the counter or behind the receipt printer, and the operator's other
 * hand is holding the note. Typing "500" on a pad beside the amount is one tap
 * sequence with a target measured in centimetres.
 *
 * It is deliberately *not* a text input on a keypad: the pad writes into whatever
 * the caller stores, so the field above it stays a normal focusable input that a
 * keyboard can still fill — a till with a broken touch panel must remain usable.
 */
export function Numpad({
  onInput,
  onBackspace,
  onClear,
  label = 'แป้นตัวเลข',
}: {
  /** Receives '0'…'9' and '.', as characters, so the caller owns the parsing. */
  onInput: (key: string) => void;
  onBackspace: () => void;
  onClear?: () => void;
  label?: string;
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'];

  return (
    <div className={styles.pad} role="group" aria-label={label}>
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          className={`${styles.key} ${key === '.' ? styles.keyWide : ''}`}
          onClick={() => onInput(key)}
        >
          <span aria-hidden="true">{key}</span>
          {/* Spelled out for a screen reader: "." is read as "period" at best. */}
          <span className="ln-visually-hidden">{key === '.' ? 'จุดทศนิยม' : key}</span>
        </button>
      ))}
      <button type="button" className={styles.key} onClick={onBackspace} aria-label="ลบหนึ่งหลัก">
        <span aria-hidden="true">⌫</span>
      </button>
      {onClear ? (
        <button type="button" className={`${styles.key} ${styles.keyClear}`} onClick={onClear}>
          ล้าง
        </button>
      ) : null}
    </div>
  );
}

/**
 * The note buttons a Thai till actually needs: 20/50/100/500/1000, plus "พอดี".
 *
 * "พอดี" (exactly) is the one that matters — most cash sales are exact or a round
 * note, and a single button that fills the exact amount removes the most common
 * sequence of taps in the whole application.
 */
export function QuickCash({
  denominations = [20, 50, 100, 500, 1000],
  onPick,
  onExact,
  exactLabel = 'พอดี',
}: {
  denominations?: number[];
  onPick: (amount: number) => void;
  onExact?: () => void;
  exactLabel?: string;
}) {
  return (
    <div className={styles.quick} role="group" aria-label="ธนบัตรเร็ว">
      {denominations.map((amount) => (
        <button
          key={amount}
          type="button"
          className={styles.note}
          onClick={() => onPick(amount)}
        >
          <span aria-hidden="true">{amount.toLocaleString('en-US')}</span>
          <span className="ln-visually-hidden">{amount} บาท</span>
        </button>
      ))}
      {onExact ? (
        <button type="button" className={`${styles.note} ${styles.noteExact}`} onClick={onExact}>
          {exactLabel}
        </button>
      ) : null}
    </div>
  );
}
