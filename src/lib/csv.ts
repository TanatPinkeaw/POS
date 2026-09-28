/**
 * CSV parsing.
 *
 * Hand-rolled rather than taken from a package: the shapes a renter actually
 * uploads are narrow (a header row plus plain values), and the edge cases that
 * bite are specific and testable — a leading byte-order mark from Excel, a file
 * saved with semicolons because the machine runs a Thai locale, CRLF line
 * endings, and quoted fields containing the delimiter.
 *
 * Pure: no Prisma, no `node:` imports.
 */

/** Candidates we can tell apart from the header line alone. */
const DELIMITERS = [',', ';', '\t'] as const;

export interface ParseCsvOptions {
  /** Force a delimiter instead of detecting one from the header line. */
  delimiter?: string;
}

/**
 * Splits CSV text into rows of fields.
 *
 * Quote handling follows RFC 4180: a doubled quote inside a quoted field is a
 * literal quote, and a delimiter inside quotes is data rather than a separator.
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): string[][] {
  // Strip the BOM Excel writes, and normalise line endings so the state machine
  // only ever has to think about \n.
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delimiter = options.delimiter ?? detectDelimiter(clean);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < clean.length) {
    const char = clean[index] as string;

    if (inQuotes) {
      if (char === '"') {
        if (clean[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // A file that does not end in a newline still has one last row.
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ''));
}

/**
 * Picks the delimiter from the header line.
 *
 * Counting only the header line matters: a product description may contain
 * commas, and letting the body vote would turn a semicolon-separated file into
 * a comma-separated one halfway through.
 */
export function detectDelimiter(text: string): string {
  const headerLine = text.split('\n', 1)[0] ?? '';

  let best: string = DELIMITERS[0];
  let bestCount = 0;

  for (const candidate of DELIMITERS) {
    const count = countOutsideQuotes(headerLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && char === delimiter) {
      count += 1;
    }
  }

  return count;
}

/**
 * Normalises a header cell into a lookup key.
 *
 * So that `ราคาทุน`, `Cost Price`, `cost_price` and `COST-PRICE` all reduce to
 * the same key, which lets the importer accept what a spreadsheet actually
 * contains rather than one blessed spelling.
 */
export function normaliseHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.]/g, '')
    .replace(/\(.*?\)/g, '');
}
