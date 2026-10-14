// Seam under test: campaigns as rows (ADR 0032 §6–7), against a real database.
//
// Four properties, none of which a mock would test. The eligible set is the shop's own
// consent and friend rows and nobody else. A campaign and its batches and its audit row are
// written together, before anything is sent. The recipients stored on a batch are the ones
// the shop approved, not a recomputation. And a batch is claimed by exactly one worker —
// which is the whole of "at most once", since LINE's multicast takes no idempotency key.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db';
import { markLineFriend } from '@/lib/line-friends';
import {
  campaignBatches,
  claimCampaignBatch,
  createCampaign,
  dueCampaignBatches,
  listCampaigns,
  markCampaignBatchFailed,
  markCampaignBatchSent,
  planCampaign,
} from '@/lib/line-campaigns';

import { resetDatabase, seedPeople } from './helpers/test-db';

beforeEach(async () => {
  await resetDatabase();
  await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CONSENTED = new Date('2026-10-01T10:00:00+07:00');

/**
 * The channel LINE is configured on, for the tests that need an audience at all.
 *
 * `planCampaign` asks `readChannelConfig()` because a campaign cannot go out on a channel the
 * shop has not configured — the same rule the customer planner follows.
 */
function configureLine(): void {
  process.env.NOTIFY_CHANNEL = 'line';
  process.env.NOTIFY_LINE_TOKEN = 'channel-token';
}

afterEach(() => {
  delete process.env.NOTIFY_CHANNEL;
  delete process.env.NOTIFY_LINE_TOKEN;
});

/** A member row with a bound LINE account, optionally consented and a friend. */
async function seedCandidate(input: {
  phone: string;
  name: string;
  subject: string;
  consent?: boolean;
  withdrawn?: boolean;
  friend?: boolean;
}): Promise<string> {
  const member = await prisma.users.create({
    data: {
      phone: input.phone,
      password_hash: 'x',
      full_name: input.name,
      role: 'member',
      line_subject: input.subject,
      line_promo_consent_at: input.consent ? CONSENTED : null,
      line_promo_withdrawn_at: input.withdrawn ? new Date('2026-10-05T10:00:00+07:00') : null,
    },
    select: { id: true },
  });
  if (input.friend) {
    await markLineFriend(input.subject);
  }
  return member.id;
}

describe('the audience this deployment can reach', () => {
  it('is the consented friends, and every other customer is excluded with a reason', async () => {
    configureLine();
    await seedCandidate({ phone: '0900000010', name: 'ก', subject: 'Uin', consent: true, friend: true });
    await seedCandidate({ phone: '0900000011', name: 'ข', subject: 'Unever', friend: true });
    await seedCandidate({
      phone: '0900000012',
      name: 'ค',
      subject: 'Uwithdrawn',
      consent: true,
      withdrawn: true,
      friend: true,
    });
    await seedCandidate({ phone: '0900000013', name: 'ง', subject: 'Unofriend', consent: true });

    const plan = await planCampaign();

    expect(plan.recipients).toEqual(['Uin']);
    // Sorted here rather than asserted in the order the query returned: the list's order is
    // the customer list's (a Postgres collation over Thai names), and what this test is about
    // is which reason each of them got.
    const reasons = plan.excluded
      .map((entry) => `${entry.subject}:${entry.reason}`)
      .sort();
    expect(reasons).toEqual(['Unever:never_asked', 'Unofriend:not_a_friend', 'Uwithdrawn:withdrawn']);
    expect(plan.costMessages).toBe(1);
    expect(plan.batches).toEqual([['Uin']]);
  });

  it('excludes everybody when LINE is not the configured channel', async () => {
    // A campaign goes to customers' LINE, so the customer side needs the LINE channel
    // configured. A shop whose alerts go to a webhook has no LINE token to send with.
    await seedCandidate({ phone: '0900000010', name: 'ก', subject: 'Uin', consent: true, friend: true });

    const plan = await planCampaign();
    expect(plan.recipients).toEqual([]);
    expect(plan.excluded.map((entry) => entry.reason)).toEqual(['channel_not_line']);
  });

  it('is empty when there are no LINE customers at all', async () => {
    configureLine();
    expect(await planCampaign()).toMatchObject({ recipients: [], costMessages: 0, batches: [] });
  });
});

describe('writing a campaign', () => {
  const RECIPIENTS = ['U1', 'U2', 'U3'];

  it('writes the campaign, its batches, and the trail row together', async () => {
    const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin' } });

    const campaign = await createCampaign({
      body: '  ลด 50% ทั้งร้าน   เฉพาะสัปดาห์นี้  ',
      imageUrl: null,
      actorId: admin.id,
      recipientIds: RECIPIENTS,
      quotaRemainingAtSend: 253,
    });

    expect(campaign.status).toBe('pending');
    expect(campaign.recipientCount).toBe(3);
    // Trimmed on the way in: a campaign is one message, and leading space is not content.
    expect(campaign.body).toBe('ลด 50% ทั้งร้าน   เฉพาะสัปดาห์นี้');

    const row = await prisma.line_campaigns.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row).toMatchObject({
      status: 'pending',
      recipient_count: 3,
      quota_remaining_at_send: 253,
      failure_reason: null,
    });

    const batches = await campaignBatches(campaign.id);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ batch_index: 0, status: 'pending' });
    expect(batches[0]?.recipient_ids).toEqual(RECIPIENTS);

    // The trail is written in the same transaction as the campaign (ADR 0007 decision 1).
    const trail = await prisma.audit_logs.findFirstOrThrow({
      where: { action: 'line_campaign_sent' },
    });
    expect(trail.actor_user_id).toBe(admin.id);
    expect(trail.target_id).toBe(campaign.id);
    // The preview is flattened: the trail is a dispatch record, and the campaign row is
    // where the message's own spacing lives.
    expect(trail.detail).toMatchObject({
      recipients: 3,
      batches: 1,
      preview: 'ลด 50% ทั้งร้าน เฉพาะสัปดาห์นี้',
    });
  });

  it('splits 1201 recipients into three batches of the documented size', async () => {
    const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin' } });
    const recipients = Array.from({ length: 1201 }, (_, index) => `U${index}`);

    const campaign = await createCampaign({
      body: 'โปรฯ',
      imageUrl: null,
      actorId: admin.id,
      recipientIds: recipients,
      quotaRemainingAtSend: null,
    });

    const batches = await campaignBatches(campaign.id);
    expect(batches.map((batch) => batch.recipient_ids.length)).toEqual([500, 500, 201]);
    expect(batches.map((batch) => batch.batch_index)).toEqual([0, 1, 2]);
  });

  it('refuses an empty message and an empty audience, each in Thai', async () => {
    const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin' } });

    await expect(
      createCampaign({
        body: '   ',
        imageUrl: null,
        actorId: admin.id,
        recipientIds: RECIPIENTS,
        quotaRemainingAtSend: null,
      }),
    ).rejects.toThrow(/เขียนข้อความก่อนส่ง/);

    await expect(
      createCampaign({
        body: 'โปรฯ',
        imageUrl: null,
        actorId: admin.id,
        recipientIds: [],
        quotaRemainingAtSend: null,
      }),
    ).rejects.toThrow(/ยังไม่มีลูกค้าที่รับโปรโมชันได้/);

    expect(await prisma.line_campaigns.count()).toBe(0);
  });

  it('lists what was sent, newest first, with who pressed send', async () => {
    const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin' } });
    await createCampaign({
      body: 'แรก',
      imageUrl: null,
      actorId: admin.id,
      recipientIds: ['U1'],
      quotaRemainingAtSend: 10,
    });
    await createCampaign({
      body: 'สอง',
      imageUrl: 'https://example.test/promo.png',
      actorId: admin.id,
      recipientIds: ['U1', 'U2'],
      quotaRemainingAtSend: 8,
    });

    const rows = await listCampaigns();
    expect(rows.map((row) => row.body)).toEqual(['สอง', 'แรก']);
    expect(rows[0]).toMatchObject({
      recipientCount: 2,
      imageUrl: 'https://example.test/promo.png',
      sentByName: admin.full_name,
    });
  });
});

