/**
 * How much of this origin the till's service worker is allowed to manage.
 *
 * `public/sw.js` is served from the site root, so a plain
 * `navigator.serviceWorker.register('/sw.js')` claims the **whole origin** — and that is
 * what this deployment did until ADR 0024 was amended. The argument for it was that
 * everything the worker does not manage is passed straight through, which is true; the
 * argument against it is that a browser which has ever opened the till keeps the worker
 * forever, and every request a *customer's* page makes then passes through a worker whose
 * subject is a cash drawer. A rule that is safe because it is narrow is cheaper to trust
 * than one that is safe because it is careful.
 *
 * So the scope is `/pos` and below — the four prepared screens and their chunks — and the
 * storefront, the back office and the public receipt page are not the worker's business at
 * all. It lives in `src/` rather than inside `public/sw.js` because `public/` is not
 * importable: the registrar needs the number, and a test needs to hold it against the
 * worker's own route list (`tests/offline-shell.test.ts`).
 */
export const TILL_SHELL_SCOPE = '/pos';
