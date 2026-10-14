// Seam under test: the second consent (ADR 0032 §5) — the pure state machine, and the
// persistence that must not touch anything else.
//
// Two properties are the reason this file exists. The first is that "never asked" and
// "said no" are different answers, which a boolean cannot carry: the card offers the choice
// in one case and shows a person who declined in the other. The second is that withdrawing a
// promotion moves *nothing else* — not the binding, not the order notifications — because
// that separation is the entire point of a second consent. Neither is checkable without
// PostgreSQL, and the state machine is checkable without it.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db';
import { lineBindingForUser, setLinePromotionConsent, unbindLineFromCustomer } from '@/lib/line-identity';
import {
  LINE_PROMO_CONSENT_VERSION,
  canReceivePromotions,
  linePromoActionLabel,
  linePromoBlockSentence,
  linePromoConsentBlock,
  linePromoConsentSentence,
  linePromoConsentState,
  type LinePromoBlock,
} from '@/lib/line-promo-consent';

import { resetDatabase, seedPeople } from './helpers/test-db';

describe('which timestamp wins', () => {
  const T1 = new Date('2026-10-01T10:00:00+07:00');
  const T2 = new Date('2026-10-02T10:00:00+07:00');

  it('is never_asked with neither timestamp', () => {
    expect(linePromoConsentState({ consentAt: null, withdrawnAt: null })).toBe('never_asked');
  });

  it('is consented with only an agreement, and withdrawn with only a withdrawal', () => {
    expect(linePromoConsentState({ consentAt: T1, withdrawnAt: null })).toBe('consented');
    expect(linePromoConsentState({ consentAt: null, withdrawnAt: T1 })).toBe('withdrawn');
  });

  it('is the later one when both are set', () => {
    expect(linePromoConsentState({ consentAt: T1, withdrawnAt: T2 })).toBe('withdrawn');
    expect(linePromoConsentState({ consentAt: T2, withdrawnAt: T1 })).toBe('consented');
  });

  it('resolves a tie to withdrawn, because silence is the safe direction', () => {
    // Not reachable through the routes (one update writes one timestamp), and resolved
    // anyway rather than left to `>=` happening to be written the right way round.
    expect(linePromoConsentState({ consentAt: T1, withdrawnAt: T1 })).toBe('withdrawn');
  });

  it('is consented again after a withdrawal and a fresh agreement', () => {
    // The act the customer actually performs: withdraw on the 1st, change their mind on the
    // 2nd. Both timestamps stay on the row — the withdrawal is an act, not a deletion.
    expect(linePromoConsentState({ consentAt: T2, withdrawnAt: T1 })).toBe('consented');
  });
});

describe('who a campaign may reach', () => {
  const base = {
    channel: 'line' as const,
    customerLineSubject: 'Ucustomer',
    consentAt: new Date('2026-10-01T10:00:00+07:00'),
    withdrawnAt: null,
    isFriend: true,
  };

  it('reaches a consented friend', () => {
    expect(linePromoConsentBlock(base)).toBeNull();
    expect(canReceivePromotions(base)).toBe(true);
  });

  it('names the first reason in the order the screen says them', () => {
    // No LINE channel at all outranks every fact about this customer: nothing can be sent
    // on a door the shop has not configured.
    expect(linePromoConsentBlock({ ...base, channel: null })).toBe('channel_not_line');
    expect(linePromoConsentBlock({ ...base, channel: 'webhook' })).toBe('channel_not_line');
    // No address outranks no consent: there is no address for a consent to attach to.
    expect(linePromoConsentBlock({ ...base, customerLineSubject: null })).toBe('not_bound');
    expect(linePromoConsentBlock({ ...base, consentAt: null, withdrawnAt: null })).toBe(
      'never_asked',
    );
    expect(linePromoConsentBlock({ ...base, withdrawnAt: new Date('2026-10-02T10:00:00+07:00') })).toBe(
      'withdrawn',
    );
    expect(linePromoConsentBlock({ ...base, isFriend: false })).toBe('not_a_friend');
  });

  it('excludes a customer who withdrew even though they are a friend', () => {
    expect(
      canReceivePromotions({ ...base, withdrawnAt: new Date('2026-10-02T10:00:00+07:00') }),
    ).toBe(false);
  });

  it('gives every reason its own sentence', () => {
    // A reason the counter cannot read is a reason it cannot act on, so the copy is part
    // of the contract rather than of the component.
    const blocks: LinePromoBlock[] = [
      'channel_not_line',
      'not_bound',
      'never_asked',
      'withdrawn',
      'not_a_friend',
    ];
    const sentences = blocks.map(linePromoBlockSentence);
    expect(new Set(sentences).size).toBe(blocks.length);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(10);
    }
  });

  it('says something different about each state, and names the act to take', () => {
    const states = ['never_asked', 'consented', 'withdrawn'] as const;
    expect(new Set(states.map(linePromoConsentSentence)).size).toBe(states.length);
    expect(new Set(states.map(linePromoActionLabel)).size).toBe(states.length);
  });
});

