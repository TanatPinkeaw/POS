'use client';

/**
 * Catalogue import (ADR 0002).
 *
 * Typing 300 SKUs into a web form is the reason a renter would not switch, so
 * this screen exists to make the spreadsheet they already have the input.
 *
 * The interaction is deliberately two-step: choosing a file only *checks* it, and
 * the confirmation button is a separate, informed action showing exactly what
 * will be created, updated, overwritten and added to stock. Importing a
 * catalogue is not something anyone should discover they did.
 *
 * The preview is a `DataTable`, which means the same hundred rows are readable as a
 * table on a desktop and as one card per row on a tablet — the screen an operator
 * actually checks a supplier's price list on.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  Button,
  Card,
  DataTable,
  InlineNotice,
  Pill,
  Stack,
  TextField,
  Toolbar,
  type Column,
} from '@/components/ds';
import { ApiError, apiUpload, downloadFile } from '@/lib/client-api';
import type { ImportPreviewRow } from '@/lib/product-import';

interface PreviewPayload {
  mapping: Record<string, number>;
  issues: { field: string; message: string }[];
  rows: ImportPreviewRow[];
  createCount: number;
  updateCount: number;
  invalidCount: number;
  stockAddedTotal: number;
}

interface CommitPayload {
  created: number;
  updated: number;
  stockAddedTotal: number;
  skipped: number;
}

/** Only this many preview rows are rendered; the rest are summarised. */
const PREVIEW_LIMIT = 100;

