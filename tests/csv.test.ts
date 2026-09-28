// Seam under test: reading a renter's spreadsheet.
//
// Every case here is one that actually reached the parser from a real
// spreadsheet: Excel's byte-order mark, a Windows locale saving semicolons, CRLF
// endings, a product name containing a comma, and Thai digits from a Thai
// keyboard.
import { describe, expect, it } from 'vitest';

import { detectDelimiter, normaliseHeader, parseCsv } from '@/lib/csv';
import { mapHeaders, parseAmount, parseCount, parseImportGrid, toAsciiDigits } from '@/lib/import-spec';

describe('parseCsv', () => {
  it('splits a simple sheet', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a delimiter that is inside quotes', () => {
    expect(parseCsv('name,note\nกาแฟ,"ร้อน, ไม่ใส่น้ำตาล"')).toEqual([
      ['name', 'note'],
      ['กาแฟ', 'ร้อน, ไม่ใส่น้ำตาล'],
    ]);
  });

  it('treats a doubled quote as one literal quote', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([['a'], ['say "hi"']]);
  });

  it('strips the byte-order mark Excel writes', () => {
    const rows = parseCsv('\uFEFFชื่อ,ราคา\nกาแฟ,50');
    expect(rows[0]).toEqual(['ชื่อ', 'ราคา']);
    expect(rows[1]?.[0]).toBe('กาแฟ'.replace('\uFEFF', ''));
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('drops blank trailing lines rather than emitting an empty row', () => {
    expect(parseCsv('a\n1\n\n')).toHaveLength(2);
  });

  it('detects a semicolon-separated header', () => {
    expect(detectDelimiter('ชื่อ;ราคา;สต็อก\nกาแฟ;50;10')).toBe(';');
    expect(parseCsv('ชื่อ;ราคา\nกาแฟ;50')).toEqual([
      ['ชื่อ', 'ราคา'],
      ['กาแฟ', '50'],
    ]);
  });

  it('ignores commas in the body when choosing a delimiter', () => {
    // The header says semicolon; a description with commas must not change that.
    expect(detectDelimiter('name;note\nกาแฟ;ร้อน, หอม, หวาน')).toBe(';');
  });
});

describe('normaliseHeader', () => {
  it('reduces the ways one English column might be written to a single key', () => {
    const keys = ['Cost Price', 'cost_price', 'COST-PRICE', '  cost price  '].map(normaliseHeader);

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('costprice');
  });

  it('leaves a Thai header as its own key', () => {
    // Thai and English spellings are bridged by each column's alias list, not by
    // translation, so "ราคาทุน" must stay itself rather than being mangled into
    // a shape that could collide with an unrelated column.
    expect(normaliseHeader('ราคาทุน')).toBe('ราคาทุน');
  });
});

describe('number parsing', () => {
  it('reads money the way Excel and a Thai keyboard write it', () => {
    expect(parseAmount('140')).toBe(140);
    expect(parseAmount('฿1,250.00')).toBe(1250);
    expect(parseAmount('1,234.5')).toBe(1234.5);
    expect(parseAmount('')).toBe(0);
  });

  it('reads Thai digits, which Number() would reject', () => {
    expect(toAsciiDigits('๒๔')).toBe('24');
    expect(parseAmount('๒๔')).toBe(24);
    expect(parseCount('๑๐๐')).toBe(100);
  });

  it('rejects text rather than silently importing a zero price', () => {
    expect(parseAmount('หนึ่งร้อย')).toBeNull();
    expect(parseCount('12.5')).toBeNull();
  });
});

