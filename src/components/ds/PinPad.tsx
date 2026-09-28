'use client';

import styles from './Numpad.module.css';

/**
 * A digits-only pad, for a supervisor PIN.
 *
 * Separate from `Numpad` rather than a flag on it, because the two differ in a
 * way that matters under a customer's gaze: a PIN has no decimal point and no
 * thousands, so a `.` key would be a key that does nothing. Sharing the CSS keeps
 * them the same size and shape, which is what makes the second pad feel like the
 * first one rather than like a different control.
 *
 * The order is `ล้าง · 0 · ⌫` on the last row — clear on the left, where a thumb
 * reaches without looking, backspace on the right, where a mistake gets corrected.
 */
export function PinPad({
  onInput,
  onBackspace,
  onClear,
  label = 'แป้น PIN',
  disabled = false,
}: {
  /** Receives '0'…'9' as characters, so the caller owns the state. */
  onInput: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  label?: string;
  disabled?: boolean;
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className={styles.pad} role="group" aria-label={label}>
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          className={styles.key}
          disabled={disabled}
          onClick={() => onInput(key)}
        >
          <span aria-hidden="true">{key}</span>
          <span className="ln-visually-hidden">{key}</span>
        </button>
      ))}

      <button
        type="button"
        className={`${styles.key} ${styles.keyClear}`}
        disabled={disabled}
        onClick={onClear}
      >
        ล้าง
      </button>

      <button
        type="button"
        className={styles.key}
        disabled={disabled}
        onClick={() => onInput('0')}
      >
        <span aria-hidden="true">0</span>
        <span className="ln-visually-hidden">0</span>
      </button>

      <button
        type="button"
        className={styles.key}
        disabled={disabled}
        onClick={onBackspace}
        aria-label="ลบหนึ่งหลัก"
      >
        <span aria-hidden="true">⌫</span>
      </button>
    </div>
  );
}
