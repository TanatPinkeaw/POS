// Seam under test: the address a press of the LINE door carries (ADR 0030 §1, amended).
//
// The press used to reach a route of ours, which answered with a redirect to LINE. It now
// reaches LINE's own authorization URL, with the state minted while the page was painted —
// because LINE's guide to the phone failure lists a JavaScript redirect to that URL among
// the cases the app handoff does not survive, and recommends letting the customer tap a
// button that goes to it. What is pinned here is the pair that makes that safe: the address
// is LINE's, and the state inside it is a *first* walk of the door the button meant.
import { describe, expect, it } from 'vitest';

import { LINE_AUTHORIZE_URL, LINE_CALLBACK_PATH, lineRedirectUri } from '@/lib/line-door';
import { lineStartHref } from '@/lib/line-start';
import { verifyLineState } from '@/lib/line-state';

const BASE = 'https://pos.example.com';
const CHANNEL = '2001234567';

const press = async (intent: 'sign-in' | 'bind'): Promise<URL> =>
  new URL(await lineStartHref({ intent, base: BASE, channelId: CHANNEL }));

describe('the address the sign-in button carries', () => {
  it('is LINE’s own authorization URL, not a route of ours', async () => {
    // The whole point of the change: a tap that lands on our route reaches LINE by
    // redirect, and a redirect is the shape LINE's guide steers away from.
    const url = await press('sign-in');

    expect(url.origin + url.pathname).toBe(LINE_AUTHORIZE_URL);
  });

  it('asks for the id token and names the callback address this deployment agrees on', async () => {
    const url = await press('sign-in');

    // `scope=openid` is what makes LINE return an id token at all, and the redirect_uri has
    // to be the one the callback's own exchange sends — character for character.
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}${LINE_CALLBACK_PATH}`);
    expect(url.searchParams.get('client_id')).toBe(CHANNEL);
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('leaves auto login on, because this is the entrance and not the recovery', async () => {
    expect((await press('sign-in')).searchParams.has('disable_auto_login')).toBe(false);
  });

  it('carries a state the callback reads as a first walk of the door the button meant', async () => {
    const state = (await press('sign-in')).searchParams.get('state') ?? '';

    expect(await verifyLineState(state)).toEqual({ intent: 'sign-in', retried: false });
  });

  it('mints the binding door from the same entrance, and says which door it is', async () => {
    // One press, one promise: the account card's press must arrive meaning `bind`, or the
    // callback would sign somebody in from a screen that promised to attach a row.
    const state = (await press('bind')).searchParams.get('state') ?? '';

    expect(await verifyLineState(state)).toEqual({ intent: 'bind', retried: false });
  });

  it('hands out a different state for every render, though a JWS over the same claims is identical', async () => {
    /*
     * Two renders inside one second minted byte-identical tokens before the `jti` claim:
     * the claims were the same and a JWS is deterministic over them. That was harmless while
     * the state was minted at a press, and is not now — this page is a public screen, and one
     * cached copy of it would hand every customer the same nonce.
     */
    const first = (await press('sign-in')).searchParams.get('state');
    const second = (await press('sign-in')).searchParams.get('state');

    expect(first).not.toBe(second);
  });
});

describe('the callback address LINE is handed', () => {
  it('is one path, however the base was written', () => {
    expect(lineRedirectUri('https://pos.example.com')).toBe(
      `https://pos.example.com${LINE_CALLBACK_PATH}`,
    );
    // The base is configuration a human types, and one trailing slash is a copy-paste
    // accident: `//api/...` is a redirect_uri LINE would refuse.
    expect(lineRedirectUri('https://pos.example.com///')).toBe(
      `https://pos.example.com${LINE_CALLBACK_PATH}`,
    );
  });
});
