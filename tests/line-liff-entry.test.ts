// Seam under test: the in-LINE entry's decision (ADR 0032 §1).
//
// Pure, because the SDK cannot be in a test — it talks to LINE's servers. What is pinned
// here is what `/line` decides from the facts it is handed: configuration beats every other
// answer, an honest failure beats "open this in the app", a session the server granted ends
// the entry, and a LINE account nobody holds renders the phone step *in this page* rather
// than bouncing the customer out to a web form (ADR 0032 §1).
import { describe, expect, it } from 'vitest';

import {
  LIFF_ENTRY_PATH,
  LIFF_SIGN_IN_ENDPOINT,
  liffEntryNotice,
  liffEntryUrl,
  liffSignedInPath,
  planLiffEntry,
  readLiffId,
} from '@/lib/line-liff-entry';
import { planLineCustomerReadyMessage } from '@/lib/line-notify';
import { MAX_TEXT_LENGTH } from '@/lib/notify-message';

describe('the LIFF app id this deployment has', () => {
  it('is configuration, read trimmed', () => {
    expect(readLiffId({ LINE_LIFF_ID: '2000000000-abcdefgh' })).toBe('2000000000-abcdefgh');
    expect(readLiffId({ LINE_LIFF_ID: '  2000000000-abcdefgh  ' })).toBe('2000000000-abcdefgh');
  });

  it('is nothing when unset or blank', () => {
    expect(readLiffId({})).toBeNull();
    expect(readLiffId({ LINE_LIFF_ID: '   ' })).toBeNull();
  });
});

describe('the address a message carries', () => {
  it('is LINE short link plus the id, built in one place', () => {
    expect(liffEntryUrl({ LINE_LIFF_ID: '2000000000-abcdefgh' })).toBe(
      'https://liff.line.me/2000000000-abcdefgh',
    );
  });

  it('is null when no LIFF app is configured, so the message stays as it is', () => {
    // The planner appends this to a sentence a customer already reads. A link built from
    // nothing would be `https://liff.line.me/`, which opens LINE with no app in it — worse
    // than the message the shop sends today.
    expect(liffEntryUrl({})).toBeNull();
  });
});

describe(`what the entry decides`, () => {
  const inLine = { configured: true, inLineClient: true };

  it('says it is not set up when there is no LIFF app, whatever else is true', () => {
    // A door that is not a door. Without an id there cannot have been a link to tap, so
    // every other fact is noise — including a failure, which never happened.
    expect(planLiffEntry({ configured: false, inLineClient: true, failure: 'sdk' })).toEqual({
      stage: 'unconfigured',
    });
    expect(
      planLiffEntry({ configured: false, inLineClient: false, redirectTo: '/shop/products' }),
    ).toEqual({ stage: 'unconfigured' });
  });

  it('signs in inside LINE when there is nothing else to know', () => {
    expect(planLiffEntry(inLine)).toEqual({ stage: 'sign_in' });
  });

  it('names the app when the browser is not inside LINE', () => {
    expect(planLiffEntry({ configured: true, inLineClient: false })).toEqual({
      stage: 'open_in_line',
    });
  });

  it('renders the phone step for a LINE account the shop does not hold', () => {
    expect(planLiffEntry({ ...inLine, needsPhone: true, displayName: 'สมชาย' })).toEqual({
      stage: 'claim',
      displayName: 'สมชาย',
    });
    // A token with no profile scope carries no name, and that is still a claim: one column
    // must not mean two things (`inbound_payments.amount`'s lesson).
    expect(planLiffEntry({ ...inLine, needsPhone: true, displayName: null })).toEqual({
      stage: 'claim',
      displayName: null,
    });
    expect(planLiffEntry(inLine)).toEqual({ stage: 'sign_in' });
  });

  it('is finished once the server granted a session, wherever the browser is', () => {
    // The one fact that ends the entry: the customer has what this page exists to give.
    expect(planLiffEntry({ ...inLine, redirectTo: '/shop/products' })).toEqual({
      stage: 'signed_in',
      redirectTo: '/shop/products',
    });
  });

  it('reports an honest failure rather than sending the customer to the app', () => {
    expect(planLiffEntry({ ...inLine, failure: 'token' })).toEqual({
      stage: 'failed',
      reason: 'token',
    });
    // Even outside LINE: "an error happened" is worth more than "open this in the app",
    // because the customer may well have arrived from the app.
    expect(planLiffEntry({ configured: true, inLineClient: false, failure: 'sdk' })).toEqual({
      stage: 'failed',
      reason: 'sdk',
    });
  });
});

