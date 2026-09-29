/**
 * Borrowing numbers, and asking what is already borrowed — ADR 0019.
 *
 * A device that may lose its connection asks for a range of the shop's numbers *before*
 * it needs them, because the moment it cannot reach the server is the moment it cannot
 * ask. So this route is the till's, not the office's: an employee session opens the
 * block, and the row names the cashier who asked for it.
 *
 * `GET` is what the device reconciles itself against — a tablet reinstalled from a
 * backup, or one whose storage was cleared, has to be able to ask "what am I holding"
 * rather than guess from memory, because guessing wrong means printing numbers the shop
 * cannot place in its series afterwards.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { loadOpenNumberBlocks, openNumberBlock } from '@/lib/number-blocks';
import { openNumberBlockSchema } from '@/lib/schemas';

/** Every open block, both series: today's and tomorrow's call numbers, and the receipts. */
export async function GET(): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);

    return { blocks: await loadOpenNumberBlocks() };
  });
}

/**
 * Borrows a range.
 *
 * Refused (409) when a block of that series is already open — two loans of one range is
 * two customers called by the same number, or two tax invoices sharing a number — and the
 * refusal says which, because "close the earlier one first" and "report what you used"
 * are different next steps.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const body = await readJson(request, openNumberBlockSchema);

    return openNumberBlock({
      series: body.series,
      day: body.day ?? null,
      size: body.size,
      deviceLabel: body.deviceLabel,
      userId: session.id,
    });
  });
}
