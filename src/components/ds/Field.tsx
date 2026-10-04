import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { Icon } from './Icon';
import styles from './Field.module.css';

/**
 * Labelled form controls.
 *
 * The reason these exist rather than a pile of `form-control` classes is the
 * wiring, not the pixels. Every control needs an `id`, a `<label for>` that
 * matches it, and an `aria-describedby` pointing at whatever help or error text
 * is on screen. Doing that by hand in twenty forms is how error text ends up
 * visual-only — present on the glass, invisible to a screen reader, and wrong on
 * the one form somebody forgot.
 *
 * `id` is required and passed by the caller so the ids stay readable in a
 * rendered page (`identifier`, `password`) rather than generated; the derived
 * ids follow from it.
 */
interface FieldShellProps {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  /** Renders the label as visually hidden — for a control whose purpose is clear. */
  hideLabel?: boolean;
  children: ReactNode;
}

/**
 * The id list that points a control at its own help and error text.
 *
 * Exported because `FileField` lives in its own client module (it holds a ref,
 * and this file must stay free of hooks so server components can keep rendering
 * the fields) and still has to wire the same two ids.
 */
export function describedBy(id: string, help?: ReactNode, error?: ReactNode): string | undefined {
  const ids = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export function FieldShell({ id, label, help, error, hideLabel, children }: FieldShellProps) {
  return (
    <div className={styles.field}>
      <label className={hideLabel ? 'ln-visually-hidden' : styles.label} htmlFor={id}>
        {label}
      </label>
      {children}
      {help && !error ? (
        <p className={styles.help} id={`${id}-help`}>
          {help}
        </p>
      ) : null}
      {/*
       * A failure replaces the help text rather than stacking under it: two
       * paragraphs of small print under one input is where a user stops reading.
       */}
      {error ? (
        <p className={styles.error} id={`${id}-error`} role="alert">
          <Icon name="warning" size={16} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  id,
  label,
  help,
  error,
  hideLabel,
  className,
  ...rest
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <FieldShell id={id} label={label} help={help} error={error} hideLabel={hideLabel}>
      <input
        {...rest}
        id={id}
        className={`${styles.control} ${error ? styles.invalid : ''} ${className ?? ''}`}
        aria-describedby={describedBy(id, help, error)}
        aria-invalid={error ? true : undefined}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  id,
  label,
  help,
  error,
  hideLabel,
  className,
  rows = 3,
  ...rest
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
} & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell id={id} label={label} help={help} error={error} hideLabel={hideLabel}>
      <textarea
        {...rest}
        id={id}
        rows={rows}
        className={`${styles.control} ${styles.textarea} ${error ? styles.invalid : ''} ${className ?? ''}`}
        aria-describedby={describedBy(id, help, error)}
        aria-invalid={error ? true : undefined}
      />
    </FieldShell>
  );
}

export function SelectField({
  id,
  label,
  help,
  error,
  hideLabel,
  className,
  children,
  ...rest
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <FieldShell id={id} label={label} help={help} error={error} hideLabel={hideLabel}>
      <div className={styles.selectWrap}>
        <select
          {...rest}
          id={id}
          className={`${styles.control} ${styles.select} ${error ? styles.invalid : ''} ${className ?? ''}`}
          aria-describedby={describedBy(id, help, error)}
          aria-invalid={error ? true : undefined}
        >
          {children}
        </select>
        <span className={styles.selectChevron} aria-hidden="true">
          <Icon name="chevronDown" size={16} />
        </span>
      </div>
    </FieldShell>
  );
}

/**
 * A two-state control with its label on the right, as shop software normally
 * writes them ("ให้ส่วนลด VAT" reads as a statement, not as a form).
 */
export function ToggleField({
  id,
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.toggleRow}>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-describedby={help ? `${id}-help` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`${styles.toggle} ${checked ? styles.toggleOn : ''}`}
      >
        <span className={styles.toggleKnob} />
        <span className="ln-visually-hidden">{typeof label === 'string' ? label : 'toggle'}</span>
      </button>
      <label className={styles.toggleLabel} htmlFor={id}>
        {label}
        {help ? (
          <span className={styles.toggleHelp} id={`${id}-help`}>
            {help}
          </span>
        ) : null}
      </label>
    </div>
  );
}

/** Groups fields into a row on wide screens, a stack on narrow ones. */
export function FieldRow({ children, columns = 2 }: { children: ReactNode; columns?: 2 | 3 }) {
  return (
    <div className={styles.row} data-columns={columns}>
      {children}
    </div>
  );
}
