// Seam under test: what a press of a LINE door *means* (ADR 0030 §1).
//
// Found on the live deployment: the LINE button on `/login` linked straight to
// `/api/v1/auth/line/authorize`, which mints a **binding** state, and the callback
// refuses anyone without a signed-in member session. So an anonymous customer
// walked to LINE, consented, came back, and was sent to `/shop/account` — which
// bounces them to `/login`. The button promised a sign-in and delivered a loop.
//
// The two decisions that used to be scattered across the route files are here as
// pure functions: which intent a press carries, and what an arrival from LINE
// earns. The callback is then a thin adapter over them, which is what makes the
// loop a test case rather than a field report.
import { describe, expect, it } from 'vitest';

import {
  LINE_LINK_PURPOSE,
  LINE_SIGNIN_PURPOSE,
  intentForPurpose,
  lineIntentFor,
  lineLandingUrl,
  planLineArrival,
  purposeForIntent,
} from '@/lib/line-door';

const MEMBER = { role: 'member', isActive: true };
const INACTIVE_MEMBER = { role: 'member', isActive: false };
const EMPLOYEE = { role: 'employee', isActive: true };

describe('the intent a LINE door press carries', () => {
  it('signs in when there is no session, which is the loop this exists to close', () => {
    // The reported bug in one line: no session, no explicit intent — and the old
    // link resolved that to the *binding* flow, which requires the session it
    // does not have.
    expect(lineIntentFor({ requested: null, hasSession: false })).toBe('sign-in');
    expect(lineIntentFor({ requested: undefined, hasSession: false })).toBe('sign-in');
    expect(lineIntentFor({ requested: '', hasSession: false })).toBe('sign-in');
  });

  it('binds when the browser is already signed in — the account page’s own act', () => {
    expect(lineIntentFor({ requested: null, hasSession: true })).toBe('bind');
  });

  it('lets an explicit request win either way, so one URL is never the other’s', () => {
    // The front door says `?intent=sign-in` out loud: a shared tablet with somebody
    // else's session must not turn a sign-in press into a write on that account.
    expect(lineIntentFor({ requested: 'sign-in', hasSession: true })).toBe('sign-in');
    expect(lineIntentFor({ requested: 'bind', hasSession: false })).toBe('bind');
  });

  it('ignores a value it does not know rather than refusing the press', () => {
    // A typo in a URL is not a person's mistake worth a dead end; the session
    // answers the question instead.
    expect(lineIntentFor({ requested: 'signin', hasSession: false })).toBe('sign-in');
    expect(lineIntentFor({ requested: 'link', hasSession: true })).toBe('bind');
  });
});

describe('what an arrival from LINE earns', () => {
  it('asks for a phone when the LINE account is nobody’s yet', () => {
    expect(planLineArrival({ intent: 'sign-in', session: null, customer: null })).toEqual({
      kind: 'needs-phone',
    });
  });

  it('signs a known LINE account in', () => {
    expect(planLineArrival({ intent: 'sign-in', session: null, customer: MEMBER })).toEqual({
      kind: 'sign-in',
      redirectTo: '/shop/products',
    });
  });

  it('refuses a deactivated account before it says anything about the role', () => {
    // A closed account is the more important fact; the role refusal is about who
    // the door is for.
    expect(planLineArrival({ intent: 'sign-in', session: null, customer: INACTIVE_MEMBER })).toEqual({
      kind: 'refused',
      reason: 'inactive',
    });
  });

  it('never signs a staff row in through the customer door', () => {
    expect(planLineArrival({ intent: 'sign-in', session: null, customer: EMPLOYEE })).toEqual({
      kind: 'refused',
      reason: 'staff',
    });
  });

  it('binds only when the browser holds a member session', () => {
    expect(
      planLineArrival({ intent: 'bind', session: { role: 'member' }, customer: MEMBER }),
    ).toEqual({ kind: 'bind' });
  });

  it('refuses a binding arrival with no member session, rather than inventing one', () => {
    // The second half of the loop: this is what the anonymous visitor actually
    // reached. It stays refused — an OTP is the way in without a session — but it
    // is now a refusal the front door can *say*, not a silent bounce.
    expect(planLineArrival({ intent: 'bind', session: null, customer: null })).toEqual({
      kind: 'refused',
      reason: 'binding-needs-session',
    });
    expect(
      planLineArrival({ intent: 'bind', session: { role: 'employee' }, customer: MEMBER }),
    ).toEqual({ kind: 'refused', reason: 'binding-needs-session' });
  });

  it('does not let a bind intent sign anyone in, whatever the subject is', () => {
    // One press, one promise: the account page binds, the front door signs in.
    expect(
      planLineArrival({ intent: 'bind', session: { role: 'member' }, customer: MEMBER }),
    ).toEqual({ kind: 'bind' });
  });
});

describe('the state token a door mints', () => {
  it('names its own purpose, one per intent', () => {
    expect(purposeForIntent('sign-in')).toBe(LINE_SIGNIN_PURPOSE);
    expect(purposeForIntent('bind')).toBe(LINE_LINK_PURPOSE);
    expect(LINE_LINK_PURPOSE).not.toBe(LINE_SIGNIN_PURPOSE);
  });

  it('reads a purpose back only for the two it minted', () => {
    expect(intentForPurpose(LINE_LINK_PURPOSE)).toBe('bind');
    expect(intentForPurpose(LINE_SIGNIN_PURPOSE)).toBe('sign-in');
    for (const junk of [undefined, null, '', 'line-link ', 'pickup', 'pos-session', 7]) {
      expect(intentForPurpose(junk), String(junk)).toBeNull();
    }
  });
});

describe('where a landing redirect points', () => {
  it('puts the account-page outcomes on the account page', () => {
    expect(lineLandingUrl('https://shop.test', { page: 'account', result: 'bound' })).toBe(
      'https://shop.test/shop/account?line=bound',
    );
    expect(lineLandingUrl('https://shop.test', { page: 'account', result: 'taken' })).toBe(
      'https://shop.test/shop/account?line=taken',
    );
  });

  it('puts every word the front door has to say on the front door', () => {
    // `/shop/account` needs a member session to render, so a refusal aimed there
    // is a refusal nobody reads — which is how the loop stayed silent.
    expect(lineLandingUrl('https://shop.test', { page: 'login', result: 'claim' })).toBe(
      'https://shop.test/login?line=claim',
    );
    expect(lineLandingUrl('https://shop.test', { page: 'login', result: 'session' })).toBe(
      'https://shop.test/login?line=session',
    );
  });
});
