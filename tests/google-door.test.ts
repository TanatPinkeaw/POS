// Seam under test: which of Google's two sign-in shapes a device is asked for, and what
// an arrival at the redirect landing earns (ADR 0020 §1, amended).
//
// The defect this file exists for is one missing field. `google.accounts.id.initialize`
// has always been called without `ux_mode`, and Google's default is `popup` — the mode its
// supported-browser page documents as *not* for iOS ("Due to ITP redirect mode is
// required for iOS"). The shop's target phone is an iPhone (ADR 0031), so the default was
// the wrong ask on the only device that mattered, and nothing in the suite could see it.
//
// The decision is a pure function so that a phone and a desktop can both be asserted here,
// in one place, without a browser: the browser is what proves it *arrived*, and this file
// is what proves it is the right value.
import { describe, expect, it } from 'vitest';

import {
  GOOGLE_REDIRECT_LOGIN_PATH,
  GOOGLE_UX_MODE_POPUP,
  GOOGLE_UX_MODE_REDIRECT,
  googleInitializeConfig,
  googleLandingUrl,
  googleRedirectLoginUri,
  googleUxModeFor,
  planGoogleArrival,
} from '@/lib/google-door';

/** A real iPhone user agent, as Safari sends it. */
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1';

describe('which Google UX mode a device gets', () => {
  it('asks for redirect on an iPhone, because Google requires it there', () => {
    expect(googleUxModeFor({ userAgent: IPHONE, maxTouchPoints: 5, platform: 'iPhone' })).toBe(
      GOOGLE_UX_MODE_REDIRECT,
    );
  });

  it('asks for redirect on an iPad reporting itself as a Mac', () => {
    // iPadOS Safari sends `Macintosh` in the user agent and `MacIntel` in `platform`; the
    // touch screen is the only thing that separates it from a laptop, which is why the
    // second signal is read at all.
    const ipad =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15';
    expect(googleUxModeFor({ userAgent: ipad, maxTouchPoints: 5, platform: 'MacIntel' })).toBe(
      GOOGLE_UX_MODE_REDIRECT,
    );
  });

  it('keeps the popup on a Mac with a trackpad', () => {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15';
    expect(googleUxModeFor({ userAgent: mac, maxTouchPoints: 0, platform: 'MacIntel' })).toBe(
      GOOGLE_UX_MODE_POPUP,
    );
  });

  it('keeps the popup on Chrome on an Android phone, where Google asks for nothing special', () => {
    const android =
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    expect(googleUxModeFor({ userAgent: android, maxTouchPoints: 5, platform: 'Linux armv8l' })).toBe(
      GOOGLE_UX_MODE_POPUP,
    );
  });

  it('treats Chrome and Firefox on iOS as iOS, because on iOS they are WebKit', () => {
    // There is no engine to switch to (ADR 0031), so ITP is in front of them exactly as it
    // is in front of Safari.
    const crios = `${IPHONE} CriOS/120.0.6099.119`;
    const fxios = `${IPHONE} FxiOS/121.0`;

    expect(googleUxModeFor({ userAgent: crios, maxTouchPoints: 5, platform: 'iPhone' })).toBe(
      GOOGLE_UX_MODE_REDIRECT,
    );
    expect(googleUxModeFor({ userAgent: fxios, maxTouchPoints: 5, platform: 'iPhone' })).toBe(
      GOOGLE_UX_MODE_REDIRECT,
    );
  });

  it('falls back to the popup for anything it cannot recognise', () => {
    // The safe direction: an unrecognised device keeps the behaviour the deployment already
    // had, where a wrong answer the other way would send a desktop through a mode it does
    // not need. Missing signals count as unrecognised.
    expect(googleUxModeFor({ userAgent: '' })).toBe(GOOGLE_UX_MODE_POPUP);
    expect(googleUxModeFor({ userAgent: 'something new', maxTouchPoints: 9, platform: '' })).toBe(
      GOOGLE_UX_MODE_POPUP,
    );
  });
});

describe('what is handed to google.accounts.id.initialize', () => {
  const loginUri = 'https://pos.example.com/api/v1/auth/google/redirect';

  it('carries ux_mode and login_uri together in redirect mode', () => {
    // They travel as a pair: `redirect` without a registered endpoint is not a flow, it is a
    // form POST to a URL nobody answers.
    expect(
      googleInitializeConfig({ clientId: 'a-client', mode: GOOGLE_UX_MODE_REDIRECT, loginUri }),
    ).toEqual({
      client_id: 'a-client',
      ux_mode: GOOGLE_UX_MODE_REDIRECT,
      login_uri: loginUri,
    });
  });

  it('does not ask for redirect when the deployment cannot name its own address', () => {
    // A degraded door, not a broken one: the popup needs no endpoint, so a request with no
    // Host to name itself by still has a working Google door.
    expect(
      googleInitializeConfig({ clientId: 'a-client', mode: GOOGLE_UX_MODE_REDIRECT, loginUri: null }),
    ).toEqual({ client_id: 'a-client' });
  });

  it('sends neither field in popup mode, leaving Google on its own default', () => {
    // Google's documented default is `popup`, and this is the assertion that keeps a future
    // edit from quietly pinning a desktop to a mode Google states for a phone.
    expect(
      googleInitializeConfig({ clientId: 'a-client', mode: GOOGLE_UX_MODE_POPUP, loginUri }),
    ).toEqual({ client_id: 'a-client' });
  });
});

describe('the address Google posts the credential to', () => {
  it('is the landing route on the deployment own public address', () => {
    expect(googleRedirectLoginUri('https://pos.example.com')).toBe(
      `https://pos.example.com${GOOGLE_REDIRECT_LOGIN_PATH}`,
    );
  });

  it('joins the path once, whatever trailing slashes the configured base carries', () => {
    // Google compares this against the registered redirect URI as a string, so a doubled
    // slash is a `redirect_uri_mismatch` on Google's own error page.
    expect(googleRedirectLoginUri('https://pos.example.com/')).toBe(
      `https://pos.example.com${GOOGLE_REDIRECT_LOGIN_PATH}`,
    );
    expect(googleRedirectLoginUri('https://pos.example.com//')).toBe(
      `https://pos.example.com${GOOGLE_REDIRECT_LOGIN_PATH}`,
    );
  });

  it('names the same route the landing is served at', () => {
    expect(GOOGLE_REDIRECT_LOGIN_PATH).toBe('/api/v1/auth/google/redirect');
  });

  it('builds the front door URL a landing redirects to', () => {
    expect(googleLandingUrl('https://pos.example.com/', 'new')).toBe(
      'https://pos.example.com/login?google=new',
    );
    expect(googleLandingUrl('https://pos.example.com', 'inactive')).toBe(
      'https://pos.example.com/login?google=inactive',
    );
  });
});

describe('what an arrival at the redirect landing earns', () => {
  it('sends a Google account nobody holds to the phone step, writing nothing', () => {
    // A subject with no row gets no row written here: the phone is the identity (ADR 0020
    // §2), and the screen that collects it is the only place a first sign-in may be
    // anchored.
    expect(planGoogleArrival({ customer: null })).toEqual({ kind: 'needs-phone' });
  });

  it('signs a known customer in, on the member home', () => {
    expect(planGoogleArrival({ customer: { isActive: true } })).toEqual({
      kind: 'sign-in',
      redirectTo: '/shop/products',
    });
  });

  it('refuses a closed account before it can start a session', () => {
    expect(planGoogleArrival({ customer: { isActive: false } })).toEqual({
      kind: 'refused',
      reason: 'inactive',
    });
  });
});
