// Seam under test: handing one campaign batch to LINE's multicast (ADR 0032 §7).
//
// No network is used — the fetch is stubbed — because what is asserted is the part a shop
// cannot see from the outside: the request's *shape*. LINE's multicast takes a JSON array of
// user ids in a `to` part and a `messages` array in a multipart body, and getting either wrong
// is refused by LINE with words nobody at the counter can act on. The other half is the
// failure: LINE's own `429 You have reached your monthly limit.` has to arrive as a message
// worth storing on the batch, because that sentence is what the shop's screen shows.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationDeliveryError, deliverCampaignBatch } from '@/lib/notify-channel';

/*
 * The token alone is the precondition (ADR 0032 §6): a campaign goes to customers' LINE
 * whatever `NOTIFY_CHANNEL` says about the shop's own alerts, so the transport reads the
 * token and nothing else.
 */
const ENV = { NOTIFY_LINE_TOKEN: 'channel-token' };

/** A stub LINE that records the request and answers with the given status and body. */
function stubLine(status = 200, body = '{}') {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('sending a batch', () => {
  it('POSTs the ids as a JSON array and the message as LINE takes it', async () => {
    vi.stubEnv('LINE_API_BASE_URL', 'https://line-stub.test');
    const calls = stubLine();

    await deliverCampaignBatch({ recipientIds: ['U1', 'U2'], body: 'ลด 50%', imageUrl: null }, ENV);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://line-stub.test/v2/bot/message/multicast');
    expect(calls[0]?.init?.method).toBe('POST');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer channel-token',
    );

    const form = calls[0]?.init?.body as FormData;
    expect(JSON.parse(String(form.get('to')))).toEqual(['U1', 'U2']);
    expect(JSON.parse(String(form.get('messages')))).toEqual([{ type: 'text', text: 'ลด 50%' }]);
    // Deliberately not set by hand: the boundary is the runtime's to choose, and setting
    // `content-type` on a FormData body is how a multipart request arrives unparseable.
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('adds the image as its own message, from the link the shop gave', async () => {
    vi.stubEnv('LINE_API_BASE_URL', 'https://line-stub.test');
    const calls = stubLine();

    await deliverCampaignBatch(
      { recipientIds: ['U1'], body: 'โปรฯ', imageUrl: 'https://example.test/promo.png' },
      ENV,
    );

    const form = calls[0]?.init?.body as FormData;
    expect(JSON.parse(String(form.get('messages')))).toEqual([
      { type: 'text', text: 'โปรฯ' },
      {
        type: 'image',
        originalContentUrl: 'https://example.test/promo.png',
        previewImageUrl: 'https://example.test/promo.png',
      },
    ]);
  });

  it('uses the LINE API host when the deployment has not moved it', async () => {
    const calls = stubLine();
    await deliverCampaignBatch({ recipientIds: ['U1'], body: 'x', imageUrl: null }, ENV);
    expect(calls[0]?.url).toBe('https://api.line.me/v2/bot/message/multicast');
  });
});

describe('a batch that cannot be sent', () => {
  it('records the channel own words, including the monthly-limit refusal', async () => {
    vi.stubEnv('LINE_API_BASE_URL', 'https://line-stub.test');
    stubLine(429, '{"message":"You have reached your monthly limit."}');

    const failure = await deliverCampaignBatch(
      { recipientIds: ['U1'], body: 'x', imageUrl: null },
      ENV,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotificationDeliveryError);
    expect((failure as Error).message).toContain('429');
    expect((failure as Error).message).toContain('monthly limit');
  });

  it('refuses a batch with no token, naming the variable', async () => {
    await expect(
      deliverCampaignBatch(
        { recipientIds: ['U1'], body: 'x', imageUrl: null },
        {},
      ),
    ).rejects.toThrow(/NOTIFY_LINE_TOKEN/);
  });

  it('refuses an empty recipient list rather than asking LINE to send to nobody', async () => {
    await expect(
      deliverCampaignBatch({ recipientIds: [], body: 'x', imageUrl: null }, ENV),
    ).rejects.toThrow(/no recipients/);
  });

  it('turns an unreachable host into a sentence, and not a token-bearing URL', async () => {
    vi.stubEnv('LINE_API_BASE_URL', 'https://line-stub.test/path-with-a-secret');
    vi.stubGlobal(
      'fetch',
      (async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch,
    );

    const failure = await deliverCampaignBatch(
      { recipientIds: ['U1'], body: 'x', imageUrl: null },
      ENV,
    ).catch((error: unknown) => error);

    expect((failure as Error).message).toContain('line-stub.test');
    expect((failure as Error).message).not.toContain('path-with-a-secret');
  });
});
