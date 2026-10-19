// Seam under test: the customer's five order notices, against a real database (ADR 0035).
//
// The planners are unit tests; this file is about the *wiring* — that each message is
// written inside the transaction that made it true, to the customer's own subject, and
// exactly once. That is the part a pure test cannot reach and the part most likely to be
// broken by a later refactor of `orders.ts`.
//
// The controls matter as much as the positives: a member cancelling their own order gets
// nothing, a shop on the webhook channel gets nothing, and a second reminder pass queues
// nothing again.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeShift, openShift } from '@/lib/cash-shifts';
import { listOrderViews } from '@/lib/order-view';
import {
  cancelOrder,
  completeOrder,
  confirmOrder,
  enqueueDuePickupReminders,
  expireStalePendingOrders,
  markOrderReady,
  placePreOrder,
} from '@/lib/orders';

import { prisma, resetDatabase, seedPeople, seedProduct, type TestPeople } from './helpers/test-db';

const SUBJECT = 'Ucustomer-0001';
const STAFF_GROUP = 'Cgroup-of-staff';
const BASE_URL = 'https://pos.example.com';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();

  /*
   * A customer the planner is happy to tell: bound, consented, and a friend of the
   * Official Account. The friend row is what the webhook would have written, and without
   * it every message is refused at the last condition — which is why the readiness panel
   * reports the channel secret as a requirement of the customer door.
   */
  await prisma.users.update({
    where: { id: people.memberId },
    data: {
      line_subject: SUBJECT,
      line_consent_at: new Date('2026-10-01T09:00:00+07:00'),
      line_consent_version: '2026-10-19',
    },
  });
  await prisma.line_friends.create({ data: { line_subject: SUBJECT } });

  vi.stubEnv('NOTIFY_CHANNEL', 'line');
  vi.stubEnv('NOTIFY_STAFF_TO', STAFF_GROUP);
  vi.stubEnv('PUBLIC_BASE_URL', BASE_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function withProduct(stockQty = 10, salePrice = 100): Promise<string> {
  const product = await seedProduct({
    name: `สินค้า ${Math.random().toString(36).slice(2, 8)}`,
    stockQty,
    salePrice,
    costPrice: 60,
  });
  return product.id;
}

/** Every customer-facing row for one order, oldest first. */
async function customerNotices(orderId: string) {
  return prisma.notifications.findMany({
    where: { order_id: orderId, recipient: SUBJECT },
    orderBy: { id: 'asc' },
    select: { kind: true, recipient: true, body: true, channel: true },
  });
}

describe('the journey tells the customer at each step', () => {
  it('writes accepted, ready and receipt — each in its own transaction', async () => {
    const productId = await withProduct(10, 100);
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId, quantity: 2 }],
    });

    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    const ready = await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });

    const shiftId = await openShift({ userId: people.employeeId, initialCash: 2000 }).then(
      (shift) => shift.id,
    );
    await completeOrder({
      orderId: placed.orderId,
      employeeId: people.employeeId,
      shiftId,
      settlement: { cash: 200, receivedCash: 250 },
    });
    await closeShift({ shiftId, userId: people.employeeId, actualCash: 2200 });

    const notices = await customerNotices(placed.orderId);

    expect(notices.map((row) => row.kind)).toEqual([
      'order_confirmed',
      'order_ready',
      'order_receipt',
    ]);
    // Every one goes to the customer's own subject — never to the shop's group.
    expect(notices.every((row) => row.recipient === SUBJECT)).toBe(true);
    expect(notices.every((row) => row.channel === 'line')).toBe(true);

    expect(notices[1]?.body).toContain(ready.pickupPin);
    // The receipt link is this deployment's own address, and its death is stated.
    expect(notices[2]?.body).toContain(`${BASE_URL}/receipts?t=`);
    expect(notices[2]?.body).toContain('ใช้ได้ถึง');
  });

  it('names the dropped lines when confirmation removes some', async () => {
    const keptId = await withProduct(10, 50);
    const brokenId = await withProduct(10, 30);
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [
        { productId: keptId, quantity: 1 },
        { productId: brokenId, quantity: 1 },
      ],
    });

    const detail = await prisma.order_items.findMany({
      where: { order_id: placed.orderId, product_id: brokenId },
      select: { id: true },
    });
    await confirmOrder({
      orderId: placed.orderId,
      employeeId: people.employeeId,
      removeItemIds: detail.map((item) => String(item.id)),
    });

    const confirmed = await prisma.notifications.findFirst({
      where: { order_id: placed.orderId, kind: 'order_confirmed' },
    });

    expect(confirmed?.body).toContain('ตัดออก 1 รายการ');
    expect(confirmed?.body).toContain('1 รายการ');
  });
});

