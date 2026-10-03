'use client';

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';

import { Button } from './Button';
import { Icon } from './Icon';
import styles from './Overlay.module.css';

/**
 * An overlay that behaves like one.
 *
 * The behaviour is the point, and there are four obligations that ad-hoc
 * `position: fixed` markup in this codebase was not meeting:
 *
 *   1. **Escape closes it.** An operator who opens the wrong dialog reaches for
 *      Escape before the mouse; a dialog that ignores it is a dialog they have to
 *      aim inside.
 *   2. **Focus goes in, and stays in.** Focus moves to the panel on open, so the
 *      next Tab does not walk the page behind it, and Tab is wrapped at the edges
 *      so it cannot escape into the screen underneath — which is not merely
 *      untidy: on the till, the screen underneath is the cart, and a Tab that
 *      lands on "รับชำระเงิน" while a payment dialog is open is a double charge.
 *   3. **Focus returns.** It goes back to whatever had it before, so a keyboard
 *      user is not dumped at the top of the document.
 *   4. **The page behind does not scroll**, but the panel can.
 *
 * `role="dialog"` plus `aria-modal` plus a labelled title is what turns all of that
 * into something a screen reader announces as a dialog rather than as more page.
 */
function useOverlay(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    restoreTo.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const focusable = (): HTMLElement[] =>
      panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.offsetParent !== null || element === document.activeElement)
        : [];

    // The panel first, then the first control inside it — a dialog with no
    // controls (a receipt) must still take focus off the page behind it.
    const targets = focusable();
    (targets[0] ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  return panelRef;
}

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** A sheet rises from the bottom edge; right for a thumb, wrong for a form. */
  variant?: 'modal' | 'sheet';
  wide?: boolean;
  /**
   * A larger panel, for the screens an operator works *inside* rather than dismisses.
   *
   * The pay sheet is the case this exists for: taking money is the one till screen a
   * cashier spends real time on, and the default sheet's 30rem / 70vh left the keypad
   * half below the fold, so the amount being entered could not be seen while it was
   * being typed. `md` is the default; `lg` trades the dialog's usual width for the
   * keypad's — the buttons stay put and the money stops scrolling.
   */
  size?: 'md' | 'lg';
  /** Hides the close button when the only way out is a deliberate action. */
  hideClose?: boolean;
}

export function Overlay({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'modal',
  wide = false,
  size = 'md',
  hideClose = false,
}: OverlayProps) {
  const panelRef = useOverlay(open, onClose);
  const titleId = useId();
  const descriptionId = useId();

  if (!open) {
    return null;
  }

  const isSheet = variant === 'sheet';

  return (
    <div
      className={`${styles.scrim} ${isSheet ? styles.scrimBottom : styles.scrimCentered}`}
      /*
       * Clicking the backdrop closes, clicking inside must not. Comparing targets
       * rather than stopping propagation keeps the behaviour identical for a
       * keyboard "click" and a real one.
       */
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`${styles.panel} ${isSheet ? styles.sheet : styles.modal} ${wide ? styles.wide : ''} ${size === 'lg' ? styles.sizeLg : ''}`}
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title} id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className={styles.description} id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          {hideClose ? null : (
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="ปิด">
              <Icon name="close" size={18} />
            </Button>
          )}
        </header>

        <div className={styles.body}>{children}</div>

        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * A confirmation for something that cannot be undone.
 *
 * `confirmLabel` is required and `tone="danger"` is opt-in, because the failure
 * this prevents is a generic "OK/Cancel" dialog on a destructive action — where
 * "OK" means "delete my order" and the operator has already learned that OK means
 * "yes, fine".
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'ยกเลิก',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Extra content above the buttons, e.g. the amount being cancelled. */
  children?: ReactNode;
}) {
  const close = useCallback(() => {
    if (!busy) {
      onCancel();
    }
  }, [busy, onCancel]);

  return (
    <Overlay
      open={open}
      onClose={close}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Overlay>
  );
}
