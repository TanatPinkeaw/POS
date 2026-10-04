/**
 * `POST /api/v1/consignment-submissions/:id/reject` — an owner turns a member's offer
 * down (ADR 0025).
 *
 * Admin only, and the note is required. The row is kept, not deleted: the member reads
 * the reason on their own account, and an owner later asking "why did we turn down
 * forty offers this month" has an answer for each one. A `DELETE` would be tidier and
 * would throw both of those away.
 *
 * Admin and not "whoever is signed in" because goods somebody else owns are a
 * liability, and who the shop declines to take on is the owner's call — the same call
 * `POST /api/v1/products/:id/consignment` makes when it *does* take them on.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { rejectSubmission } from '@/lib/consignment-intake';
import { prisma } from '@/lib/db';
import { consignmentRejectionSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const { id } = await context.params;
    const body = await readJson(request, consignmentRejectionSchema);

    return prisma.$transaction((tx) =>
      rejectSubmission(tx, { submissionId: id, actorId: session.id, note: body.note }),
    );
  });
}
