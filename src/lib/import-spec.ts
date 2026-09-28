/**
 * Catalogue import — the shape of the spreadsheet a renter uploads.
 *
 * Pure, and deliberately separate from `product-import.ts`, which owns the
 * database: every rule about what counts as a valid row can be tested by passing
 * a grid of strings, with no database and no file.
 *
 * The design goal is that one person with a stocktake spreadsheet can load their
 * catalogue without help. That means accepting the headers they already have
 * (`ราคาทุน`, `Cost Price`, `cost_price` all mean the same column), tolerating the
 * way Excel writes money (`฿1,250.00`), and reporting *every* problem in the file
 * at once rather than failing on the first — a renter who has to re-upload 300
 * rows to find the second typo will give up.
 */
import { normaliseHeader } from './csv';

export type ImportField =
  | 'barcode'
  | 'name'
  | 'category'
  | 'costPrice'
  | 'salePrice'
  | 'stockQty'
  | 'description'
  | 'imageUrl';

export interface ImportColumn {
  key: ImportField;
  /** The header the downloadable template uses. */
  header: string;
  /** Normalised spellings accepted from an existing sheet. */
  aliases: string[];
  required: boolean;
  example: string | number;
  width: number;
  /** Shown on the template's second sheet. */
  description: string;
}

export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  {
    key: 'barcode',
    header: 'บาร์โค้ด',
    aliases: ['barcode', 'บาร์โคด'],
    required: false,
    example: '8850999112233',
    width: 18,
    description:
      'ถ้ามี จะใช้จับคู่สินค้าเดิมเพื่ออัปเดต ถ้าว่างระบบจะจับคู่ด้วยชื่อสินค้าแทน',
  },
  {
    key: 'name',
    header: 'ชื่อสินค้า',
    aliases: ['name', 'product', 'productname', 'ชื่อ', 'ชื่อสินค้า', 'สินค้า'],
    required: true,
    example: 'กาแฟคั่วบด 250 ก.',
    width: 32,
    description: 'จำเป็นต้องมี',
  },
  {
    key: 'category',
    header: 'หมวดหมู่',
    aliases: ['category', 'หมวด', 'หมวดหมู่', 'ประเภท'],
    required: false,
    example: 'เครื่องดื่ม',
    width: 18,
    description: 'ถ้ายังไม่มีหมวดนี้ ระบบจะสร้างให้อัตโนมัติ',
  },
  {
    key: 'costPrice',
    header: 'ราคาทุน',
    aliases: ['costprice', 'cost', 'ราคาทุน', 'ต้นทุน', 'ราคาต้นทุน'],
    required: false,
    example: 95,
    width: 12,
    description: 'ตัวเลข ไม่ใส่ก็ได้ (ค่าเริ่มต้น 0)',
  },
  {
    key: 'salePrice',
    header: 'ราคาขาย',
    aliases: ['saleprice', 'price', 'ราคาขาย', 'ราคา', 'ราคาขายปลีก'],
    required: true,
    example: 140,
    width: 12,
    description: 'จำเป็นต้องมี ราคาที่ลูกค้าจ่าย (รวม VAT ถ้าร้านจดทะเบียน VAT)',
  },
  {
    key: 'stockQty',
    header: 'จำนวนสต็อก',
    aliases: ['stockqty', 'stock', 'qty', 'quantity', 'จำนวน', 'สต็อก', 'คงเหลือ'],
    required: false,
    example: 24,
    width: 14,
    description:
      'จำนวนที่นับได้ตอนนี้ ระบบจะ "บวกเพิ่ม" เข้าสต็อกและบันทึกไว้ในประวัติสต็อกทุกครั้ง (ไม่ใช่การตั้งทับ)',
  },
  {
    key: 'description',
    header: 'รายละเอียด',
    aliases: ['description', 'รายละเอียด', 'คำอธิบาย', 'หมายเหตุ'],
    required: false,
    example: 'คั่วกลาง 250 กรัม',
    width: 28,
    description: 'ข้อความอิสระ',
  },
  {
    key: 'imageUrl',
    header: 'URL รูปภาพ',
    aliases: ['imageurl', 'image', 'imageurl', 'รูปภาพ', 'ลิงก์รูป'],
    required: false,
    example: '',
    width: 24,
    description: 'ลิงก์รูปสินค้า ถ้ามี',
  },
] as const;

