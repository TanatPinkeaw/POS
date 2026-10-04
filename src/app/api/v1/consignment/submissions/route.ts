/**
 * A member's own consignment offers (ADR 0025), from both sides.
 *
 *   * **GET** is what the member's account page draws: "what has the shop done with
 *     what I sent". Scoped by the session's own id — the same property and the same
 *     reason as `/api/v1/consignment` beside it: there is no parameter anywhere in
 *     this route that could widen it to somebody else's.
 *   * **POST** is the intake itself. The member fills in the form on their own
 *     account page and the browser posts it here, so this is the only door into
 *     `consignment_submissions` a member has, and the session is the whole of its
 *     authentication.
 *
 * Two things about POST are deliberate:
 *
 *   * **The rate limit is keyed by the account, not the address**, for the reason
 *     `member_create` is: two members on the shop's one wifi are two people, and
 *     neither should spend the other's budget. Ten offers back to back, then one every
 *     minute — a person offering a tray of things pauses to photograph it, and a script
 *     loop cannot tell the difference between that and a flood.
 *   * **One transaction** covers the offer, its documents and the audit row. A member
 *     whose photo made it into the inbox with no trail behind it is an offer that
 *     arrived from nowhere, which is the one thing an owner scanning the trail must be
 *     able to rule out.
 *
 * It is a separate route from `/api/v1/consignment` rather than another key on the
 * portal's payload because the two have different lives: that one is the money, this
 * one is the queue in front of the money. A member whose offer was refused can see the
 * reason here without any of it touching what they are owed.
 */
import { ok, readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import {
  listCustomerSubmissions,
  submitOffer,
  type OfferAttachment,
} from '@/lib/consignment-intake';
import { prisma } from '@/lib/db';
import { chargeRateLimit } from '@/lib/rate-limit';
import { consignmentOfferSchema } from '@/lib/schemas';

export async function GET(): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member']);
    return listCustomerSubmissions(session.id, prisma);
  });
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member']);
    await chargeRateLimit(request, 'consignment_offer', session.id);

    const body = await readJson(request, consignmentOfferSchema);

    /*
     * Photos and documents arrive as two lists and are stored as one, because the
     * table's `kind` column is what tells them apart later and a screen that has to
     * merge two arrays to draw a member's paperwork is a screen that can draw it wrong.
     */
    const attachments: OfferAttachment[] = [
      ...body.photos.map((photo) => ({
        kind: 'photo' as const,
        label: photo.label ?? '',
        url: photo.url,
      })),
      ...body.documents.map((document) => ({
        kind: 'document' as const,
        label: document.label ?? '',
        url: document.url,
      })),
    ];

    const result = await prisma.$transaction((tx) =>
      submitOffer(tx, {
        // From the session, never from the body: the member cannot offer goods on
        // somebody else's behalf, and there is no field by which to try.
        consignorUserId: session.id,
        clientRef: body.clientRef,
        productName: body.productName,
        offeredPriceThb: body.offeredPriceThb,
        quantity: body.quantity,
        notes: body.notes ?? null,
        attachments,
      }),
    );

    /*
     * 200 rather than 201 on a replay. The row exists, nothing changed, and a member
     * who double-tapped deserves an answer that says so instead of an error they would
     * answer by tapping again.
     */
    return ok(result, { status: result.duplicate ? 200 : 201 });
  });
}
