/**
 * Catalogue import (ADR 0002) — `POST /api/v1/products/import`.
 *
 * Accepts CSV or `.xlsx` as multipart form data, and does one of two things
 * depending on `mode`:
 *
 *   * `preview` (default) — reports exactly what the file would do: every row,
 *     every problem, whether each row creates or updates, and what stock becomes.
 *     Nothing is written.
 *   * `commit` — applies the file atomically.
 *
 * The file is uploaded twice, once per mode, rather than the server holding a
 * preview in memory between requests. That is deliberate: a pending import that
 * lives on the server has to be tied to a session, expired, and cleaned up, and
 * then the thing being committed is no longer the thing the renter approved.
 * Re-reading the same bytes is cheap, stateless, and cannot drift.
 *
 * Admin-only, like the rest of the catalogue.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { readTabularRows } from '@/lib/excel';
import { ValidationError } from '@/lib/errors';
import { commitProductImport, previewProductImport } from '@/lib/product-import';

/** ExcelJS needs Node APIs, so this route cannot run on the edge runtime. */
export const runtime = 'nodejs';

/** Always computed from live data; never cached. */
export const dynamic = 'force-dynamic';

/** A catalogue sheet this large is already unusual; the row ceiling is lower. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ValidationError('Send the file as multipart form data with a "file" field');
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new ValidationError('Attach a CSV or .xlsx file in the "file" field');
    }
    if (file.size === 0) {
      throw new ValidationError('That file is empty');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ValidationError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB`,
      );
    }

    const mode = form.get('mode') === 'commit' ? 'commit' : 'preview';
    const grid = await readTabularRows({
      buffer: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
    });

    if (grid.length === 0) {
      throw new ValidationError('That file contains no rows');
    }

    if (mode === 'commit') {
      // The file is re-parsed and re-validated here, so a commit can never apply
      // rows that the preview would have rejected.
      return { mode, summary: await commitProductImport(grid, session.id) };
    }

    return { mode, preview: await previewProductImport(grid) };
  });
}