/** A single reason a row cannot be imported. */
export interface ImportIssue {
  /** Which column, or the row as a whole. */
  field: ImportField | 'row';
  message: string;
}

export interface ImportRow {
  /** Line number in the uploaded file, counting the header as line 1. */
  line: number;
  barcode: string | null;
  name: string;
  categoryName: string | null;
  costPrice: number;
  salePrice: number;
  stockQty: number;
  description: string | null;
  imageUrl: string | null;
  issues: ImportIssue[];
}

export interface ParsedImport {
  rows: ImportRow[];
  /** Problems with the file itself, not with any one row. */
  issues: ImportIssue[];
  validRows: ImportRow[];
  invalidRows: ImportRow[];
  /** Which spreadsheet column index each field was found in, for the preview. */
  mapping: Partial<Record<ImportField, number>>;
}

/**
 * Reads a grid whose first row is the header into validated rows.
 *
 * Never throws on bad *data*: a malformed cell becomes an issue on its row, so
 * the caller can show the whole file at once. It only reports a file-level
 * problem when a required column is absent, because then no row can be judged.
 */
export function parseImportGrid(grid: string[][]): ParsedImport {
  const headerRow = grid[0];
  if (!headerRow || grid.length === 0) {
    return {
      rows: [],
      issues: [{ field: 'row', message: 'ไฟล์ว่างเปล่า — ยังไม่มีข้อมูลให้อ่าน' }],
      validRows: [],
      invalidRows: [],
      mapping: {},
    };
  }

  const mapping = mapHeaders(headerRow);
  const issues: ImportIssue[] = [];

  for (const column of IMPORT_COLUMNS) {
    if (column.required && mapping[column.key] === undefined) {
      issues.push({
        field: column.key,
        message: `ไม่พบคอลัมน์ "${column.header}" ในหัวตาราง`,
      });
    }
  }

  if (issues.length > 0) {
    return { rows: [], issues, validRows: [], invalidRows: [], mapping };
  }

  const rows: ImportRow[] = [];
  const seenBarcodes = new Map<string, number>();

  for (let index = 1; index < grid.length; index += 1) {
    const cells = grid[index] ?? [];
    const line = index + 1;
    const value = (field: ImportField): string => {
      const columnIndex = mapping[field];
      return columnIndex === undefined ? '' : (cells[columnIndex] ?? '').trim();
    };

    const rowIssues: ImportIssue[] = [];
    const name = value('name');
    if (name === '') {
      rowIssues.push({ field: 'name', message: 'ต้องระบุชื่อสินค้า' });
    }
    if (name.length > 150) {
      rowIssues.push({ field: 'name', message: 'ชื่อสินค้ายาวเกิน 150 ตัวอักษร' });
    }

    const barcode = value('barcode') === '' ? null : value('barcode');
    if (barcode !== null && barcode.length > 64) {
      rowIssues.push({ field: 'barcode', message: 'บาร์โค้ดยาวเกิน 64 ตัวอักษร' });
    }
    if (barcode !== null) {
      const firstSeen = seenBarcodes.get(barcode);
      if (firstSeen !== undefined) {
        rowIssues.push({
          field: 'barcode',
          message: `บาร์โค้ดซ้ำกับบรรทัดที่ ${firstSeen} ในไฟล์เดียวกัน`,
        });
      } else {
        seenBarcodes.set(barcode, line);
      }
    }

    const salePrice = parseAmount(value('salePrice'));
    if (salePrice === null) {
      rowIssues.push({
        field: 'salePrice',
        message: `ราคาขาย "${value('salePrice')}" ไม่ใช่ตัวเลข`,
      });
    } else if (salePrice < 0) {
      rowIssues.push({ field: 'salePrice', message: 'ราคาขายติดลบไม่ได้' });
    } else if (salePrice > 99_999_999.99) {
      rowIssues.push({ field: 'salePrice', message: 'ราคาขายเกินขอบเขตที่ระบบรองรับ' });
    }

    const costPriceText = value('costPrice');
    const costPrice = costPriceText === '' ? 0 : parseAmount(costPriceText);
    if (costPrice === null || costPrice < 0) {
      rowIssues.push({
        field: 'costPrice',
        message: `ราคาทุน "${costPriceText}" ไม่ใช่ตัวเลขที่ใช้ได้`,
      });
    }

    const stockText = value('stockQty');
    const stockQty = stockText === '' ? 0 : parseCount(stockText);
    if (stockQty === null || stockQty < 0) {
      rowIssues.push({
        field: 'stockQty',
        message: `จำนวนสต็อก "${stockText}" ต้องเป็นจำนวนเต็มที่ไม่ติดลบ`,
      });
    }

    rows.push({
      line,
      barcode,
      name,
      categoryName: value('category') === '' ? null : value('category'),
      costPrice: costPrice ?? 0,
      salePrice: salePrice ?? 0,
      stockQty: stockQty ?? 0,
      description: value('description') === '' ? null : value('description'),
      imageUrl: value('imageUrl') === '' ? null : value('imageUrl'),
      issues: rowIssues,
    });
  }

  const validRows = rows.filter((row) => row.issues.length === 0);
  const invalidRows = rows.filter((row) => row.issues.length > 0);

  if (rows.length === 0) {
    issues.push({ field: 'row', message: 'ไฟล์มีหัวตารางแต่ไม่มีข้อมูลสินค้า' });
  }

  return { rows, issues, validRows, invalidRows, mapping };
}

