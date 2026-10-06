// Seam under test: a member offering their own goods for consignment (ADR 0025).
//
// The properties that matter here are the ones a wrong number or a lost row would
// break, and they are all about trust at a boundary: an offer sent twice is one
// offer, an offer belongs to the member who sent it and to nobody else, an offer
// decides nothing by itself, and nothing a member can type into a link gets stored
// unchecked.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  approveSubmission,
  listCustomerSubmissions,
  listPendingSubmissions,
  listProductDocuments,
  rejectSubmission,
  submitOffer,
} from '@/lib/consignment-intake';
import { ConflictError, ValidationError } from '@/lib/errors';
import { consignmentOfferSchema } from '@/lib/schemas';

import { prisma, resetDatabase, seedPeople, type TestPeople } from './helpers/test-db';

let people: TestPeople;

const PHOTO = 'https://drive.google.com/thumbnail?id=abc&sz=w1024';
const PAPER = 'https://drive.google.com/file/d/def/view';

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * One offer, with the fields the tests do not care about left at defaults.
 *
 * `clientRef` is a real UUID because the schema demands one and because it is the
 * property under test — a test that passed a string would be testing a door the
 * member's browser can never walk through.
 */
function anOffer(overrides: Partial<Parameters<typeof submitOffer>[1]> = {}) {
  return {
    consignorUserId: people.memberId,
    clientRef: '11111111-1111-4111-8111-111111111111',
    productName: 'ขนมปังถัง',
    offeredPriceThb: 120,
    quantity: 6,
    notes: 'ส่งตอนเช้า',
    attachments: [
      { kind: 'photo' as const, label: '', url: PHOTO },
      { kind: 'document' as const, label: '', url: PAPER },
    ],
    ...overrides,
  };
}

/** A second key, for a genuinely different offer. */
function otherRef(suffix: string): string {
  return `22222222-2222-4222-8222-22222222222${suffix}`.slice(0, 36);
}

describe('the offer writes a request and nothing more', () => {
  it('records a pending submission with its documents and an audit row', async () => {
    const result = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));

    expect(result.duplicate).toBe(false);

    const row = await prisma.consignment_submissions.findUnique({
      where: { id: result.submissionId },
      include: { documents: true },
    });
    expect(row?.status).toBe('pending');
    expect(row?.product_name).toBe('ขนมปังถัง');
    expect(row?.quantity).toBe(6);
    // Nothing is owed and nothing is on the shelf until somebody decides.
    expect(row?.product_id).toBeNull();
    expect(row?.decided_share_percent).toBeNull();

    expect(row?.documents).toHaveLength(2);
    const kinds = row?.documents.map((document) => document.kind).sort();
    expect(kinds).toEqual(['document', 'photo']);
    // A photo a member did not caption gets a Thai default rather than a blank chip.
    expect(row?.documents.find((d) => d.kind === 'photo')?.label).toBe('รูปแรก');

    const audit = await prisma.audit_logs.findFirst({
      where: { action: 'consignment_offer_submitted', target_id: result.submissionId },
    });
    expect(audit).not.toBeNull();
    // The member is the actor, because the member is the one who pressed send — the
    // whole difference from a stranger's form answer arriving with nobody behind it.
    expect(audit?.actor_user_id).toBe(people.memberId);
  });

  it('takes the owner from the caller rather than from anything the member typed', async () => {
    /*
     * There is no phone and no member id in `consignmentOfferSchema` at all, which is
     * asserted in the schema block below. What this test pins is the other half of the
     * claim: what reaches the library is the id the route got from the session, and the
     * row reads it back rather than resolving anything.
     */
    const stranger = await prisma.users.create({
      data: { phone: '0900000009', password_hash: 'x', full_name: 'คนอื่น', role: 'member' },
    });
    const result = await prisma.$transaction((tx) =>
      submitOffer(tx, anOffer({ consignorUserId: stranger.id })),
    );

    const row = await prisma.consignment_submissions.findUnique({
      where: { id: result.submissionId },
    });
    expect(row?.consignor_user_id).toBe(stranger.id);
  });
});

describe('a double tap is the same offer', () => {
  it('returns the existing row instead of creating a second one', async () => {
    const first = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));
    const second = await prisma.$transaction((tx) =>
      submitOffer(tx, anOffer({ productName: 'ชื่อที่แก้ไป' })),
    );

    expect(second.duplicate).toBe(true);
    expect(second.submissionId).toBe(first.submissionId);
    expect(await prisma.consignment_submissions.count()).toBe(1);
    // And it did not rewrite what the member actually said.
    const row = await prisma.consignment_submissions.findUnique({ where: { id: first.submissionId } });
    expect(row?.product_name).toBe('ขนมปังถัง');
  });

  it('does not resurrect a decided offer', async () => {
    const first = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));
    await prisma.$transaction((tx) =>
      rejectSubmission(tx, {
        submissionId: first.submissionId,
        actorId: people.adminId,
        note: 'ยังไม่ได้เปิดรับสินค้านี้',
      }),
    );

    const replay = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));
    expect(replay.submissionId).toBe(first.submissionId);

    const row = await prisma.consignment_submissions.findUnique({ where: { id: first.submissionId } });
    expect(row?.status).toBe('rejected');
  });
});

