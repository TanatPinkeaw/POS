// Seam under test: the arithmetic a shop is asked to trust before it presses send
// (ADR 0032 §6) — who is eligible, how the list splits, what it costs, and what LINE says is
// left of the month.
//
// Pure, except the quota reader, which takes a stub `fetch` the way the acceptance run stands
// a stub in LINE's place: the numbers the composer shows come from LINE's own two endpoints,
// and the interesting cases (a 429, an unreadable body, no token at all, no limit) are
// failures, not happy paths.
import { describe, expect, it } from 'vitest';

import {
  MAX_RECIPIENTS_PER_REQUEST,
  campaignAffordable,
  campaignAuditPreview,
  campaignCostMessages,
  campaignStatusFromBatches,
  eligibleCampaignRecipients,
  planCampaignBatches,
  type CampaignCandidate,
} from '@/lib/line-campaign-rules';
import { LineQuotaUnavailableError, lineApiBaseUrl, readLineQuota } from '@/lib/line-quota';

const CONSENTED = new Date('2026-10-01T10:00:00+07:00');

/** A candidate who is in, unless a test says otherwise. */
function candidate(subject: string, overrides: Partial<CampaignCandidate> = {}): CampaignCandidate {
  return {
    subject,
    channel: 'line',
    customerLineSubject: subject,
    consentAt: CONSENTED,
    withdrawnAt: null,
    isFriend: true,
    ...overrides,
  };
}

describe('who a campaign reaches', () => {
  it('is the consented friends, and nobody else', () => {
    const audience = eligibleCampaignRecipients([
      candidate('Uin1'),
      candidate('Uneverasked', { consentAt: null }),
      candidate('Uwithdrawn', { withdrawnAt: new Date('2026-10-05T10:00:00+07:00') }),
      candidate('Ustranger', { isFriend: false }),
      candidate('Uin2'),
    ]);

    expect(audience.recipients).toEqual(['Uin1', 'Uin2']);
    expect(audience.excluded.map((entry) => entry.reason)).toEqual([
      'never_asked',
      'withdrawn',
      'not_a_friend',
    ]);
  });

  it('keeps the order it was given, because the customer list has one a person can see', () => {
    const audience = eligibleCampaignRecipients([candidate('Ub'), candidate('Ua'), candidate('Uc')]);
    expect(audience.recipients).toEqual(['Ub', 'Ua', 'Uc']);
  });

  it('excludes everybody when LINE is not the configured channel', () => {
    const audience = eligibleCampaignRecipients([
      candidate('Ua', { channel: 'webhook' }),
      candidate('Ub', { channel: null }),
    ]);
    expect(audience.recipients).toEqual([]);
    expect(audience.excluded.map((entry) => entry.reason)).toEqual([
      'channel_not_line',
      'channel_not_line',
    ]);
  });

  it('is empty rather than an error when there is nobody', () => {
    expect(eligibleCampaignRecipients([])).toEqual({ recipients: [], excluded: [] });
  });
});

describe('how the list splits into requests', () => {
  const subjects = (count: number) => Array.from({ length: count }, (_, index) => `U${index}`);

  it('never exceeds the documented cap of 500 per request', () => {
    const batches = planCampaignBatches(subjects(1201));
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 201]);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_RECIPIENTS_PER_REQUEST);
    }
  });

  it('is exactly one request at the boundary, and two just past it', () => {
    expect(planCampaignBatches(subjects(500))).toHaveLength(1);
    expect(planCampaignBatches(subjects(501))).toHaveLength(2);
  });

  it('has no empty tail, and none at all when there is nobody', () => {
    // `ceil(1250 / 500)` is 3 and the arithmetic would happily emit a fourth, empty batch —
    // which LINE would refuse (`messages` must not be empty) and the worker would retry.
    expect(planCampaignBatches(subjects(1250))).toHaveLength(3);
    expect(planCampaignBatches([])).toEqual([]);
  });

  it('keeps the order it was given, so a stored batch matches a recomputed one', () => {
    const batches = planCampaignBatches(['Uc', 'Ua', 'Ub'], 2);
    expect(batches).toEqual([['Uc', 'Ua'], ['Ub']]);
  });
});

describe('what a campaign costs', () => {
  it('is one message per recipient', () => {
    expect(campaignCostMessages(250)).toBe(250);
    expect(campaignCostMessages(0)).toBe(0);
  });

  it('is affordable exactly up to the month remainder', () => {
    // Thailand's free plan is 300 messages a month, and counting is per recipient.
    expect(campaignAffordable(300, 300)).toBe(true);
    expect(campaignAffordable(299, 300)).toBe(false);
    expect(campaignAffordable(0, 0)).toBe(true);
  });

  it('treats "no limit" as affordable rather than as unknown', () => {
    // `type: 'none'` is LINE saying there is no cap; a number that could not be read never
    // reaches this function, because the caller refuses the send instead of guessing.
    expect(campaignAffordable(null, 10_000)).toBe(true);
  });
});