describe('recording it', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedPeople();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function boundMember(): Promise<string> {
    const member = await prisma.users.findFirstOrThrow({ where: { role: 'member' } });
    await prisma.users.update({
      where: { id: member.id },
      data: { line_subject: 'Ucustomer', line_consent_at: new Date('2026-10-01T10:00:00+07:00') },
    });
    return member.id;
  }

  it('leaves the promotion timestamps null when an account is merely bound', async () => {
    // The rule the whole ticket turns on: binding an account is not agreement to be sent
    // promotions, so a fresh binding leaves all three columns untouched.
    const userId = await boundMember();
    const binding = await lineBindingForUser(userId);

    expect(binding).toMatchObject({
      lineSubject: 'Ucustomer',
      promoConsentAt: null,
      promoWithdrawnAt: null,
      promoConsentVersion: null,
    });
  });

  it('keeps both timestamps, and the later one wins after a change of mind', async () => {
    const userId = await boundMember();

    const first = await setLinePromotionConsent({
      userId,
      consent: true,
      consentVersion: LINE_PROMO_CONSENT_VERSION,
    });
    expect(first.state).toBe('consented');

    const second = await setLinePromotionConsent({
      userId,
      consent: false,
      consentVersion: LINE_PROMO_CONSENT_VERSION,
    });
    expect(second.state).toBe('withdrawn');

    const third = await setLinePromotionConsent({
      userId,
      consent: true,
      consentVersion: LINE_PROMO_CONSENT_VERSION,
    });
    expect(third.state).toBe('consented');

    const row = await prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { line_promo_consent_at: true, line_promo_withdrawn_at: true },
    });
    // Two acts, both on the row: the withdrawal is not erased by the later agreement.
    expect(row.line_promo_consent_at).not.toBeNull();
    expect(row.line_promo_withdrawn_at).not.toBeNull();
    expect(row.line_promo_consent_at!.getTime()).toBeGreaterThan(
      row.line_promo_withdrawn_at!.getTime(),
    );
  });

  it('does not touch the binding or the order notifications when a promotion is withdrawn', async () => {
    const userId = await boundMember();
    await setLinePromotionConsent({ userId, consent: true, consentVersion: LINE_PROMO_CONSENT_VERSION });
    const before = await prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { line_subject: true, line_consent_at: true, line_consent_version: true },
    });

    await setLinePromotionConsent({
      userId,
      consent: false,
      consentVersion: LINE_PROMO_CONSENT_VERSION,
    });

    const after = await prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { line_subject: true, line_consent_at: true, line_consent_version: true },
    });
    expect(after).toEqual(before);
  });

  it('records a withdrawal from an unbound customer but refuses a fresh yes', async () => {
    // Nothing is ever demanded to stop being reachable (ADR 0030 §2); the other direction
    // needs an address, because consent without one is dead weight.
    const member = await prisma.users.findFirstOrThrow({ where: { role: 'member' } });

    await expect(
      setLinePromotionConsent({
        userId: member.id,
        consent: true,
        consentVersion: LINE_PROMO_CONSENT_VERSION,
      }),
    ).rejects.toThrow(/ผูกบัญชี LINE/);

    await expect(
      setLinePromotionConsent({
        userId: member.id,
        consent: false,
        consentVersion: LINE_PROMO_CONSENT_VERSION,
      }),
    ).resolves.toMatchObject({ state: 'withdrawn' });
  });

  it('refuses a staff account, like every other LINE act', async () => {
    const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin' } });
    await expect(
      setLinePromotionConsent({
        userId: admin.id,
        consent: false,
        consentVersion: LINE_PROMO_CONSENT_VERSION,
      }),
    ).rejects.toThrow(/บัญชีลูกค้า/);
  });

  it('clears the promotion consent when the binding goes, because the address went', async () => {
    const userId = await boundMember();
    await setLinePromotionConsent({ userId, consent: true, consentVersion: LINE_PROMO_CONSENT_VERSION });

    await unbindLineFromCustomer(userId);

    const row = await prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: {
        line_subject: true,
        line_consent_at: true,
        line_promo_consent_at: true,
        line_promo_withdrawn_at: true,
        line_promo_consent_version: true,
      },
    });
    expect(row).toEqual({
      line_subject: null,
      line_consent_at: null,
      line_promo_consent_at: null,
      line_promo_withdrawn_at: null,
      line_promo_consent_version: null,
    });
  });
});