describe('sending a campaign, at most once', () => {
  async function seedTwoBatchCampaign(): Promise<string> {
    const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin' } });
    const campaign = await createCampaign({
      body: 'โปรฯ',
      imageUrl: null,
      actorId: admin.id,
      recipientIds: ['U1', 'U2'],
      quotaRemainingAtSend: 300,
    });
    // Plan the batches by hand: the split is 500 per request, so the same campaign is used
    // for the two-batch behaviour by planning with a smaller cap.
    const [first] = await campaignBatches(campaign.id);
    expect(first?.recipient_ids).toEqual(['U1', 'U2']);
    return campaign.id;
  }

  it('lets exactly one claimer take a batch', async () => {
    const campaignId = await seedTwoBatchCampaign();
    const [batch] = await dueCampaignBatches();
    if (!batch) {
      throw new Error('no batch was due');
    }

    // Two workers read the same due list; one conditional UPDATE decides.
    expect(await claimCampaignBatch(batch.id)).toBe(true);
    expect(await claimCampaignBatch(batch.id)).toBe(false);

    // The batch is still pending — attempted, not sent — so a worker killed mid-request
    // leaves work that is visible rather than one that silently vanished.
    const rows = await campaignBatches(campaignId);
    expect(rows[0]?.status).toBe('pending');
    expect(await prisma.line_campaign_batches.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject(
      { attempted_at: expect.anything() },
    );
  });

  it('marks the campaign sent when its only batch went', async () => {
    const campaignId = await seedTwoBatchCampaign();
    const [batch] = await dueCampaignBatches();
    await claimCampaignBatch(batch!.id);
    await markCampaignBatchSent(batch!.id);

    const campaign = await prisma.line_campaigns.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('sent');
    expect(campaign.failure_reason).toBeNull();
    // Nothing is due again: `sent` is not a state the worker revisits.
    expect(await dueCampaignBatches()).toHaveLength(0);
  });

  it('keeps a failed batch and its words, and never picks it up again', async () => {
    const campaignId = await seedTwoBatchCampaign();
    const [batch] = await dueCampaignBatches();
    await claimCampaignBatch(batch!.id);
    await markCampaignBatchFailed(batch!.id, '429 You have reached your monthly limit.');

    const row = await prisma.line_campaign_batches.findUniqueOrThrow({ where: { id: batch!.id } });
    expect(row.status).toBe('failed');
    expect(row.error).toContain('monthly limit');

    // The state a shop has to be able to see: nothing went out, and LINE said why.
    const campaign = await prisma.line_campaigns.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('failed');
    expect(campaign.failure_reason).toContain('monthly limit');

    // At most once: a failed batch is never retried, and a person decides what to do next.
    expect(await dueCampaignBatches()).toHaveLength(0);
  });

  it('is partial when some batches went and others did not', async () => {
    // Two batches, one outcome each — the campaign shape a shop must be able to see.
    const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin' } });
    const campaign = await createCampaign({
      body: 'โปรฯ',
      imageUrl: null,
      actorId: admin.id,
      recipientIds: ['U1'],
      quotaRemainingAtSend: 300,
    });
    await prisma.line_campaign_batches.create({
      data: {
        campaign_id: campaign.id,
        batch_index: 1,
        recipient_ids: ['U2'],
        status: 'pending',
      },
    });

    const due = await dueCampaignBatches();
    expect(due).toHaveLength(2);
    // In a campaign's own order — the worker's list is `(campaign, batch index)`, so the
    // first batch is tried first and a shop's history reads forwards.
    const first = due[0]!;
    const second = due[1]!;
    expect([first.batchIndex, second.batchIndex]).toEqual([0, 1]);

    await claimCampaignBatch(first.id);
    await markCampaignBatchSent(first.id);
    await claimCampaignBatch(second.id);
    await markCampaignBatchFailed(second.id, '429 You have reached your monthly limit.');

    const row = await prisma.line_campaigns.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.status).toBe('partial');
    // A partial campaign keeps the error on the batch rather than in the campaign's own
    // field: the sentence that matters is "some customers got this and some did not".
    expect(row.failure_reason).toBeNull();

    const batches = await campaignBatches(campaign.id);
    expect(batches.map((batch) => batch.status)).toEqual(['sent', 'failed']);
  });

  it('hands the worker the message and the recipient list it approved', async () => {
    const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin' } });
    await createCampaign({
      body: 'โปรฯ ส่งถึงลูกค้า',
      imageUrl: 'https://example.test/promo.png',
      actorId: admin.id,
      recipientIds: ['U1', 'U2'],
      quotaRemainingAtSend: 42,
    });

    const [due] = await dueCampaignBatches();
    expect(due).toMatchObject({
      recipientIds: ['U1', 'U2'],
      body: 'โปรฯ ส่งถึงลูกค้า',
      imageUrl: 'https://example.test/promo.png',
      batchIndex: 0,
    });
  });
});
