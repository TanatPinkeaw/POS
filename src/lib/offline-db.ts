/**
 * The device's own storage for the till — ADR 0019.
 *
 * **This module makes no decisions, deliberately.** Every rule the offline till obeys
 * lives in a pure module (`offline-sale-rules.ts`, `number-block.ts`, `sync-plan.ts`)
 * and `till-store.ts` holds the seam. This file opens a database, commits a record and
 * reads one back, and that is the whole of it — kept empty of rules because that is what
 * makes the real Chromium journey (`scripts/offline-browser.ts`) an acceptable test of it
 * rather than a hole in the money code.
 *
 * Three facts about the platform shape this file, and each is a decision worth keeping:
 *
 *  1. **A successful request is not a committed write.** An IndexedDB request's `onsuccess`
 *     fires before the surrounding transaction has committed, so `withStore` resolves on
 *     `transaction.oncomplete` — the only moment the browser guarantees the bytes are
 *     durable. Resolving early would let the till show a paid bill that a crash erases.
 *  2. **There is no fallback to volatile storage.** A device whose storage fails must
 *     *stop being able to sell offline*, not silently keep bills in memory that a refresh
 *     discards. So a failed read/write throws and flips `persists` to false in the same
 *     step; `till-store.ts` turns that into a refusal and `offlineNotice` into a sentence
 *     the operator reads. Degrading to `createMemoryStorage()` — which this used to do —
 *     is the exact failure the ADR forbids.
 *  3. **The writer lock is native.** Web Locks (`acquireTillWriter`) holds one lock for the
 *     lifetime of a counter rather than a lease with a clock to drift, which is what lets
 *     two tabs of the same browser reach one till without both borrowing a range.
 */
import type { PersistedTill, TillStorage } from './till-store';

const DATABASE_NAME = 'pos-offline';
/**
 * One shop per deployment and one device per browser, so one record holds everything. A
 * version bump with no migration is intentional: what is stored is a snapshot and a queue
 * of bills, both of which the device rebuilds from the server — except unsent bills, which
 * is why the upgrade never deletes the store it finds.
 */
const STORE_NAME = 'till';
const STATE_KEY = 'state';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME)) open.result.createObjectStore(STORE_NAME);
    };
    /*
     * `onblocked` fires when another tab holds an old connection open. It is an error rather
     * than a wait: a till that cannot reach its own storage must say so, and the operator's
     * next step (close the other tab) is not something a spinner communicates.
     */
    let blocked = false;
    open.onblocked = () => { blocked = true; reject(new Error('Offline database upgrade blocked')); };
    open.onerror = () => reject(open.error ?? new Error('Offline database unavailable'));
    open.onsuccess = () => { if (blocked) open.result.close(); else resolve(open.result); };
  });
}

/**
 * Runs one operation and resolves only once its transaction has committed.
 *
 * The two error channels are kept apart on purpose: `onabort` is a transaction the browser
 * rolled back (quota, a constraint), `onerror` is a request that failed inside a live
 * transaction, and `till-store` treats the difference as "nothing was written" versus
 * "a write may be half-done". Both reject, so the caller never sees a promise resolve for
 * work the database refused.
 */
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      let value: T;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Offline transaction failed'));
      try {
        const request = run(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => { value = request.result; };
        request.onerror = () => reject(request.error ?? new Error('Offline request failed'));
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  } finally {
    database.close();
  }
}

/** The device store the till actually runs on. */
export function createIndexedDbStorage(): TillStorage {
  return {
    persists: true,
    read: async () => (await withStore<PersistedTill | undefined>('readonly', (store) => store.get(STATE_KEY))) ?? null,
    write: async (state) => { await withStore('readwrite', (store) => store.put(state, STATE_KEY)); },
  };
}