/** Which grid column each known field lives in. */
export function mapHeaders(headerRow: string[]): Partial<Record<ImportField, number>> {
  const mapping: Partial<Record<ImportField, number>> = {};
  const normalisedHeaders = headerRow.map(normaliseHeader);

  for (const column of IMPORT_COLUMNS) {
    const candidates = new Set([normaliseHeader(column.header), ...column.aliases.map(normaliseHeader)]);
    const index = normalisedHeaders.findIndex((header) => header !== '' && candidates.has(header));
    if (index >= 0) {
      mapping[column.key] = index;
    }
  }

  return mapping;
}

/** The header row matched against every accepted spelling. */
export function headerMatchesField(header: string, field: ImportField): boolean {
  const column = IMPORT_COLUMNS.find((candidate) => candidate.key === field);
  if (!column) {
    return false;
  }
  const normalised = normaliseHeader(header);
  return (
    normalised === normaliseHeader(column.header) ||
    column.aliases.some((alias) => normaliseHeader(alias) === normalised)
  );
}

/**
 * Parses a money cell.
 *
 * Excel hands over `140` for a numeric cell but `"฿1,250.00"` for one typed as
 * text, and a Thai keyboard can produce full-width or Thai digits, so all three
 * are reduced before the number is read. Returns null when nothing sensible
 * remains, which the caller reports as a row issue.
 */
export function parseAmount(raw: string): number | null {
  const cleaned = toAsciiDigits(raw)
    .replace(/[฿$,\s]/g, '')
    .replace(/บาท/g, '')
    .trim();

  if (cleaned === '') {
    return 0;
  }
  if (!/^-?\d*(\.\d+)?$/.test(cleaned)) {
    return null;
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return null;
  }
  // Two decimal places, the same precision the column stores.
  return Math.round(value * 100) / 100;
}

/** Parses a whole-number cell (a stock count). */
export function parseCount(raw: string): number | null {
  const amount = parseAmount(raw);
  if (amount === null) {
    return null;
  }
  return Number.isInteger(amount) ? amount : null;
}

/**
 * Maps Thai, Arabic-Indic and Persian digits onto ASCII.
 *
 * A stocktake sheet typed on a Thai keyboard can contain `๒๔` where 24 was
 * meant, and `Number('๒๔')` is NaN — silently turning a stock count into a
 * validation error the renter cannot see the cause of.
 */
export function toAsciiDigits(raw: string): string {
  return raw.replace(/[\u0E50-\u0E59\u0660-\u0669\u06F0-\u06F9]/g, (digit) => {
    const code = digit.charCodeAt(0);
    if (code >= 0x0e50) {
      return String(code - 0x0e50);
    }
    if (code >= 0x0660 && code <= 0x0669) {
      return String(code - 0x0660);
    }
    return String(code - 0x06f0);
  });
}