describe('approval turns the offer into a product the shop owes on', () => {
  it('creates the product, sets the share, moves the stock and attaches the documents', async () => {
    const offer = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));

    const approved = await prisma.$transaction((tx) =>
      approveSubmission(tx, {
        submissionId: offer.submissionId,
        actorId: people.adminId,
        sharePercent: 60,
        receivedQty: 5,
        salePriceThb: 150,
      }),
    );

    expect(approved.attachedDocuments).toBe(2);
    expect(approved.receivedQty).toBe(5);

    const product = await prisma.products.findUnique({ where: { id: approved.productId } });
    expect(product?.name).toBe('ขนมปังถัง');
    expect(Number(product?.sale_price)).toBe(150);
    // The shop does not own these goods, so it has no cost price for them.
    expect(Number(product?.cost_price)).toBe(0);
    expect(product?.stock_qty).toBe(5);
    // The member who sent the offer owns the goods, without anybody picking them.
    expect(product?.consignor_user_id).toBe(people.memberId);
    expect(product?.consignor_share_percent).toBe(60);
    // The first usable photo became the product's image, through the same allowlist a
    // pasted link goes through (ADR 0014).
    expect(product?.image_url).toBe(PHOTO);

    // The shelf moved by a movement the report can tell from a delivery.
    const movement = await prisma.stock_logs.findFirst({
      where: { product_id: approved.productId },
    });
    expect(movement?.movement_type).toBe('consignment_received');
    expect(movement?.reason).toBe('REASON_CONSIGNMENT');
    expect(movement?.qty_changed).toBe(5);

    // The paperwork now belongs to the product, not just to the request.
    const documents = await listProductDocuments(approved.productId, prisma);
    expect(documents).toHaveLength(2);

    const row = await prisma.consignment_submissions.findUnique({
      where: { id: offer.submissionId },
    });
    expect(row?.status).toBe('approved');
    expect(row?.product_id).toBe(approved.productId);
    expect(row?.decided_share_percent).toBe(60);
    expect(row?.decided_by_user_id).toBe(people.adminId);
  });

  it('writes both audit rows a decision makes', async () => {
    const offer = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));
    await prisma.$transaction((tx) =>
      approveSubmission(tx, {
        submissionId: offer.submissionId,
        actorId: people.adminId,
        sharePercent: 60,
      }),
    );

    // The decision about the *request* targets the submission…
    const decision = await prisma.audit_logs.findFirst({
      where: { action: 'consignment_submission_approved', target_id: offer.submissionId },
    });
    expect(decision).not.toBeNull();

    // …and the terms landing on the product target the product, written by the same
    // click. Two rows on purpose: an owner reading the trail wants the decision about
    // the request *and* the terms it produced, and should not infer one from the other.
    const product = await prisma.consignment_submissions.findUnique({
      where: { id: offer.submissionId },
      select: { product_id: true },
    });
    const terms = await prisma.audit_logs.findFirst({
      where: { action: 'consignment_set', target_id: product?.product_id ?? '' },
    });
    expect(terms).not.toBeNull();
    expect(terms?.actor_user_id).toBe(people.adminId);
  });

  it('refuses a second decision on the same offer', async () => {
    const offer = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));
    await prisma.$transaction((tx) =>
      approveSubmission(tx, {
        submissionId: offer.submissionId,
        actorId: people.adminId,
        sharePercent: 50,
      }),
    );

    await expect(
      prisma.$transaction((tx) =>
        approveSubmission(tx, {
          submissionId: offer.submissionId,
          actorId: people.adminId,
          sharePercent: 70,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // One offer, one product: a second approval must not make a second product.
    expect(await prisma.products.count()).toBe(1);
  });

  it('lets an owner approve on behalf of the member standing at the counter', async () => {
    const offer = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));
    const other = await prisma.users.create({
      data: { phone: '0900000009', password_hash: 'x', full_name: 'คนอื่น', role: 'member' },
    });

    const approved = await prisma.$transaction((tx) =>
      approveSubmission(tx, {
        submissionId: offer.submissionId,
        actorId: people.adminId,
        sharePercent: 40,
        consignorUserId: other.id,
      }),
    );

    const product = await prisma.products.findUnique({ where: { id: approved.productId } });
    expect(product?.consignor_user_id).toBe(other.id);
  });

  it('refuses a received quantity that is not a positive whole number', async () => {
    const offer = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));

    for (const receivedQty of [0, -3, 2.5]) {
      await expect(
        prisma.$transaction((tx) =>
          approveSubmission(tx, {
            submissionId: offer.submissionId,
            actorId: people.adminId,
            sharePercent: 50,
            receivedQty,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe('a refusal keeps the row and demands a reason', () => {
  it('records the note the member will read', async () => {
    const offer = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));

    await prisma.$transaction((tx) =>
      rejectSubmission(tx, {
        submissionId: offer.submissionId,
        actorId: people.adminId,
        note: '  ราคานี้ต่ำกว่าต้นทุน  ',
      }),
    );

    const row = await prisma.consignment_submissions.findUnique({
      where: { id: offer.submissionId },
    });
    expect(row?.status).toBe('rejected');
    // Trimmed, because the member reads this on their own account page.
    expect(row?.decision_note).toBe('ราคานี้ต่ำกว่าต้นทุน');
    expect(row?.product_id).toBeNull();
  });

  it('refuses a blank reason', async () => {
    const offer = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));

    await expect(
      prisma.$transaction((tx) =>
        rejectSubmission(tx, {
          submissionId: offer.submissionId,
          actorId: people.adminId,
          note: '   ',
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('who can read what', () => {
  it('gives a member their own offers and nobody else theirs', async () => {
    const mine = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));

    const stranger = await prisma.users.create({
      data: { phone: '0900000009', password_hash: 'x', full_name: 'คนอื่น', role: 'member' },
    });
    await prisma.$transaction((tx) =>
      submitOffer(tx, anOffer({ consignorUserId: stranger.id, clientRef: otherRef('2') })),
    );

    const mineView = await listCustomerSubmissions(people.memberId, prisma);
    expect(mineView).toHaveLength(1);
    expect(mineView[0].id).toBe(mine.submissionId);
    expect(await listCustomerSubmissions(stranger.id, prisma)).toHaveLength(1);
  });

  it('shows the owner only what is still waiting', async () => {
    const pending = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));
    const decided = await prisma.$transaction((tx) =>
      submitOffer(tx, anOffer({ clientRef: otherRef('2') })),
    );
    await prisma.$transaction((tx) =>
      rejectSubmission(tx, {
        submissionId: decided.submissionId,
        actorId: people.adminId,
        note: 'ยังไม่รับ',
      }),
    );

    const inbox = await listPendingSubmissions(prisma);
    expect(inbox.map((row) => row.id)).toEqual([pending.submissionId]);
  });

  it('reads the contact details from the member account rather than off the offer', async () => {
    await prisma.$transaction((tx) => submitOffer(tx, anOffer()));

    const [view] = await listPendingSubmissions(prisma);
    expect(view.consignorName).toBe(people.memberName);
    // The owner needs a number to ring, and the offer does not carry one of its own.
    expect(view.consignorPhone).toBe(people.memberPhone);
  });

  it('tells a member the share once it has been agreed', async () => {
    const offer = await prisma.$transaction((tx) => submitOffer(tx, anOffer()));
    await prisma.$transaction((tx) =>
      approveSubmission(tx, {
        submissionId: offer.submissionId,
        actorId: people.adminId,
        sharePercent: 65,
      }),
    );

    const [view] = await listCustomerSubmissions(people.memberId, prisma);
    expect(view.status).toBe('approved');
    expect(view.decidedSharePercent).toBe(65);
    // A member's own page lists what they sent rather than drawing it.
    expect(view.documents.every((document) => document.imageSrc === null)).toBe(true);
  });
});

describe('the request schema', () => {
  const base = {
    clientRef: '11111111-1111-4111-8111-111111111111',
    productName: 'ขนมปังถัง',
    offeredPriceThb: 120,
    quantity: 6,
  };

  it('accepts a bare offer with no attachments', () => {
    const parsed = consignmentOfferSchema.parse(base);
    expect(parsed.photos).toEqual([]);
    expect(parsed.documents).toEqual([]);
  });

  it('carries no way to name another member, a phone number or a share', () => {
    // The route takes the member from the session and the share from nowhere the member
    // can reach. The schema strips what it does not know rather than refusing it, so the
    // property is that these never survive parsing — a rejected request would be a
    // stranger's field, and a silently kept one would be a stranger's member.
    for (const field of ['consignorUserId', 'phone', 'formResponseId', 'status', 'sharePercent']) {
      const parsed = consignmentOfferSchema.parse({ ...base, [field]: 'x' });
      expect(parsed).not.toHaveProperty(field);
    }
  });

  it('refuses a client key that is not a uuid', () => {
    expect(() => consignmentOfferSchema.parse({ ...base, clientRef: 'ref_1' })).toThrow();
  });

  it('refuses a link the shop could not draw or open', () => {
    for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil.test/x.png']) {
      expect(() => consignmentOfferSchema.parse({ ...base, photos: [{ url }] })).toThrow();
    }
  });

  it('refuses an offer that is not a countable one', () => {
    expect(() => consignmentOfferSchema.parse({ ...base, quantity: 0 })).toThrow();
    expect(() => consignmentOfferSchema.parse({ ...base, quantity: 1.5 })).toThrow();
    expect(() => consignmentOfferSchema.parse({ ...base, offeredPriceThb: -1 })).toThrow();
    expect(() => consignmentOfferSchema.parse({ ...base, productName: '   ' })).toThrow();
    // Too many photographs is refused too: each one is a fetch somebody pays for.
    expect(() =>
      consignmentOfferSchema.parse({
        ...base,
        photos: Array.from({ length: 9 }, () => ({ url: PHOTO })),
      }),
    ).toThrow();
  });
});