describe('parseImportGrid', () => {
  const HEADER = ['บาร์โค้ด', 'ชื่อสินค้า', 'หมวดหมู่', 'ราคาทุน', 'ราคาขาย', 'จำนวนสต็อก'];

  it('maps the Thai template headers', () => {
    const parsed = parseImportGrid([HEADER, ['885001', 'กาแฟ', 'เครื่องดื่ม', '95', '140', '24']]);

    expect(parsed.issues).toEqual([]);
    expect(parsed.validRows).toHaveLength(1);
    expect(parsed.validRows[0]).toMatchObject({
      line: 2,
      barcode: '885001',
      name: 'กาแฟ',
      categoryName: 'เครื่องดื่ม',
      costPrice: 95,
      salePrice: 140,
      stockQty: 24,
    });
  });

  it('accepts English headers for the same columns', () => {
    const parsed = parseImportGrid([
      ['Barcode', 'Name', 'Category', 'Cost Price', 'Sale Price', 'Stock'],
      ['885002', 'Tea', 'Drinks', '10', '20', '5'],
    ]);

    expect(parsed.issues).toEqual([]);
    expect(parsed.validRows).toHaveLength(1);
    expect(parsed.validRows[0]?.salePrice).toBe(20);
  });

  it('reports a missing required column instead of importing garbage', () => {
    const parsed = parseImportGrid([['บาร์โค้ด', 'ชื่อสินค้า'], ['1', 'กาแฟ']]);

    expect(parsed.issues.map((issue) => issue.field)).toContain('salePrice');
    expect(parsed.rows).toEqual([]);
  });

  it('marks each bad row with a reason and keeps the good ones', () => {
    const parsed = parseImportGrid([
      HEADER,
      ['1', 'กาแฟ', '', '', '140', '10'],
      ['2', '', '', '', '50', '5'],
      ['3', 'ชา', '', '', 'ไม่ใช่ตัวเลข', '5'],
      ['4', 'นม', '', '', '20', '1.5'],
      ['5', 'ขนม', '', '', '30', '7'],
    ]);

    expect(parsed.validRows.map((row) => row.name)).toEqual(['กาแฟ', 'ขนม']);
    expect(parsed.invalidRows).toHaveLength(3);
    expect(parsed.invalidRows[0]?.issues[0]?.field).toBe('name');
    expect(parsed.invalidRows[1]?.issues[0]?.field).toBe('salePrice');
    expect(parsed.invalidRows[2]?.issues[0]?.field).toBe('stockQty');
  });

  it('refuses a row whose ราคาขาย is blank instead of importing it at zero', () => {
    const parsed = parseImportGrid([
      HEADER,
      ['1', 'กาแฟ', '', '', '', '10'],
      ['2', 'ชา', '', '', '20', '5'],
    ]);

    expect(parsed.validRows.map((row) => row.name)).toEqual(['ชา']);
    expect(parsed.invalidRows).toHaveLength(1);
    expect(parsed.invalidRows[0]?.issues[0]).toEqual({
      field: 'salePrice',
      message: 'ต้องระบุราคาขาย',
    });
  });

  it('still treats a blank ราคาทุน as zero, because only the price is required', () => {
    const parsed = parseImportGrid([HEADER, ['1', 'กาแฟ', '', '', '20', '5']]);

    expect(parsed.invalidRows).toEqual([]);
    expect(parsed.validRows[0]?.costPrice).toBe(0);
  });

  it('flags a barcode repeated inside the same file', () => {
    const parsed = parseImportGrid([
      HEADER,
      ['885001', 'กาแฟ', '', '', '140', '1'],
      ['885001', 'กาแฟอีกอัน', '', '', '150', '1'],
    ]);

    expect(parsed.validRows).toHaveLength(1);
    expect(parsed.invalidRows[0]?.issues[0]?.message).toContain('บรรทัดที่ 2');
  });

  it('explains an empty file rather than returning nothing at all', () => {
    expect(parseImportGrid([]).issues[0]?.message).toContain('ไฟล์ว่างเปล่า');
    expect(parseImportGrid([HEADER]).issues[0]?.message).toContain('ไม่มีข้อมูลสินค้า');
  });

  it('reports which column each field was found in', () => {
    const mapping = mapHeaders(HEADER);
    expect(mapping.name).toBe(1);
    expect(mapping.stockQty).toBe(5);
  });
});
