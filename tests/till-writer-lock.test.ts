/**
 * The till writer lock.
 *
 * `acquireTillWriter` guards the one thing two tabs of the same browser must not both do:
 * sell as the same counter. Its failure mode is silent and total — the pay button stays
 * disabled for the whole session and the notice that explains it sits on the page the pay
 * sheet is covering — so the two cases that must hold are pinned here: a StrictMode
 * double-mount shares one lock, and an already-held lock is refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type LockCallback = (lock: unknown) => Promise<void> | void;

/** A Web Locks stand-in: `ifAvailable` refuses, otherwise the lock is held until the callback settles. */
function createFakeLocks(): { held: Set<string>; request: (name: string, options: unknown, cb: LockCallback) => Promise<void> } {
  const held = new Set<string>();
  return {
    held,
    request(name, _options, cb) {
      if (held.has(name)) {
        return Promise.resolve(cb(null));
      }
      held.add(name);
      return Promise.resolve(cb({ name })).finally(() => {
        held.delete(name);
      });
    },
  };
}

const LOCK = 'pos-till-writer';

/** Lets the fake lock manager's `.finally` (a microtask) run before an assertion reads `held`. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function withLocks(locks: ReturnType<typeof createFakeLocks>): Promise<typeof import('@/lib/offline-db')> {
  vi.resetModules();
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  return import('@/lib/offline-db');
}

afterEach(() => {
  // Remove the stub so no later test inherits a fake lock manager.
  Reflect.deleteProperty(globalThis.navigator, 'locks');
  vi.resetModules();
});

describe('acquireTillWriter', () => {
  it('shares one lock across a StrictMode double-mount', async () => {
    const locks = createFakeLocks();
    const { acquireTillWriter } = await withLocks(locks);

    // Mount, teardown, mount: the teardown happens before the first request has resolved,
    // so the second call arrives while the first still holds the lock.
    const first = acquireTillWriter();
    const second = acquireTillWriter();

    const releaseFirst = await first;
    const releaseSecond = await second;

    // Before the fix the second call was refused and answered null.
    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();
    expect(locks.held.has(LOCK)).toBe(true);

    // The first mount's teardown must not drop a lock the second mount is still using.
    releaseFirst?.();
    await flush();
    expect(locks.held.has(LOCK)).toBe(true);

    releaseSecond?.();
    await flush();
    expect(locks.held.has(LOCK)).toBe(false);
  });

  it('refuses when another document already holds the lock', async () => {
    const locks = createFakeLocks();
    locks.held.add(LOCK);
    const { acquireTillWriter } = await withLocks(locks);

    expect(await acquireTillWriter()).toBeNull();
  });
});
