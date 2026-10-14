/**
 * The operator's registration check, decided by `src/lib/google-registration.ts`.
 *
 * The two encoded samples below are **real captures** from Google, taken against the shop's
 * own OAuth client on 2026-10-12 while diagnosing the customer's `redirect_uri_mismatch`
 * page — not invented fixtures. That is deliberate: the failure this module reads was
 * mistaken for a code bug for a round because the evidence was a photograph, and a test
 * written from the same memory would have been no better.
 */
import { describe, expect, it } from 'vitest';

import {
  googleRegistrationProbeUrl,
  readGoogleRegistrationVerdict,
} from '@/lib/google-registration';

/** `authError` off Google's error page for an address the client has never been told about. */
const MISMATCH_AUTH_ERROR = 'ChVyZWRpcmVjdF91cmlfbWlzbWF0Y2g';

/** `authError` for a host Google refuses outright — the shape a bogus domain produced. */
const INVALID_REQUEST_AUTH_ERROR = 'Cg9pbnZhbGlkX3JlcXVlc3QS';

const errorUrl = (authError: string): string =>
  `https://accounts.google.com/signin/oauth/error?authError=${authError}&flowName=GeneralOAuthFlow`;

describe('the request that asks Google whether an address is registered', () => {
  it('carries the client, the address and nothing that starts a sign-in', () => {
    const url = new URL(
      googleRegistrationProbeUrl({
        clientId: '1005508520232-fknc0sm64lee45d6uqkk8k4o22h3ddn5.apps.googleusercontent.com',
        redirectUri: 'https://pos.example.com/api/v1/auth/google/redirect',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(
      '1005508520232-fknc0sm64lee45d6uqkk8k4o22h3ddn5.apps.googleusercontent.com',
    );
    // Character for character, because that is how Google compares it against the console.
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://pos.example.com/api/v1/auth/google/redirect',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    // Nothing that could sign anybody in: no prompt, no login hint, no state to forget.
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.searchParams.has('login_hint')).toBe(false);
  });
});

describe("reading Google's answer", () => {
  it('is not-registered when Google says the redirect URI does not match', () => {
    // The customer's screenshot, as this deployment's client answers it.
    expect(
      readGoogleRegistrationVerdict({
        finalUrl: errorUrl(MISMATCH_AUTH_ERROR),
      }),
    ).toEqual({ kind: 'not-registered' });
  });

  it('names the other refusals rather than flattening them into one', () => {
    // `invalid_request` is a different mistake: Google will not accept the address at all
    // (a host that does not exist, or a scheme it does not allow), so the console entry is
    // not the fix. Reading these as the same verdict is what sends an operator to edit the
    // wrong thing.
    expect(readGoogleRegistrationVerdict({ finalUrl: errorUrl(INVALID_REQUEST_AUTH_ERROR) })).toEqual(
      { kind: 'refused', code: 'invalid_request' },
    );
    expect(
      readGoogleRegistrationVerdict({
        finalUrl: errorUrl(Buffer.from('\n\x11invalid_client', 'latin1').toString('base64')),
      }),
    ).toEqual({ kind: 'refused', code: 'invalid_client' });
  });

  it('is registered when Google walks past validation to its own sign-in screen', () => {
    // Google shows this only after it has accepted the redirect URI: the pass is the absence
    // of the error page, which is the whole reason that absence has to be narrow.
    expect(
      readGoogleRegistrationVerdict({
        finalUrl: 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2F…',
      }),
    ).toEqual({ kind: 'registered' });
  });

  it('refuses to call anything else a pass', () => {
    // A captcha, a page from a host that is not Google, and a URL that is not a URL: all
    // three used to read as "no error page, so fine" in a check made of eyeballs.
    expect(
      readGoogleRegistrationVerdict({ finalUrl: 'https://accounts.google.com/sorry/index' }),
    ).toEqual({ kind: 'unmeasured' });
    expect(
      readGoogleRegistrationVerdict({ finalUrl: 'https://example.test/signed-in' }),
    ).toEqual({ kind: 'unmeasured' });
    expect(readGoogleRegistrationVerdict({ finalUrl: 'not a url' })).toEqual({
      kind: 'unmeasured',
    });
  });

  it('refuses to read a refusal at an unfamiliar path as a pass', () => {
    /*
     * The one path Google has been seen parking refusals on is `/signin/oauth/error`, and a
     * second one is not hypothetical enough to leave open: "a Google page whose path mentions
     * signin" would match it and report *registered*, so the run would go green while the
     * customer kept losing the door on their phone. An error this function has not seen is
     * unmeasured, which is the module's own rule applied to its own discriminator.
     */
    expect(
      readGoogleRegistrationVerdict({
        finalUrl: `https://accounts.google.com/signin/v2/error?authError=${MISMATCH_AUTH_ERROR}`,
      }),
    ).toEqual({ kind: 'unmeasured' });
  });

  it('falls back to the code printed on the page when the query string cannot be read', () => {
    expect(
      readGoogleRegistrationVerdict({
        finalUrl: 'https://accounts.google.com/signin/oauth/error',
        body: '<p>ข้อผิดพลาด 400: redirect_uri_mismatch</p>',
      }),
    ).toEqual({ kind: 'not-registered' });
  });

  it('is unmeasured when the error page carries no code it recognises', () => {
    expect(
      readGoogleRegistrationVerdict({
        finalUrl: errorUrl(Buffer.from('\n\x07unknown', 'latin1').toString('base64')),
        body: '<html>something new</html>',
      }),
    ).toEqual({ kind: 'unmeasured' });
  });
});
