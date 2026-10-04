'use client';

import { useRef, type ReactNode } from 'react';

import { Button } from './Button';
import { describedBy, FieldShell } from './Field';
import styles from './FileField.module.css';

/**
 * A file picker that belongs to the same design system as everything else.
 *
 * `<input type="file">` cannot be styled. The grey box that says "Choose File /
 * No file chosen" is not an element the page draws — it is a shadow widget the
 * operating system paints, in the operating system's own words and colours — so
 * every attempt to restyle it either does nothing or leaves something that looks
 * even less like the screen around it. It is also the one control on the screen
 * that never says *which* file is loaded, so a shop that picked the wrong
 * spreadsheet has no way to see that before it imports.
 *
 * So the real input stays: the native dialog, the keyboard and the form all need
 * it. It is visually hidden but still focusable, and a `Button` stands in front
 * of it. What the shop gains is the two things the raw control never said — the
 * file's name and its size — and a way to put the field back to nothing.
 *
 * The clear button resets `input.value` as well as the caller's state, and that is
 * not tidiness: an input still holding a file fires no `change` for that same
 * file again, so "choose the same one after changing my mind" would silently do
 * nothing at all.
 *
 * Every string is the caller's copy, like everywhere else in this design system.
 * A control whose wording moves with the locale it is rendered in is one
 * translation, not two — and this component carries no Thai.
 *
 * It is a client component in a file of its own, because it holds a ref to the
 * input and `Field.tsx` deliberately holds none: the shell and the text fields
 * are rendered by server components (the app shell draws its own toolbar), and a
 * hook in that module would take the whole file out of the server graph.
 */
export function FileField({
  id,
  label,
  help,
  error,
  hideLabel,
  accept,
  file,
  placeholder = 'No file chosen',
  buttonLabel = 'Choose a file',
  changeLabel = 'Choose another file',
  clearLabel = 'Clear',
  disabled,
  onSelect,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
  /** The same `accept` list the native dialog would have been given. */
  accept?: string;
  /** The chosen file, or null. The caller owns it — this never keeps a copy. */
  file: File | null;
  placeholder?: ReactNode;
  buttonLabel?: ReactNode;
  changeLabel?: ReactNode;
  clearLabel?: ReactNode;
  disabled?: boolean;
  onSelect: (file: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <FieldShell id={id} label={label} help={help} error={error} hideLabel={hideLabel}>
      <div className={styles.fileRow}>
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          disabled={disabled}
          className="ln-visually-hidden"
          onChange={(event) => onSelect(event.target.files?.[0] ?? null)}
          aria-describedby={describedBy(id, help, error)}
          aria-invalid={error ? true : undefined}
        />
        <Button
          variant="secondary"
          icon="upload"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          {file ? changeLabel : buttonLabel}
        </Button>
        <span className={file ? styles.fileName : styles.fileHint}>
          {file ? `${file.name} · ${humanFileSize(file.size)}` : placeholder}
        </span>
        {file ? (
          <Button
            variant="ghost"
            size="sm"
            icon="close"
            disabled={disabled}
            onClick={() => {
              if (inputRef.current) {
                inputRef.current.value = '';
              }
              onSelect(null);
            }}
          >
            {clearLabel}
          </Button>
        ) : null}
      </div>
    </FieldShell>
  );
}

/** Bytes as a shop can read them at a glance: 812 B, 4.3 KB, 1.2 MB. */
function humanFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}