describe('the sentence for each stage', () => {
  it('says something true for every stage that is a saying', () => {
    const stages = [
      planLiffEntry({ configured: false, inLineClient: false }),
      planLiffEntry({ configured: true, inLineClient: false }),
      planLiffEntry({ configured: true, inLineClient: true, failure: 'sdk' }),
      planLiffEntry({ configured: true, inLineClient: true, failure: 'token' }),
      planLiffEntry({ configured: true, inLineClient: true, failure: 'refused' }),
    ];

    for (const stage of stages) {
      const notice = liffEntryNotice(stage);
      expect(notice, `no sentence for ${JSON.stringify(stage)}`).not.toBeNull();
      expect(notice?.body.length ?? 0).toBeGreaterThan(20);
    }
  });

  it('says nothing for the stages that are a doing', () => {
    // The button, the phone step and the redirect need no message; inventing one is how a
    // screen ends up telling a customer about something that did not happen.
    expect(liffEntryNotice(planLiffEntry({ configured: true, inLineClient: true }))).toBeNull();
    expect(
      liffEntryNotice(planLiffEntry({ configured: true, inLineClient: true, needsPhone: true })),
    ).toBeNull();
    expect(
      liffEntryNotice(
        planLiffEntry({ configured: true, inLineClient: true, redirectTo: liffSignedInPath() }),
      ),
    ).toBeNull();
  });

  it('refuses to invent a sentence for an unknown reason by construction', () => {
    // The failure branch switches exhaustively over the union, so a fourth reason cannot be
    // added to `LiffEntryFailure` without a sentence appearing in this list.
    const reasons = ['sdk', 'token', 'refused'] as const;
    const bodies = reasons.map(
      (reason) => liffEntryNotice({ stage: 'failed', reason })?.body ?? '',
    );
    expect(new Set(bodies).size).toBe(reasons.length);
  });
});

describe('the collection message a customer already reads', () => {
  /** The message `markOrderReady` plans, with the LINE facts that let it go out. */
  const readyMessage = (env: Record<string, string | undefined>) =>
    planLineCustomerReadyMessage(
      {
        orderId: '11111111-2222-3333-4444-555555555555',
        orderNumber: 'PO-20261006-000001',
        pickupPin: '7391',
        holdUntil: new Date('2026-10-06T18:00:00+07:00'),
        channel: 'line',
        staffTo: 'Cgroup-of-staff',
        customerLineSubject: 'Ucustomer',
        consentAt: new Date('2026-10-01T09:00:00+07:00'),
        isFriend: true,
      },
      env,
    );

  it('carries the one-tap link when the shop has a LIFF app', () => {
    const plan = readyMessage({ LINE_LIFF_ID: '2000000000-abcdefgh' });
    expect(plan?.text).toContain('https://liff.line.me/2000000000-abcdefgh');
    expect(plan?.text.endsWith('https://liff.line.me/2000000000-abcdefgh')).toBe(true);
  });

  it('is exactly the sentence it was before when the shop has none', () => {
    // A shop that never set up a LIFF app must not start sending a link to nowhere: the
    // planner appends nothing rather than `https://liff.line.me/`, which opens LINE with no
    // app in it.
    const plan = readyMessage({});
    expect(plan?.text).not.toContain('liff.line.me');
    expect(plan?.text).toContain('7391');
  });

  it('stays inside the length tripwire with the link added', () => {
    // `MAX_TEXT_LENGTH` is the SMS channel's per-message tripwire, and this is the first
    // time the LINE message has grown a URL. It is a tripwire, not a target: the assertion
    // is that the sentence plus a real link still fits under it.
    const plan = readyMessage({ LINE_LIFF_ID: '2000000000-abcdefgh' });
    expect((plan?.text ?? '').length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  });
});

describe('the addresses the entry uses', () => {
  it('is the route the LIFF app points at, and the door it posts to', () => {
    expect(LIFF_ENTRY_PATH).toBe('/line');
    expect(LIFF_SIGN_IN_ENDPOINT).toBe('/api/v1/auth/line');
  });

  it('lands a customer on the member home the session earns', () => {
    expect(liffSignedInPath()).toBe('/shop/products');
  });
});
