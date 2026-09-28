/**
 * The customer display, as both ends see it.
 *
 * The display is a second screen on the same shop with no session, so this
 * module is the *contract* about what it may be told. Everything here is
 * broadcast to a browser standing in the middle of the shop where a queue can
 * read it, which is why the payloads are small and aggressively non-identifying:
 * a first name and a phone's last two digits are enough to recognise your own
 * pre-order, and an order number is enough to be called. No full name, no phone
 * number, no member id, no cost price.
 */
import type { PaymentIntentView } from './payment-intents-view';

/** One line of the bill being rung up, as the customer sees it. */
export interface DisplayLine {
  name: string;
  quantity: number;
  totalPrice: number;
}

/**
 * The whole cart, resent on every change.
 *
 * A full snapshot rather than deltas: the display reconnects, sleeps, and is
 * occasionally reloaded by whoever is cleaning up at closing time, and a snapshot
 * means none of those need a replay of what it missed.
 */
export interface DisplayCartPayload {
  lines: DisplayLine[];
  subtotalThb: number;
  discountThb: number;
  totalThb: number;
  /** Shown while the customer counts their notes out. */
  receivedThb: number | null;
  changeThb: number | null;
  /** First name only, and only while a member is attached. */
  memberFirstName: string | null;
}

/** The tile the customer reads while nobody is being served. */
export interface DisplayIdlePayload {
  shopName: string;
  logoUrl: string | null;
  /** Names of the shop's best sellers, from its own takings. */
  popular: string[];
  /** True when the shop is open — a closed drawer, not a closed shop. */
  sessionOpen: boolean;
}

/** A pre-order waiting to be collected. */
export interface DisplayReadyOrder {
  orderNumber: string;
  /** First name initial only: enough to recognise, useless to anyone else. */
  customerInitial: string | null;
  readyAt: string;
}

export interface DisplayReadyPayload {
  orders: DisplayReadyOrder[];
}

/**
 * A paired screen, as the settings screen lists it.
 *
 * `lastSeenAt` is the field that earns its place: a screen that has not been seen
 * for a week is a screen somebody unplugged, and an owner looking at this list
 * needs to tell that apart from one that is simply idle.
 */
export interface DisplayDeviceView {
  id: string;
  label: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  pairedByName: string | null;
}

/** What the display is showing right now, as one discriminated union. */
export type DisplayStage =
  | { stage: 'idle'; idle: DisplayIdlePayload }
  | { stage: 'selling'; cart: DisplayCartPayload }
  | { stage: 'paying'; intent: PaymentIntentView }
  | { stage: 'ready'; ready: DisplayReadyPayload };

/** How long the "ขอบคุณ" thank-you stays on screen after a sale. */
export const DISPLAY_THANKS_MS = 4000;

/**
 * Where the display sends its device token.
 *
 * Declared here rather than in `display-devices.ts` because the screen's own code
 * has to set the header, and that module imports `node:crypto` and Prisma —
 * importing it from a component would drag both into the browser bundle.
 *
 * A header rather than a cookie: the page is unauthenticated, so a cookie would
 * ride along on every request to the origin, including the ones that have nothing
 * to do with this screen.
 */
export const DISPLAY_TOKEN_HEADER = 'x-display-token';

/**
 * First name, from a full name.
 *
 * Thai names are written given-name-first, so the first token is the one the
 * customer is called by. No surname: a surname plus a counter is a person, and
 * this screen faces a queue.
 */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
}

/** `สมชาย` → `ส.` — for the collection board. */
export function initialOf(fullName: string): string {
  const first = firstName(fullName);
  return first.length > 0 ? `${first[0]}.` : '';
}