describe('what a campaign batches add up to', () => {
  it('is pending before anything was tried', () => {
    expect(campaignStatusFromBatches([])).toBe('pending');
    expect(campaignStatusFromBatches(['pending', 'pending'])).toBe('pending');
  });

  it('is sent when every batch went', () => {
    expect(campaignStatusFromBatches(['sent', 'sent'])).toBe('sent');
  });

  it('is partial when some went — the state a shop must be able to see', () => {
    expect(campaignStatusFromBatches(['sent', 'failed'])).toBe('partial');
    expect(campaignStatusFromBatches(['failed', 'sent', 'pending'])).toBe('partial');
  });

  it('is failed when none went', () => {
    expect(campaignStatusFromBatches(['failed'])).toBe('failed');
    expect(campaignStatusFromBatches(['failed', 'failed'])).toBe('failed');
  });
});

describe('what the audit row says a campaign was', () => {
  it('is the first words, flattened, and marked when it was cut', () => {
    expect(campaignAuditPreview('ลด 50%   ทั้งร้าน')).toBe('ลด 50% ทั้งร้าน');
    const long = campaignAuditPreview('ก'.repeat(200));
    expect(long.length).toBe(61);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('asking LINE how much of the month is left', () => {
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /** A stub LINE that answers the two endpoints, and records what was asked of it. */
  function stub(line: { quota: unknown; consumption: unknown; quotaStatus?: number }) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href.endsWith('/quota/consumption')) {
        return response(line.consumption);
      }
      return response(line.quota, line.quotaStatus ?? 200);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  const env = {
    NOTIFY_LINE_TOKEN: 'channel-token',
    LINE_API_BASE_URL: 'https://line-stub.test',
  };

  it('reads both endpoints and subtracts', async () => {
    const { fetchImpl, calls } = stub({
      quota: { type: 'limited', value: 300 },
      consumption: { totalUsage: 47 },
    });

    expect(await readLineQuota(env, fetchImpl)).toEqual({
      limited: true,
      limit: 300,
      consumed: 47,
      remaining: 253,
    });
    expect(calls.sort()).toEqual([
      'https://line-stub.test/v2/bot/message/quota',
      'https://line-stub.test/v2/bot/message/quota/consumption',
    ]);
  });

  it('reports no limit when LINE says there is none', async () => {
    const { fetchImpl } = stub({ quota: { type: 'none' }, consumption: { totalUsage: 900 } });
    expect(await readLineQuota(env, fetchImpl)).toMatchObject({
      limited: false,
      limit: null,
      consumed: 900,
      remaining: null,
    });
  });

  it('never reports a negative remainder', async () => {
    // A plan that changed mid-month leaves consumption past the cap; a negative number reads
    // as credit the shop does not have.
    const { fetchImpl } = stub({
      quota: { type: 'limited', value: 300 },
      consumption: { totalUsage: 512 },
    });
    expect((await readLineQuota(env, fetchImpl))?.remaining).toBe(0);
  });

  it('is null when the shop has no channel token, without asking anybody', async () => {
    const { fetchImpl, calls } = stub({ quota: {}, consumption: {} });
    expect(await readLineQuota({}, fetchImpl)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('throws with the channel own words when it refuses the question', async () => {
    // 429 is the failure the ADR says the composer cannot predict: LINE's own documentation
    // warns a send can be refused with the monthly-limit error while the console still shows
    // messages remaining.
    const { fetchImpl } = stub({
      quota: { message: 'You have reached your monthly limit.' },
      consumption: { totalUsage: 0 },
      quotaStatus: 429,
    });

    await expect(readLineQuota(env, fetchImpl)).rejects.toBeInstanceOf(LineQuotaUnavailableError);
    await expect(readLineQuota(env, fetchImpl)).rejects.toThrow(/LINE ไม่ตอบคำถาม/);
  });

  it('refuses to render a number it cannot read', async () => {
    const { fetchImpl } = stub({ quota: { type: 'limited' }, consumption: { totalUsage: 3 } });
    await expect(readLineQuota(env, fetchImpl)).rejects.toThrow(/อ่านโควตา/);
  });

  it('turns an unreachable host into a sentence, not a stack trace', async () => {
    const failing = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    await expect(readLineQuota(env, failing)).rejects.toThrow(/ติดต่อ LINE ไม่ได้/);
  });

  it('uses the LINE API host unless the deployment says otherwise', () => {
    // One place builds the address, so the acceptance run's stub is the only thing that
    // moves it, and `.env.example` warns what setting it means.
    expect(lineApiBaseUrl({})).toBe('https://api.line.me');
    expect(lineApiBaseUrl({ LINE_API_BASE_URL: 'https://line-stub.test/' })).toBe(
      'https://line-stub.test',
    );
  });
});
