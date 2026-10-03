'use client';

import { useEffect } from 'react';

/**
 * Hands the browser the till's own shell (ADR 0024).
 *
 * **Production only, and that is the load-bearing part.** A service worker that answers
 * with a cached document is the hardest class of bug to see while working: the change you
 * just made is not the page you are looking at, and the fix is a cache you have to find.
 * Development keeps its ordinary behaviour, where a reload is always the truth.
 *
 * **Mounted in the till area only.** The till is the surface that promises to keep selling
 * when the network is gone, so that is the only place that needs one. (The script itself is
 * served from the site root, so its scope is the whole origin — deliberate: a browser that
 * has been used as a till stays correct everywhere else, because everything that is not the
 * four prepared screens is passed straight through.)
 *
 * `updateViaCache: 'none'` because of the same reasoning as above: without it the HTTP
 * cache is allowed to answer for `sw.js` itself, and a worker that has been updated on the
 * server can sit on a till for weeks before the browser even asks for it.
 */
export function OfflineShellRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = (): void => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
        // A browser that refuses the worker still sells online, and says so the moment the
        // connection drops. Failing here quietly is better than a till that will not open.
      });
    };

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}