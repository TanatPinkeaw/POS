'use client';

import { useEffect, useState } from 'react';

/**
 * Whether the browser believes it has a network right now.
 *
 * `navigator.onLine` and the till's own "connected" indicator are different questions, and
 * both are wanted. The indicator follows the socket, which reports a dead link while the
 * machine may still have a working network; this follows the browser, which is the one that
 * matters when the decision is *how* to navigate — a client-side route change needs the
 * server to render a payload, so with no network it can only fail.
 *
 * Kept here rather than inside the frame that uses it: it is a browser fact, not a till
 * one, and the till's outage is already described properly by ADR 0019's own notice.
 */
export function useIsOffline(): boolean {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const sync = (): void => setOffline(!navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  return offline;
}