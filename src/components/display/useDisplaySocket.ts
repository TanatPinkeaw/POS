'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { ApiError, apiFetch } from '@/lib/client-api';
import {
  DISPLAY_TOKEN_HEADER,
  type DisplayCartPayload,
  type DisplayIdlePayload,
  type DisplayReadyPayload,
} from '@/lib/display-view';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import type { PaymentIntentView } from '@/lib/payment-intents-view';

export interface DisplayState {
  cart: DisplayCartPayload | null;
  intent: PaymentIntentView | null;
  ready: DisplayReadyPayload | null;
  /** The shop's name and best sellers, for the idle stage. Fetched, not pushed. */
  idle: DisplayIdlePayload | null;
  /** Set when the money arrived, so the screen can celebrate rather than wait. */
  paid: PaymentIntentView | null;
  connected: boolean;
  /** The device token was refused: the screen was revoked or the token is stale. */
  revoked: boolean;
}

const EMPTY: DisplayState = {
  cart: null,
  intent: null,
  ready: null,
  idle: null,
  paid: null,
  connected: false,
  revoked: false,
};

/**
 * The display's socket, and the four things it can be told.
 *
 * The socket carries facts as they happen. Everything that was already true when
 * the screen arrived — the shop's name, the waiting pre-orders — is fetched from
 * `/api/v1/display/state` on mount and again on every reconnect, because a screen
 * that is plugged in between two sales produces no event and would otherwise sit
 * on an empty welcome for the rest of the day.
 *
 * Reconnecting is Socket.io's business — it retries on its own, and the server
 * re-verifies the device token on each attempt, which is what makes revoking a
 * screen take effect the next time it reconnects. The state fetch is behind the
 * same check, so a revoked screen is also told so rather than left waiting.
 *
 * A cart snapshot updates the bill and **nothing else**. It used to clear the
 * payment too — the reasoning being that a new basket means the customer in
 * front has moved on — but the till re-pushes the same basket the moment the QR
 * appears (the payload carries the received/change fields, which go null while a
 * QR is live), so the effect was to wipe the QR off the customer's screen a
 * fifth of a second after issuing it. What a QR is payable is a question the
 * intent itself answers: `payment:closed` says the till gave up on it, the
 * expire timer below says the clock ran out, and `payment:paid` says the money
 * arrived. None of those is something a bill snapshot knows.
 */
export function useDisplaySocket(token: string | null): DisplayState {
  const [state, setState] = useState<DisplayState>(EMPTY);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token) {
      setState(EMPTY);
      return;
    }

    let closed = false;

    const loadState = async (): Promise<void> => {
      try {
        const payload = await apiFetch<{
          idle: DisplayIdlePayload;
          ready: DisplayReadyPayload;
        }>('/api/v1/display/state', {
          headers: { [DISPLAY_TOKEN_HEADER]: token },
        });
        if (closed) {
          return;
        }
        setState((current) => ({ ...current, idle: payload.idle, ready: payload.ready, revoked: false }));
      } catch (caught) {
        if (closed) {
          return;
        }
        /*
         * Only a refusal is worth acting on. Anything else — the server
         * restarting, a laptop that lost the wifi — is transient, and the next
         * reconnect fetches again; treating it as revoked would unpair a screen
         * every time the network hiccuped.
         */
        if (caught instanceof ApiError && caught.status === 401) {
          setState((current) => ({ ...current, revoked: true }));
        }
      }
    };

    // Started before the socket rather than after: the idle board should be up
    // as soon as the screen is, and the socket's own connect is not guaranteed
    // to be quicker than a plain GET.
    void loadState();

    const socket = io({
      path: '/realtime',
      auth: { displayToken: token },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setState((current) => ({ ...current, connected: true }));
      // Re-fetched on every connect: a screen that was unplugged over lunch has
      // missed every "order ready" and "order collected" in the meantime.
      void loadState();
    });
    socket.on('disconnect', () => setState((current) => ({ ...current, connected: false })));

    socket.on(REALTIME_EVENTS.displayCart, (payload: DisplayCartPayload) => {
      setState((current) => ({ ...current, cart: payload }));
    });

    socket.on(REALTIME_EVENTS.paymentIntent, (payload: PaymentIntentView) => {
      setState((current) => ({ ...current, intent: payload, paid: null }));
    });

    socket.on(REALTIME_EVENTS.paymentPaid, (payload: PaymentIntentView) => {
      setState((current) => ({ ...current, paid: payload, intent: null }));
    });      socket.on(REALTIME_EVENTS.paymentClosed, () => {
        setState((current) => ({ ...current, intent: null }));
      });

    socket.on(REALTIME_EVENTS.displayReady, (payload: DisplayReadyPayload) => {
      setState((current) => ({ ...current, ready: payload }));
    });

    return () => {
      closed = true;
      socket.close();
      socketRef.current = null;
    };
  }, [token]);

  /*
   * The QR takes itself off the screen when its clock runs out.
   *
   * The server sweeps the intent independently, and this screen does not wait to
   * be told: a QR left on a customer screen past its expiry is a QR the next
   * customer tries to scan, and one missed `payment:closed` — a reconnect, a
   * dropped frame — would leave it there until somebody reloaded the page.
   *
   * Deliberately not cleared when the socket drops. A QR is still payable while
   * the display is reconnecting, and hiding a live one costs a sale.
   */
  useEffect(() => {
    const intent = state.intent;
    if (!intent) {
      return;
    }

    const left = new Date(intent.expiresAt).getTime() - Date.now();
    if (left <= 0) {
      setState((current) => ({ ...current, intent: null }));
      return;
    }

    const timer = window.setTimeout(() => {
      setState((current) => ({ ...current, intent: null }));
    }, left);
    return () => window.clearTimeout(timer);
  }, [state.intent]);

  return state;
}

/**
 * Where the token lives.
 *
 * `localStorage` rather than a cookie, and that is the safer choice here rather
 * than the lazy one: this page is unauthenticated, so a cookie would be sent to
 * every route on the origin, while the token stays in this tab's storage. The
 * screen is a fixed installation, so losing it on a browser reset costs one
 * pairing rather than an account.
 */
export const DISPLAY_TOKEN_KEY = 'ln-display-token';

export function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(DISPLAY_TOKEN_KEY);
  } catch {
    // Storage can be unavailable in a locked-down browser; treating that as "not
    // paired" leads the operator to the pairing screen, which is the right place
    // to discover it.
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    window.localStorage.setItem(DISPLAY_TOKEN_KEY, token);
  } catch {
    // Nothing to do: the screen works for this tab's lifetime and asks to pair
    // again after a reload.
  }
}

export function clearStoredToken(): void {
  try {
    window.localStorage.removeItem(DISPLAY_TOKEN_KEY);
  } catch {
    // As above.
  }
}