describe('cancellation', () => {
  it('tells the customer when staff cancel, with the reason', async () => {
    const productId = await withProduct(5);
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId, quantity: 1 }],
    });

    await cancelOrder({
      orderId: placed.orderId,
      actorId: people.employeeId,
      reason: 'สินค้าไม่พร้อม',
      staffVoid: true,
    });

    const notices = await customerNotices(placed.orderId);
    expect(notices.map((row) => row.kind)).toEqual(['order_cancelled']);
    expect(notices[0]?.body).toContain('สินค้าไม่พร้อม');
  });

  it('says nothing when the customer withdraws their own pre-order', async () => {
    // The customer is the actor, not the audience: a note telling them what they just
    // did is noise, and `staffVoid` is the flag that already distinguishes the two.
    const productId = await withProduct(5);
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId, quantity: 1 }],
    });

    await cancelOrder({
      orderId: placed.orderId,
      actorId: people.memberId,
      reason: 'เปลี่ยนใจ',
      staffVoid: false,
    });

    expect(await customerNotices(placed.orderId)).toEqual([]);
  });

  it('tells the customer when the confirmation deadline expires', async () => {
    const productId = await withProduct(5);
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId, quantity: 1 }],
    });
    await prisma.orders.update({
      where: { id: placed.orderId },
      data: { confirm_deadline: new Date(Date.now() - 60_000) },
    });

    const swept = await expireStalePendingOrders();
    expect(swept.expired).toBe(1);

    const notices = await customerNotices(placed.orderId);
    expect(notices.map((row) => row.kind)).toEqual(['order_cancelled']);
    expect(notices[0]?.body).toContain('หมดเวลายืนยัน');
  });
});

describe('the reminder', () => {
  async function readyOrder(holdMinutesFromNow: number) {
    const productId = await withProduct(5);
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId, quantity: 1 }],
    });
    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });
    await prisma.orders.update({
      where: { id: placed.orderId },
      data: { pickup_expires_at: new Date(Date.now() + holdMinutesFromNow * 60_000) },
    });
    return placed.orderId;
  }

  it('queues one reminder inside the window, and nothing on a second pass', async () => {
    const orderId = await readyOrder(120); // default lead time is 3 hours

    expect((await enqueueDuePickupReminders()).queued).toBe(1);
    // The worker calls this every pass, so a second call must be a no-op: the query
    // excludes orders that already carry a reminder.
    expect((await enqueueDuePickupReminders()).queued).toBe(0);

    const notices = await customerNotices(orderId);
    // The order was confirmed on the way to being packed, so its notice is there too.
    expect(notices.map((row) => row.kind)).toEqual([
      'order_confirmed',
      'order_ready',
      'order_reminder',
    ]);
    expect(notices[2]?.body).toContain('ใกล้หมดเวลา');
  });

  it('leaves a parcel whose hold is further out alone', async () => {
    await readyOrder(60 * 24);
    expect((await enqueueDuePickupReminders()).queued).toBe(0);
  });

  it('leaves a parcel whose hold has already ended alone', async () => {
    // A deadline that has passed is a late parcel, not a reminder — telling somebody
    // about it would be worse than saying nothing.
    await readyOrder(-60);
    expect((await enqueueDuePickupReminders()).queued).toBe(0);
  });

  it('queues nothing for a customer who is not a friend of the shop', async () => {
    await prisma.line_friends.deleteMany({ where: { line_subject: SUBJECT } });
    await readyOrder(120);

    expect((await enqueueDuePickupReminders()).queued).toBe(0);
  });
});

describe('what the board says', () => {
  it('reports a queued notice, and the friend gap when nothing was written', async () => {
    // Two parcels and one friend: the first is told, the second is not, and the board
    // has to say both — the difference is the whole reason the line exists.
    const toldProduct = await withProduct(5);
    const told = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: toldProduct, quantity: 1 }],
    });
    await confirmOrder({ orderId: told.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: told.orderId, employeeId: people.employeeId });

    await prisma.line_friends.deleteMany({ where: { line_subject: SUBJECT } });

    const silentProduct = await withProduct(5);
    const silent = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: silentProduct, quantity: 1 }],
    });
    await confirmOrder({ orderId: silent.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: silent.orderId, employeeId: people.employeeId });

    const rows = await listOrderViews({ statuses: ['ready_for_pickup'], limit: 10 });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(told.orderId)?.readyNotice.state).toBe('queued');
    expect(byId.get(told.orderId)?.readyNotice.sentence).toContain('คิว');

    expect(byId.get(silent.orderId)?.readyNotice.state).toBe('not_sent');
    expect(byId.get(silent.orderId)?.readyNotice.reason).toBe('not_a_friend');
    expect(byId.get(silent.orderId)?.readyNotice.sentence).toContain('เพิ่มเพื่อนร้าน');
  });
});

describe('the channel gate', () => {
  it('queues none of the four on a webhook shop, and still texts the ready note', async () => {
    vi.stubEnv('NOTIFY_CHANNEL', 'webhook');
    vi.stubEnv('NOTIFY_WEBHOOK_URL', 'https://sms.example.com/send');

    const productId = await withProduct(5);
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId, quantity: 1 }],
    });
    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });

    // The LINE-only facts are absent...
    expect(await customerNotices(placed.orderId)).toEqual([]);
    // ...while the channel ADR 0007 built still tells the customer by phone.
    const sms = await prisma.notifications.findMany({
      where: { order_id: placed.orderId, kind: 'order_ready' },
      select: { channel: true, recipient: true },
    });
    expect(sms).toEqual([{ channel: 'webhook', recipient: people.memberPhone }]);
  });
});