/**
 * Storage that forgets between page loads.
 *
 * Exported because a test injects it, and because it is the honest answer for a browser with
 * no `indexedDB` at all — `persists: false` is what tells `till-store` it must not accept an
 * offline payment. It is **never** a destination a failed IndexedDB write may fall back to:
 * that decision is the ADR's, and `createDeviceStorage` below implements it.
 */
export function createMemoryStorage(): TillStorage {
  let state: PersistedTill | null = null;
  return {
    persists: false,
    read: async () => state,
    write: async (next) => { state = next; },
  };
}

/**
 * The storage this device has: IndexedDB when the browser offers it, memory only when it
 * has none at all — and **never** a memory fallback after a failure.
 *
 * The distinction is the whole point. A browser with no `indexedDB` is known before anything
 * is read, and falling back there is safe because no bill has been accepted yet. A database
 * that is locked, out of quota or left broken by an upgrade only shows itself on the first
 * `read`/`write`, and at that point a bill may be in flight — so the failure propagates and
 * `persists` becomes false, which is what turns a broken database into the one thing the
 * operator must be told rather than a sale the device cannot actually keep.
 */
export function createDeviceStorage(): TillStorage {
  if (typeof indexedDB === 'undefined') return createMemoryStorage();
  const disk = createIndexedDbStorage();
  let healthy = true;
  return {
    get persists() { return healthy; },
    async read() {
      try { return await disk.read(); } catch (error) { healthy = false; throw error; }
    },
    async write(state) {
      try { await disk.write(state); } catch (error) { healthy = false; throw error; }
    },
  };
}

/**
 * One writer per browser, held as a native cross-tab lock.
 *
 * A Web Lock rather than a lease row with a clock: the lock lives exactly as long as the
 * counter's page, so there is no expiry to tune and no window in which two tabs both believe
 * they hold the till. `ifAvailable` never queues — a second tab is told "no" immediately so
 * it can render the "another tab is selling" notice rather than appear to hang.
 *
 * Resolves with a `release` function while holding the lock, or `null` when the browser has
 * no Web Locks (older engines) or another tab already holds it.
 *
 * The underlying request is coalesced per document, and that is load-bearing under React's
 * development StrictMode. StrictMode mounts an effect, tears it down, and mounts it again;
 * the teardown runs before the first `navigator.locks.request` has resolved, so there is no
 * release function for it to call yet. A second, uncoalesced request made while the first is
 * still held makes `ifAvailable` answer "no" — and the till then decides another tab is
 * selling when the only other "tab" was itself, leaving ยืนยันรับเงิน disabled for the whole
 * session. Counting the holders means the second mount shares the first request, and the lock
 * is dropped only when the last holder lets go. Two real tabs are still two documents, each
 * making its own request, so cross-tab detection is unchanged.
 */
let tillWriterLock: { request: Promise<(() => void) | null>; holders: number } | null = null;

function requestTillWriterLock(): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    void navigator.locks.request('pos-till-writer', { ifAvailable: true }, async (lock) => {
      if (!lock) { resolve(null); return; }
      await new Promise<void>((release) => resolve(release));
    }).catch(() => resolve(null));
  });
}

export function acquireTillWriter(): Promise<(() => void) | null> {
  if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(null);

  const entry = (tillWriterLock ??= { request: requestTillWriterLock(), holders: 0 });
  entry.holders += 1;

  return entry.request.then((release) => {
    if (release === null) {
      // Another document holds the lock, so this caller is not the writer and there is
      // nothing to release later. Kept distinct from a shared request that succeeded:
      // `Boolean(release)` is how the till decides whether it may sell.
      entry.holders -= 1;
      if (entry.holders <= 0 && tillWriterLock === entry) {
        tillWriterLock = null;
      }
      return null;
    }

    let finished = false;
    return () => {
      if (finished) {
        return;
      }
      finished = true;
      entry.holders -= 1;
      if (entry.holders <= 0) {
        if (tillWriterLock === entry) {
          tillWriterLock = null;
        }
        release();
      }
    };
  });
}
