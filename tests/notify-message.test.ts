// Seam under test: deciding whether a message should exist, who it is for, and
// what it says.
//
// Everything here is a decision rather than an effect, which is the point: a
// notification that should not be sent must be *nothing*, not a row that a worker
// later tries and fails to deliver. The rule with real teeth is the second one
// below — the shop's own group must never receive a customer's collection code.
import { describe, expect, it } from 'vitest';

import {
  MAX_TEXT_LENGTH,
  planOrderReadyNotification,
  planPreOrderPlacedNotification,
  readNotifyConfig,
  type NotifyConfig,
} from '@/lib/notify-message';

const WEBHOOK: NotifyConfig = { channel: 'webhook', staffTo: '0800000300' };
const LINE: NotifyConfig = { channel: 'line', staffTo: 'Cgroup1234567890' };
const OFF: NotifyConfig = { channel: null, staffTo: null };

const READY = {
  orderId: '11111111-2222-3333-4444-555555555555',
  orderNumber: 'PO-20260928-000001',
  pickupPin: '7391',
  holdUntil: new Date('2026-09-28T12:00:00.000Z'),
  customerName: 'สมชาย เหลี่ยมนอก',
  customerPhone: '0800000302',
};

const PLACED = {
  orderId: '11111111-2222-3333-4444-555555555555',
  orderNumber: 'PO-20260928-000001',
  customerName: 'สมชาย เหลี่ยมนอก',
  itemCount: 3,
  totalThb: 321,
};

describe('a shop with no channel configured', () => {
  it('plans nothing at all, rather than something it cannot deliver', () => {
    // An outbox full of rows nobody can send is a to-do list that never shortens.
    expect(planOrderReadyNotification(READY, OFF)).toBeNull();
    expect(planPreOrderPlacedNotification(PLACED, OFF)).toBeNull();
  });
});

describe('telling a customer their parcel is ready', () => {
  it('goes to the customer, by phone, with the PIN they will need', () => {
    const planned = planOrderReadyNotification(READY, WEBHOOK);

    expect(planned?.kind).toBe('order_ready');
    expect(planned?.recipient).toBe(READY.customerPhone);
    expect(planned?.text).toContain(READY.orderNumber);
    expect(planned?.text).toContain(READY.pickupPin);
    expect(planned?.orderId).toBe(READY.orderId);
  });

  it('says when the hold runs out, in Bangkok time', () => {
    // 12:00 UTC is 19:00 in Bangkok. Getting this wrong tells a customer their
    // parcel expires seven hours early or seven hours late.
    expect(planOrderReadyNotification(READY, WEBHOOK)?.text).toContain('19:00');
  });

  it('is never sent to the shop’s own group', () => {
    /*
     * The rule this file exists for. A LINE push goes to a LINE user id, and the
     * only one this shop has is its own staff group — a phone number is not one.
     * Sending a collection code there would put every waiting parcel's PIN in a
     * room of staff phones, and the customer's own code is on their own screen.
     */
    expect(planOrderReadyNotification(READY, LINE)).toBeNull();
  });

  it('is nothing when there is no number to send it to', () => {
    expect(planOrderReadyNotification({ ...READY, customerPhone: null }, WEBHOOK)).toBeNull();
    expect(planOrderReadyNotification({ ...READY, customerPhone: '  ' }, WEBHOOK)).toBeNull();
  });
});

describe('telling the shop a pre-order arrived', () => {
  it('goes to the shop’s own destination, on either channel', () => {
    for (const config of [WEBHOOK, LINE]) {
      const planned = planPreOrderPlacedNotification(PLACED, config);
      expect(planned?.recipient, config.channel ?? 'off').toBe(config.staffTo);
      expect(planned?.channel).toBe(config.channel);
      expect(planned?.text).toContain(PLACED.orderNumber);
    }
  });

  it('names the customer, the size and the money', () => {
    const text = planPreOrderPlacedNotification(PLACED, WEBHOOK)?.text ?? '';

    expect(text).toContain(PLACED.customerName);
    expect(text).toContain('3');
    expect(text).toContain('321');
  });

  it('is nothing when the shop has nowhere to put it', () => {
    expect(planPreOrderPlacedNotification(PLACED, { channel: 'webhook', staffTo: null })).toBeNull();
  });
});

describe('a planned message', () => {
  it('fits in a couple of SMS segments', () => {
    /*
     * Thai is UCS-2 on the wire, so a segment is ~70 characters rather than 160
     * and the count is visible on the shop's bill. This is a tripwire for somebody
     * adding a paragraph, not a formatting rule.
     */
    for (const planned of [
      planOrderReadyNotification(READY, WEBHOOK),
      planPreOrderPlacedNotification(PLACED, WEBHOOK),
    ]) {
      expect(planned?.text.length ?? 0).toBeGreaterThan(0);
      expect(planned?.text.length ?? 0).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    }
  });

  it('carries no newline-free run of whitespace from a null name', () => {
    const text = planPreOrderPlacedNotification({ ...PLACED, customerName: null }, WEBHOOK)?.text;
    expect(text).not.toContain('  ');
    expect(text).not.toMatch(/undefined|null/);
  });
});

describe('reading the configuration', () => {
  it('treats an unset channel as no channel, and unknown names as no channel', () => {
    expect(readNotifyConfig({}).channel).toBeNull();
    expect(readNotifyConfig({ NOTIFY_CHANNEL: '' }).channel).toBeNull();
    expect(readNotifyConfig({ NOTIFY_CHANNEL: 'carrier-pigeon' }).channel).toBeNull();
    expect(readNotifyConfig({ NOTIFY_CHANNEL: 'webhook' }).channel).toBe('webhook');
    expect(readNotifyConfig({ NOTIFY_CHANNEL: 'line' }).channel).toBe('line');
  });

  it('trims the shop’s destination, and treats blank as absent', () => {
    expect(readNotifyConfig({ NOTIFY_CHANNEL: 'line', NOTIFY_STAFF_TO: ' C123 ' }).staffTo).toBe(
      'C123',
    );
    expect(readNotifyConfig({ NOTIFY_CHANNEL: 'line', NOTIFY_STAFF_TO: '   ' }).staffTo).toBeNull();
  });
});
