// Seam under test: handing a message to a gateway, and what happens when it will
// not take it.
//
// No network is used. What is asserted is the part that decides whether a shop
// discovers its own misconfiguration: the failure has to arrive as a message worth
// putting in a column, and it must not put the gateway's URL — which can carry a
// token — into that column.
import { describe, expect, it } from 'vitest';

import {
  NotificationDeliveryError,
  deliverNotification,
  readChannelConfig,
} from '@/lib/notify-channel';
import type { QueuedNotification } from '@/lib/notify-outbox';

const MESSAGE: QueuedNotification = {
  id: '1',
  kind: 'order_ready',
  channel: 'webhook',
  recipient: '0800000302',
  body: 'ออเดอร์ PO-1 พร้อมรับแล้ว',
  attempts: 1,
};

describe('reading the transport configuration', () => {
  it('is nothing when no channel is named, or when the name is unknown', () => {
    expect(readChannelConfig({})).toBeNull();
    expect(readChannelConfig({ NOTIFY_CHANNEL: 'sms' })).toBeNull();
  });

  it('picks up the token a LINE channel needs', () => {
    const config = readChannelConfig({ NOTIFY_CHANNEL: 'line', NOTIFY_LINE_TOKEN: ' tok ' });
    expect(config).toEqual({
      channel: 'line',
      webhookUrl: null,
      lineToken: 'tok',
      webhookSecret: null,
    });
  });

  it('picks up the URL and secret a webhook channel needs', () => {
    const config = readChannelConfig({
      NOTIFY_CHANNEL: 'webhook',
      NOTIFY_WEBHOOK_URL: 'https://sms.example/send?sender=shop',
      NOTIFY_WEBHOOK_SECRET: 's3cret',
    });
    expect(config?.webhookUrl).toBe('https://sms.example/send?sender=shop');
    expect(config?.webhookSecret).toBe('s3cret');
  });
});

describe('sending through a channel that cannot work', () => {
  it('refuses a LINE message with no token, and says which variable is missing', async () => {
    await expect(
      deliverNotification(
        { ...MESSAGE, channel: 'line', recipient: 'Cgroup1' },
        readChannelConfig({ NOTIFY_CHANNEL: 'line' }),
      ),
    ).rejects.toThrow(/NOTIFY_LINE_TOKEN/);
  });

  it('refuses a webhook message with no URL, and says which variable is missing', async () => {
    await expect(
      deliverNotification(MESSAGE, readChannelConfig({ NOTIFY_CHANNEL: 'webhook' })),
    ).rejects.toThrow(/NOTIFY_WEBHOOK_URL/);
  });

  it('reports an unreachable gateway as a failure, not as a crash', async () => {
    // Port 9 is the discard port and nothing listens on it, so this is a refused
    // connection with no network access required.
    const failure = await deliverNotification(
      MESSAGE,
      readChannelConfig({ NOTIFY_CHANNEL: 'webhook', NOTIFY_WEBHOOK_URL: 'http://127.0.0.1:9/notify' }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotificationDeliveryError);
    expect((failure as Error).message).toContain('127.0.0.1:9');
  });

  it('keeps a secret out of the error it stores', async () => {
    /*
     * A gateway URL routinely carries its credential in the query string, and this
     * message ends up in `notifications.last_error`, which is shown to a manager.
     * Naming the host and nothing else is the difference between a diagnosable
     * failure and a leaked API key in a database row.
     */
    const failure = await deliverNotification(
      MESSAGE,
      readChannelConfig({
        NOTIFY_CHANNEL: 'webhook',
        NOTIFY_WEBHOOK_URL: 'http://127.0.0.1:9/send?token=super-secret',
      }),
    ).catch((error: unknown) => error);

    expect((failure as Error).message).not.toContain('super-secret');
  });
});
