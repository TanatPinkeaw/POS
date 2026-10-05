// Seam under test: the three pre-order board fixes that are about *rules* rather
// than about pixels — who may cancel, what the countdown counts to, and what the
// photo-link check refuses before it saves anything.
//
// The board's layout and the carousel are covered by the browser check; these are the
// assertions that must hold on a server with no browser at all.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { probeImageUrl, renderableImageUrl } from '@/lib/image-url';
import { listOrderViews } from '@/lib/order-view';
import {
  cancelOrder,
  completeOrder,
  confirmOrder,
  markOrderReady,
  placePreOrder,
} from '@/lib/orders';

import {
  prisma,
  resetDatabase,
  seedOpenShift,
  seedPeople,
  seedProduct,
  seedShop,
  type TestPeople,
} from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a staff cancellation', () => {
  it('is allowed without a supervisor, and is still written to the trail', async () => {
    const product = await seedProduct({ name: 'ขนมปัง', stockQty: 5, salePrice: 40, costPrice: 20 });
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 2 }],
    });

    /*
     * The whole point of ADR 0026 in one assertion: the call succeeds with nothing
     * but an actor id — no approver, no PIN, no `authorizedByUserId` — *and* leaves a
     * row naming who did it.
     *
     * Both halves matter. Dropping the approval gate without the audit row would have
     * released a reservation with nothing recorded, which is exactly the quiet the
     * trail exists to prevent; keeping the gate would have left the button unusable.
     */
    await cancelOrder({
      orderId: placed.orderId,
      actorId: people.employeeId,
      reason: 'ลูกค้าเปลี่ยนใจ',
      staffVoid: true,
    });

    const audit = await prisma.audit_logs.findMany({
      where: { target_id: placed.orderId, action: 'void_order' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_user_id).toBe(people.employeeId);
    // No approver: this is the shape an owner is looking for after the gate was dropped.
    expect(audit[0]?.authorized_by_user_id ?? null).toBeNull();
    expect((audit[0]?.detail as Record<string, unknown>)?.approval).toBe('not_required');
  });

  it('writes no void row when a member withdraws their own pre-order', async () => {
    const product = await seedProduct({ name: 'กาแฟ', stockQty: 3, salePrice: 60, costPrice: 30 });
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });

    await cancelOrder({
      orderId: placed.orderId,
      actorId: people.memberId,
      reason: 'เปลี่ยนใจ',
      staffVoid: false,
    });

    const audit = await prisma.audit_logs.findMany({ where: { target_id: placed.orderId } });
    expect(audit).toHaveLength(0);
  });
});

describe('the Phase 1 deadline', () => {
  it('is stamped on the order when it is placed, not read from the timeout setting later', async () => {
    const product = await seedProduct({ name: 'นม', stockQty: 5, salePrice: 25, costPrice: 12 });
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });

    /*
     * The board counts down to whatever this says. A screen that recomputed
     * `created_at + 15 minutes` of its own would show a different number from the
     * moment somebody changed the setting, and the two answers would disagree on the
     * same card.
     */
    const [row] = await listOrderViews({ limit: 10 });
    expect(row?.confirmDeadline).not.toBeNull();

    const stored = new Date(row!.confirmDeadline!);
    const placedAt = Date.now();
    const minutes = Math.round((stored.getTime() - placedAt) / 60_000);
    expect(minutes).toBeGreaterThan(0);
    // The shipped default is 30 (ADR 0026); anything in that neighbourhood passes,
    // and the assertion below is what would notice a silent revert to 15.
    expect(minutes).toBeLessThanOrEqual(30);
    expect(minutes).toBeGreaterThan(28);
  });

  it('does not move when the shop changes its timeout afterwards', async () => {
    const product = await seedProduct({ name: 'ชา', stockQty: 5, salePrice: 25, costPrice: 12 });
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });

    const before = await prisma.orders.findUniqueOrThrow({
      where: { id: placed.orderId },
      select: { confirm_deadline: true },
    });

    // The setting changes; the row that was already given a deadline must not follow it.
    process.env.PREORDER_CONFIRM_TIMEOUT_MINUTES = '5';
    try {
      const [row] = await listOrderViews({ limit: 10 });
      expect(row?.confirmDeadline?.toISOString()).toBe(before.confirm_deadline?.toISOString());
    } finally {
      delete process.env.PREORDER_CONFIRM_TIMEOUT_MINUTES;
    }
  });
});

