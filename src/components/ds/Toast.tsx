'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { Icon } from './Icon';
import type { IconName } from './icons';
import styles from './Toast.module.css';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

interface ToastRecord {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
}

const TONE_ICON: Record<ToastTone, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'warning',
};

interface ToastApi {
  /** Shows a message that disappears on its own. */
  show: (toast: { title: string; body?: string; tone?: ToastTone; ms?: number }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Transient messages, announced once.
 *
 * The reason a provider exists rather than a component per screen is the live
 * region. A message that is painted but not announced is invisible to a screen
 * reader, and a message rendered by ten different screens is ten live regions —
 * some of which are mounted while empty, which is how a screen reader ends up
 * announcing nothing at all. One region, at the root, doing all the talking.
 *
 * `polite` rather than `assertive`: these are confirmations, and interrupting an
 * operator mid-sentence to say "บันทึกแล้ว" is worse than the second of delay. The
 * one exception is a failure, which the caller can surface in an `InlineNotice`
 * where it will stay put instead.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const show = useCallback<ToastApi['show']>(({ title, body, tone = 'info', ms = 4000 }) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, title, body, tone } as ToastRecord]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, ms);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`${styles.toast} ${styles[`tone_${toast.tone}`]}`}>
            <span className={styles.icon} aria-hidden="true">
              <Icon name={TONE_ICON[toast.tone]} size={18} />
            </span>
            <div className={styles.text}>
              <p className={styles.title}>{toast.title}</p>
              {toast.body ? <p className={styles.body}>{toast.body}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * The toast API.
 *
 * Throws when used outside the provider rather than returning a no-op: a screen
 * that calls `show()` and silently does nothing is a screen whose confirmations
 * were never seen, and that failure is far more expensive to find later than it is
 * to make impossible now.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return api;
}
