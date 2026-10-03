/**
 * The drawer's last known state, read from the device itself.
 *
 * A till that opens with no network has one thing it may answer from memory and exactly one
 * that it may not: **the drawer it was already open on.** Everything about the sale —
 * prices, stock, the customer, the receipt number — comes from the server or not at all,
 * because a remembered number is a wrong number. The drawer is different: it was opened by
 * a person standing at this counter, on this till, with the float they counted out, and
 * ADR 0019 already forbids replacing the cashier or the drawer by a refresh. Refusing to
 * sell because the network is down would make that promise meaningless.
 *
 * So this module answers one narrow question — *was this device mid-shift, prepared, when
 * it last saw the server?* — and the rules are all in refusing:
 *
 *  1. **Preparation is required.** `heldBlocks` is the borrowed receipt and call-number
 *     ranges, and a device only holds them if a cashier prepared it for offline selling
 *     while online. An unprepared till was never allowed to take offline money, so it is
 *     not allowed to *pretend* to be mid-shift now; it would be answering for a drawer the
 *     server never confirmed, on a till that has never proven it can keep a bill.
 *  2. **A closed drawer stays closed.** A normal close releases every loan, so `heldBlocks`
 *     empties and this returns nothing — a drawer closed at the end of yesterday must not
 *     reappear on today's till.
 *  3. **A broken store is an answer of "no", not an exception.** A read that fails must not
 *     take the till screen down with it; there is simply nothing to remember.
 *
 * The figures come with the capture time so the screen can say what they are (see
 * `useOpenShift`), because a shift total read ten minutes ago and presented as a live one
 * is the same kind of lie this feature exists to stop.
 */
import { createIndexedDbStorage } from './offline-db';
import type { DeviceShift } from './till-store';

export interface DeviceDrawer {
  readonly shift: DeviceShift;
  /** ISO instant of the sync this came from — the screen shows it rather than hiding it. */
  readonly capturedAt: string;
  readonly deviceLabel: string;
}

/** The drawer this device was in the middle of, or `null` for any reason it cannot say. */
export async function readDeviceDrawer(): Promise<DeviceDrawer | null> {
  let stored: Awaited<ReturnType<ReturnType<typeof createIndexedDbStorage>['read']>> = null;
  try {
    stored = await createIndexedDbStorage().read();
  } catch {
    return null;
  }

  const snapshot = stored?.snapshot;
  if (!snapshot?.shift || snapshot.heldBlocks.length === 0) {
    return null;
  }

  return { shift: snapshot.shift, capturedAt: snapshot.capturedAt, deviceLabel: snapshot.deviceLabel };
}