describe('the photo link probe', () => {
  it('refuses a link the allowlist refuses, without touching the network', async () => {
    /*
     * No `Image` is constructed and no request is made: the refusal is decided from
     * the string, because a probe that had to reach the network to discover a
     * `javascript:` URL would already have been the problem.
     */
    const result = await probeImageUrl('data:image/png;base64,iVBORw0KGgo=');
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('refused');
    expect(result.message).toBeTruthy();
  });

  it('names an empty link as unusable rather than as a broken picture', async () => {
    for (const empty of [null, undefined, '', '   ']) {
      const result = await probeImageUrl(empty);
      expect(result.ok).toBe(false);
    }
  });

  it('still renders an acceptable link through the allowlist it shares with Thumb', () => {
    // The two must not drift: `Thumb` draws what the allowlist permits and the probe
    // is what tells the shop whether that draw will work.
    expect(renderableImageUrl('https://drive.example.stream/x.jpg')).toBe(
      'https://drive.example.stream/x.jpg',
    );
  });
});
describe('the copies of the timeout the customer reads', () => {
  it('are read from the server rather than typed beside the sentence', () => {
    /*
     * Three places state this number to a human: the board's page subtitle, the
     * catalogue's confirmation line, and the countdown itself. All three carried a
     * literal while the deadline came from a setting, which is how a shop ends up
     * promising one number on a screen and enforcing another.
     *
     * The assertion is that none of them is a hardcoded literal any more — not that
     * they read a particular number, because the number is the shop's to choose.
     *
     * Comments are stripped first, and for the same reason `privacy-notice.test.ts`
     * strips them: a file that *documents* the bug it used to have quotes the old
     * value, and a test that read the raw source would fail on the explanation.
     */
    const renderedCopy = (file: string): string =>
      readFileSync(resolve(file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const file of [
      'src/app/(pos)/pos/preorders/page.tsx',
      'src/components/shop/ShopCatalog.tsx',
    ]) {
      expect(renderedCopy(file)).not.toMatch(/\d+\s*นาที/);
    }
  });
});

describe('the sales history search', () => {
  it('finds a sale by its order number when the shop has no receipt numbers', async () => {
    /*
     * The shop this ships to is not VAT registered, and `receipt_number` is allocated
     * out of the *tax* document series — so it is null on every one of its sales. A
     * search that only looked there answered "no such sale" to every number the shop
     * can see on its own screen, and the list rendered an em dash instead of the order
     * number it had. The order number is printed on the same paperwork, so it counts.
     */
    await seedShop({ isVatRegistered: false });
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ name: 'นมสด', stockQty: 5, salePrice: 17 });

    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });
    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });
    await completeOrder({
      orderId: placed.orderId,
      employeeId: people.employeeId,
      shiftId,
      settlement: { cash: 17 },
    });

    // The premise: this shop really does have no receipt numbers to search by.
    const [row] = await listOrderViews({ statuses: ['completed'], limit: 5 });
    expect(row?.receiptNumber).toBeNull();
    expect(row?.orderNumber).toBe(placed.orderNumber);

    const byOrderNumber = await listOrderViews({
      statuses: ['completed'],
      receiptNumber: placed.orderNumber,
      limit: 5,
    });
    expect(byOrderNumber.map((r) => r.id)).toContain(placed.orderId);

    // Case-insensitively, because a number read off a receipt is typed by hand.
    const lower = await listOrderViews({
      statuses: ['completed'],
      receiptNumber: placed.orderNumber.toLowerCase(),
      limit: 5,
    });
    expect(lower.map((r) => r.id)).toContain(placed.orderId);
  });
});

describe('the carousel arrows', () => {
  it('never ask the browser for an animated scroll', () => {
    /*
     * The arrows used to move the board with `scrollTo({ behavior: 'smooth' })`, and
     * that is correct on a normal browser and *silently does nothing* where the
     * compositor is not driving frames — an embedded webview, a kiosk shell, a
     * backgrounded tab. `scrollLeft` never leaves 0, no `scroll` event fires, so the
     * counter advances to a card that is not on screen and the button looks alive while
     * being dead.
     *
     * It cannot be caught after the fact: a timer cannot tell "still animating" from
     * "never started", and a rAF-based fallback dies of the same cause as the thing it
     * was backing up. So the decision is pinned here instead — the control assigns
     * `scrollLeft`, which is instant on every engine. A swipe is untouched by this;
     * that is native scrolling and keeps its momentum either way.
     */
    const source = readFileSync('src/components/ds/Carousel.tsx', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(source).not.toMatch(/smooth/);
    expect(source).toMatch(/viewport\.scrollLeft\s*=/);
  });

  it('has no timer of its own, so nothing on the board can advance it', () => {
    /*
     * The shop asked for a carousel that never moves by itself, and "never" has to mean
     * never rather than "not unless somebody re-renders it". The only timers allowed in
     * the file are the retry for a slide that has not been laid out yet, which asks for
     * a position and is driven by the operator's own click.
     */
    const source = readFileSync('src/components/ds/Carousel.tsx', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(source).not.toMatch(/setInterval/);
    expect(source).not.toMatch(/autoplay|rotate\(\)/i);
  });
});
