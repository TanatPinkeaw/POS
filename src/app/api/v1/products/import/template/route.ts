/**
 * The catalogue-import template (ADR 0002).
 *
 * A downloaded workbook rather than a described format, because a renter who has
 * to build the header row from documentation will get one cell wrong and then
 * read a validation error instead of onboarding. The second sheet explains the
 * two columns whose semantics are not obvious from the name — the money columns
 * and the stock column, which is an *addition*.
 *
 * Admin-only, and a binary response, so it follows the report export's shape:
 * raw `NextResponse` on success, the shared `errorResponse` on failure.
 */
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { renderGridWorkbook } from '@/lib/excel';
import { IMPORT_COLUMNS } from '@/lib/import-spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function GET(): Promise<Response> {
  try {
    await requireRole(['admin']);

    const file = await renderGridWorkbook({
      sheetName: 'สินค้า',
      headers: IMPORT_COLUMNS.map((column) => column.header),
      rows: [
        IMPORT_COLUMNS.map((column) => column.example),
        IMPORT_COLUMNS.map((column) => (column.key === 'salePrice' ? 59 : '')),
      ],
      widths: IMPORT_COLUMNS.map((column) => column.width),
      notes: {
        sheetName: 'คำอธิบาย',
        lines: [
          'วิธีใช้ไฟล์นี้',
          '',
          '1. กรอกข้อมูลในชีต "สินค้า" โดยเริ่มจากแถวที่ 2 (แถวแรกเป็นหัวตาราง ห้ามลบ)',
          '2. ลบคอลัมน์ที่ไม่ใช้ได้ แต่ห้ามลบ "ชื่อสินค้า" และ "ราคาขาย"',
          '3. บันทึกเป็น .xlsx หรือ CSV แล้วอัปโหลดที่หน้า สินค้าและสต็อก → นำเข้าสินค้า',
          '4. ระบบจะแสดงตัวอย่างให้ตรวจก่อนทุกครั้ง ยังไม่บันทึกจนกว่าจะกดยืนยัน',
          '',
          'หัวตารางที่ระบบรู้จัก (ใช้อย่างใดอย่างหนึ่งได้)',
          ...IMPORT_COLUMNS.map(
            (column) => `• ${column.header}: ${column.description}`,
          ),
          '',
          'สิ่งที่ควรรู้',
          '• ถ้ามีบาร์โค้ด ระบบจะจับคู่สินค้าเดิมด้วยบาร์โค้ด ถ้าไม่มีจะใช้ชื่อสินค้า',
          '• สินค้าที่มีอยู่แล้วจะถูก "อัปเดต" ราคาและรายละเอียดตามไฟล์',
          '• คอลัมน์จำนวนสต็อกเป็นการ "บวกเพิ่ม" ทุกครั้งที่นำเข้า ไม่ใช่การตั้งทับ',
          '  (ระบบบันทึกไว้ในประวัติสต็อกทุกครั้ง เพื่อให้ตรวจย้อนหลังได้)',
          '• ทั้งไฟล์จะถูกบันทึกพร้อมกันทั้งหมด ถ้ามีแถวใดผิดจะไม่มีอะไรถูกบันทึกเลย',
        ],
      },
    });

    const filename = 'product-import-template.xlsx';
    return new NextResponse(file, {
      status: 200,
      headers: {
        'content-type': XLSX_MIME,
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(file.byteLength),
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
