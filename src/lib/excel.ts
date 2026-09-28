/**
 * Excel workbook rendering and reading.
 *
 * Kept deliberately separate from the queries: this file knows only about
 * `ReportTable`, so a report can be tested (columns, rows, formatting of
 * numbers) without ever producing a spreadsheet.
 *
 * This is also the only module that imports ExcelJS, in either direction — the
 * renter-facing catalogue import reads workbooks through `readTabularRows`
 * rather than spreading the dependency across the codebase.
 */
import ExcelJS from 'exceljs';

import { parseCsv } from './csv';
import { ValidationError } from './errors';
import type { ReportTable } from './report-spec';

/**
 * Writes one `ReportTable` to a single-sheet `.xlsx` workbook.
 *
 * Numbers are written as numbers (not strings) so a manager can sum a column in
 * Excel, while every timestamp was already flattened to a Bangkok string by the
 * query layer. The header is frozen and auto-filtered because these sheets are
 * meant to be sorted, not just read.
 */
export async function renderReportWorkbook(table: ReportTable): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'POS Realtime';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(table.sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });

  sheet.columns = table.columns.map((header, index) => ({
    header,
    key: `column-${index}`,
    width: Math.max(12, Math.min(38, Math.max(header.length, 12) + 6)),
  }));

  for (const row of table.rows) {
    // `null` means "no value"; ExcelJS then leaves the cell truly empty rather
    // than writing the string "null".
    sheet.addRow(row.map((cell) => (cell === null ? undefined : cell)));
  }

  if (table.columns.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: table.columns.length },
    };
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF1F2937' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EDF5' } };
  headerRow.alignment = { vertical: 'middle' };
  headerRow.height = 20;

  // ExcelJS hands back an ArrayBuffer-backed buffer; returning it as-is lets the
  // route set it straight on the response body without a copy.
  return workbook.xlsx.writeBuffer();
}

/** Ceilings on an uploaded sheet, so one hostile file cannot exhaust memory. */
export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_COLUMNS = 40;

/**
 * Reads a CSV or `.xlsx` upload into a grid of strings.
 *
 * The format is decided by the bytes rather than the filename, because a
 * filename is only a claim: every `.xlsx` is a ZIP archive, so the `PK` magic
 * number is decisive, and a text file that merely *ends* in `.xlsx` gets a
 * clear error instead of being parsed as comma-separated gibberish.
 */
export async function readTabularRows(input: {
  buffer: Buffer;
  filename: string;
}): Promise<string[][]> {
  const name = input.filename.trim().toLowerCase();

  if (isZipArchive(input.buffer)) {
    return readXlsxRows(input.buffer);
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    throw new ValidationError(
      'That file is named .xlsx but is not a valid workbook. Re-save it from Excel and try again.',
    );
  }

  if (name.endsWith('.xls')) {
    throw new ValidationError(
      'The old .xls format cannot be read. In Excel use Save As, then choose .xlsx or CSV.',
    );
  }

  return parseCsv(input.buffer.toString('utf8'));
}

async function readXlsxRows(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();

  try {
    // ExcelJS ships its own Buffer declaration, which is structurally the same
    // as Node's but not assignable to it under TypeScript 5.9's generic Buffer.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new ValidationError('That workbook could not be opened. Is it a valid .xlsx file?');
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return [];
  }

  const rows: string[][] = [];
  sheet.eachRow((row) => {
    if (rows.length >= MAX_IMPORT_ROWS) {
      return;
    }
    const columnCount = Math.min(row.cellCount, MAX_IMPORT_COLUMNS);
    const cells: string[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      cells.push(cellToString(row.getCell(column).value));
    }
    rows.push(cells);
  });

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/**
 * A cell as text.
 *
 * ExcelJS models a value as a union — strings, numbers, dates, formulas with a
 * cached result, hyperlinks and rich text all arrive differently, and a cell the
 * renter typed as `฿12.50` may be either a number or text. Flattening here means
 * nothing downstream has to know which kind it received.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'object') {
    const cell = value as {
      text?: unknown;
      result?: unknown;
      richText?: { text: string }[];
    };
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((part) => part.text).join('');
    }
    if (cell.result !== undefined) {
      return cellToString(cell.result);
    }
    if (cell.text !== undefined) {
      return cellToString(cell.text);
    }
  }

  return String(value);
}

function isZipArchive(buffer: Buffer): boolean {
  return buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/**
 * Writes a plain grid, optionally with a second explanatory sheet.
 *
 * Used for the catalogue-import template, where the notes are not decoration: a
 * renter has to know whether the stock column is a count or an addition before
 * they fill it in, and the answer belongs next to the column.
 */
export async function renderGridWorkbook(input: {
  sheetName: string;
  headers: string[];
  rows: (string | number)[][];
  widths?: number[];
  notes?: { sheetName: string; lines: string[] };
}): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'POS Realtime';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(input.sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = input.headers.map((header, index) => ({
    header,
    key: `column-${index}`,
    width: input.widths?.[index] ?? Math.max(12, Math.min(38, header.length + 6)),
  }));

  for (const row of input.rows) {
    sheet.addRow(row);
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF1F2937' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EDF5' } };
  headerRow.height = 20;

  if (input.notes) {
    const notes = workbook.addWorksheet(input.notes.sheetName);
    notes.getColumn(1).width = 96;
    for (const line of input.notes.lines) {
      const row = notes.addRow([line]);
      row.alignment = { wrapText: true };
    }
  }

  return workbook.xlsx.writeBuffer();
}