export function ProductImportPanel() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [summary, setSummary] = useState<CommitPayload | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | 'template' | null>(null);

  function pick(selected: File | null): void {
    setFile(selected);
    setPreview(null);
    setSummary(null);
    setNotice(null);
  }

  async function send(mode: 'preview' | 'commit'): Promise<void> {
    if (!file) {
      setNotice({ tone: 'danger', text: 'เลือกไฟล์ก่อน' });
      return;
    }

    setNotice(null);
    setBusy(mode);
    const form = new FormData();
    form.append('file', file);
    form.append('mode', mode);

    try {
      const result = await apiUpload<{ mode: string; preview?: PreviewPayload; summary?: CommitPayload }>(
        '/api/v1/products/import',
        form,
      );

      if (mode === 'commit' && result.summary) {
        setSummary(result.summary);
        setPreview(null);
        setFile(null);
        setNotice({
          tone: 'success',
          text: `นำเข้าแล้ว: เพิ่มใหม่ ${result.summary.created} · อัปเดต ${result.summary.updated} · สต็อกที่บวกเข้า ${result.summary.stockAddedTotal}`,
        });
        router.refresh();
      } else if (result.preview) {
        setPreview(result.preview);
        setSummary(null);
      }
    } catch (error) {
      setNotice({
        tone: 'danger',
        text: error instanceof ApiError ? error.message : 'อ่านไฟล์ไม่สำเร็จ',
      });
    } finally {
      setBusy(null);
    }
  }

  async function downloadTemplate(): Promise<void> {
    setBusy('template');
    try {
      await downloadFile('/api/v1/products/import/template', 'product-import-template.xlsx');
    } catch (error) {
      setNotice({
        tone: 'danger',
        text: error instanceof Error ? error.message : 'ดาวน์โหลดไม่สำเร็จ',
      });
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<ImportPreviewRow>[] = [
    {
      key: 'line',
      header: 'บรรทัด',
      cardLabel: 'บรรทัด',
      render: (row) => <span className="ln-num ln-muted">{row.line}</span>,
    },
    {
      key: 'name',
      header: 'ชื่อสินค้า',
      cardLabel: 'ชื่อสินค้า',
      render: (row) => (
        <>
          <span>{row.name || '—'}</span>
          {row.barcode ? <span className="ln-mono ln-muted">{row.barcode}</span> : null}
        </>
      ),
    },
    {
      key: 'category',
      header: 'หมวด',
      render: (row) => row.categoryName ?? '—',
    },
    {
      key: 'price',
      header: 'ราคาขาย',
      align: 'end',
      render: (row) => <span className="ln-num">{row.salePrice.toFixed(2)}</span>,
    },
    {
      key: 'stock',
      header: 'สต็อก',
      align: 'end',
      render: (row) =>
        row.stockQty === 0 ? (
          <span className="ln-muted">—</span>
        ) : (
          <>
            <span className="ln-num">+{row.stockQty}</span>
            <span className="ln-num ln-muted">เป็น {row.resultingStock}</span>
          </>
        ),
    },
    {
      key: 'action',
      header: 'การทำงาน',
      cardLabel: 'การทำงาน',
      render: (row) =>
        row.issues.length > 0 ? (
          <ul className="ln-list">
            {row.issues.map((issue) => (
              <li key={`${row.line}-${issue.field}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        ) : (
          <span className="ln-row">
            <Pill tone={row.action === 'create' ? 'success' : 'info'}>
              {row.action === 'create' ? 'เพิ่มใหม่' : 'อัปเดต'}
            </Pill>
            {row.changesPrice ? <Pill tone="warning">ทับราคาเดิม</Pill> : null}
          </span>
        ),
    },
  ];

  const visibleRows = preview?.rows.slice(0, PREVIEW_LIMIT) ?? [];
  const importable = preview ? preview.createCount + preview.updateCount : 0;

  return (
    <Card
      title="นำเข้าสินค้าจากไฟล์"
      subtitle="รองรับ CSV และ Excel (.xlsx) — ใช้ไฟล์สต็อกที่มีอยู่ได้เลย"
      toolbar={
        <Toolbar
          actions={
            <>
              <Button
                variant="secondary"
                loading={busy === 'preview'}
                disabled={busy !== null || !file}
                onClick={() => void send('preview')}
              >
                ตรวจสอบไฟล์
              </Button>
              <Button
                variant="ghost"
                icon="download"
                loading={busy === 'template'}
                disabled={busy !== null}
                onClick={() => void downloadTemplate()}
              >
                ดาวน์โหลดไฟล์ตัวอย่าง
              </Button>
            </>
          }
        >
          <TextField
            id="import-file"
            label="ไฟล์สินค้า"
            hideLabel
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => pick(event.target.files?.[0] ?? null)}
          />
        </Toolbar>
      }
    >
      <Stack gap="md">
        {!preview && !summary ? (
          <p className="ln-muted">
            คอลัมน์ที่ต้องมี: <strong>ชื่อสินค้า</strong> และ <strong>ราคาขาย</strong> — ที่เหลือใส่หรือไม่ใส่ก็ได้
            ระบบจะแสดงตัวอย่างให้ตรวจก่อนบันทึกเสมอ
          </p>
        ) : null}

        {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}

        {preview && preview.issues.length > 0 ? (
          <InlineNotice tone="danger" title="อ่านไฟล์ไม่ได้">
            <ul className="ln-list">
              {preview.issues.map((issue) => (
                <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          </InlineNotice>
        ) : null}

        {preview && preview.issues.length === 0 ? (
          <>
            <span className="ln-row">
              <Pill tone="success">เพิ่มใหม่ {preview.createCount}</Pill>
              <Pill tone="info">อัปเดต {preview.updateCount}</Pill>
              <Pill tone={preview.invalidCount > 0 ? 'danger' : 'neutral'}>
                ใช้ไม่ได้ {preview.invalidCount}
              </Pill>
              <Pill tone="warning">สต็อกที่จะบวกเข้า {preview.stockAddedTotal}</Pill>
            </span>

            <DataTable
              columns={columns}
              rows={visibleRows}
              getRowKey={(row) => String(row.line)}
              caption="ตัวอย่างข้อมูลจากไฟล์ก่อนบันทึก"
              highlightRow={(row) => row.issues.length > 0}
            />

            {preview.rows.length > PREVIEW_LIMIT ? (
              <p className="ln-muted">
                แสดง {PREVIEW_LIMIT} จาก {preview.rows.length} บรรทัด — ยอดรวมด้านบนนับครบทุกบรรทัด
              </p>
            ) : null}

            <div className="ln-row">
              <Button
                loading={busy === 'commit'}
                disabled={busy !== null || importable === 0}
                onClick={() => void send('commit')}
              >
                ยืนยันนำเข้า {importable} รายการ
              </Button>
              <span className="ln-muted">
                {preview.invalidCount > 0
                  ? `แถวที่ใช้ไม่ได้ ${preview.invalidCount} แถวจะถูกข้าม ส่วนที่เหลือบันทึกพร้อมกันในครั้งเดียว`
                  : 'แถวที่เหลือจะถูกบันทึกพร้อมกันในครั้งเดียว'}
              </span>
            </div>
          </>
        ) : null}

        {summary ? (
          <InlineNotice tone="success" title="นำเข้าเสร็จแล้ว">
            เพิ่มใหม่ {summary.created} · อัปเดต {summary.updated} · บวกสต็อก {summary.stockAddedTotal}
            {summary.skipped > 0 ? ` · ข้าม ${summary.skipped} แถวที่ใช้ไม่ได้` : ''}
          </InlineNotice>
        ) : null}
      </Stack>
    </Card>
  );
}
