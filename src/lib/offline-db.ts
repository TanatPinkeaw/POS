/**
 * The device's own storage for the till — ADR 0019.
 *
 * **This module makes no decisions, deliberately.** Every rule the offline till obeys
 * lives in a pure module (`offline-sale-rules.ts`, `number-block.ts`, `sync-plan.ts`)
 * and `till-store.ts` holds the seam. This file opens a database, reads a record and
 * writes a record, and that is the whole of it — because it is the one part of the
 * offline path with **no automated test**: the suite runs in Node, and faking IndexedDB
 * means adding a dependency the repository refuses (rule 2). Keeping it empty of rules is
 * what makes that acceptable rather than a hole in the money code; `AGENTS.md`'s *Not yet
 * proven* list carries the gap in writing.
 *
 * Two shapes of "no IndexedDB" are expected and handled here rather than by callers:
 *
 *  - A browser that has none (private mode in some engines, a locked-down managed
 *    browser). The till must degrade to *not being able to sell offline* rather than to a
 *    screen that throws on load, so the fallback is a memory store that simply forgets.
 *  - A read or write that fails (quota, a database left in a broken state by an upgrade).
 *    The same answer: storage that does not answer is storage the device does not have.
 *
 * The second one is why `createDeviceStorage` is a wrapper rather than a choice made once:
 * the failure it describes only ever surfaces *after* the store has opened, and a rejected
 * `read()` would otherwise be an unhandled rejection in the till's own effect — the device
 * silently holding no snapshot and claiming it can keep billing. Degrading swaps the
 * implementation and drops `persists` to false in the same step, which is what turns a
 * broken database into the one thing the operator must be told (`offlineNotice`).
 */
import type { PersistedTill, TillStorage } from './till-store';

const DATABASE_NAME = 'pos-offline';
const DATABASE_VERSION = 1;
const STORE_NAME = 'till';
/** One shop per deployment and one device per browser, so one record holds everything. */
const STATE_KEY = 'state';

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Opens the database, creating the store on first run.
 *
 * A version bump with no migration is intentional: what is stored is a snapshot and a
 * queue of bills, and both are things the device can rebuild from the server. Carrying an
 * old shape forward would be more code than forgetting it.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Could not open the offline store'));
  });
}

/** Reads and writes one record through a transaction that commits on its own. */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const result = await run(transaction.objectStore(STORE_NAME));
    return result;
  } finally {
    database.close();
  }
}

/** The device store the till actually runs on. */
export function createIndexedDbStorage(): TillStorage {
  return {
    persists: true,

    async read(): Promise<PersistedTill | null> {
      const stored = await withStore('readonly', (store) =>
        request<PersistedTill | undefined>(store.get(STATE_KEY)),
      );
      return stored ?? null;
    },

    async write(state: PersistedTill): Promise<void> {
      await withStore('readwrite', (store) => request(store.put(state, STATE_KEY)));
    },
  };
}

/**
 * Storage that forgets between page loads, for a browser with no IndexedDB.
 *
 * Exported rather than hidden because it is also what a test injects, and because
 * "the till could not keep anything" is a fact the operator has to be told about
 * somewhere — `till-store.ts` reports it as `canKeep: false`.
 */
export function createMemoryStorage(): TillStorage {
  let state: PersistedTill | null = null;
  return {
    persists: false,
    read: () => Promise.resolve(state),
    write: (next) => {
      state = next;
      return Promise.resolve();
    },
  };
}

/**
 * The storage this device has: IndexedDB when the browser offers it, memory when it does
 * not — or when it stops answering. Never throws.
 *
 * Both halves matter and they happen at different times. A browser with no `indexedDB` at
 * all is known before anything is read; a database that is locked, out of quota or left
 * broken by an upgrade only shows itself on the first `read` or `write`, which is why the
 * wrapper swaps the implementation at that point instead of choosing once. Once swapped it
 * stays swapped: a store that has failed once must not be trusted with the next bill.
 */
export function createDeviceStorage(): TillStorage {
  if (typeof indexedDB === 'undefined') {
    return createMemoryStorage();
  }

  const memory = createMemoryStorage();
  let current = createIndexedDbStorage();

  return {
    get persists(): boolean {
      return current.persists;
    },
    read: () =>
      current.read().catch(() => {
        current = memory;
        return null;
      }),
    write: (state) =>
      current.write(state).catch(() => {
        current = memory;
        // The bill is kept where it can still be read back on this page — losing it
        // outright is the failure this whole branch exists to avoid — while `persists`
        // now says out loud that a refresh loses it.
        return memory.write(state);
      }),
  };
}
