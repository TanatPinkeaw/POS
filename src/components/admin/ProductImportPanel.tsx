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
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Alert, Badge, Card } from '@/components/hope/ui';
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

  const visibleRows = preview?.rows.slice(0, PREVIEW_LIMIT) ?? [];

  return (
    <Card
      title="นำเข้าสินค้าจากไฟล์"
      subtitle="รองรับ CSV และ Excel (.xlsx) — ใช้ไฟล์สต็อกที่มีอยู่ได้เลย"
    >
      <div className="d-flex flex-wrap align-items-end gap-2 mb-3">
        <div>
          <label className="form-label small" htmlFor="import-file">
            ไฟล์สินค้า
          </label>
          <input
            id="import-file"
            name="importFile"
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="form-control form-control-sm"
            onChange={(event) => pick(event.target.files?.[0] ?? null)}
          />
        </div>
        <button
          type="button"
          className="btn btn-sm btn-soft-primary"
          disabled={busy !== null || !file}
          onClick={() => void send('preview')}
        >
          {busy === 'preview' ? 'กำลังตรวจสอบ…' : 'ตรวจสอบไฟล์'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-soft-secondary"
          disabled={busy !== null}
          onClick={() =>
            void (async () => {
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
            })()
          }
        >
          ดาวน์โหลดไฟล์ตัวอย่าง
        </button>
      </div>

      {!preview && !summary && (
        <p className="text-muted small mb-0">
          คอลัมน์ที่ต้องมี: <strong>ชื่อสินค้า</strong> และ <strong>ราคาขาย</strong> — ที่เหลือใส่หรือไม่ใส่ก็ได้
          ระบบจะแสดงตัวอย่างให้ตรวจก่อนบันทึกเสมอ
        </p>
      )}

      {notice && (
        <Alert tone={notice.tone} className="mt-3">
          {notice.text}
        </Alert>
      )}

      {preview && preview.issues.length > 0 && (
        <Alert tone="danger" className="mt-3">
          <p className="mb-1 fw-medium">อ่านไฟล์ไม่ได้</p>
          <ul className="mb-0 small">
            {preview.issues.map((issue) => (
              <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      {preview && preview.issues.length === 0 && (
        <>
          <div className="d-flex flex-wrap gap-2 mb-3">
            <Badge tone="success">เพิ่มใหม่ {preview.createCount}</Badge>
            <Badge tone="info">อัปเดต {preview.updateCount}</Badge>
            <Badge tone={preview.invalidCount > 0 ? 'danger' : 'secondary'}>
              ใช้ไม่ได้ {preview.invalidCount}
            </Badge>
            <Badge tone="warning">สต็อกที่จะบวกเข้า {preview.stockAddedTotal}</Badge>
          </div>

          <div className="table-responsive" style={{ maxHeight: 380 }}>
            <table className="table table-sm align-middle">
              <thead>
                <tr>
                  <th scope="col">บรรทัด</th>
                  <th scope="col">ชื่อสินค้า</th>
                  <th scope="col">หมวด</th>
                  <th scope="col" className="text-end">
                    ราคาขาย
                  </th>
                  <th scope="col" className="text-end">
                    สต็อก
                  </th>
                  <th scope="col">การทำงาน</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.line} className={row.issues.length > 0 ? 'table-danger' : ''}>
                    <td className="pos-numeric text-muted">{row.line}</td>
                    <td>
                      {row.name || <span className="text-muted">—</span>}
                      {row.barcode && <span className="text-muted small d-block">{row.barcode}</span>}
                    </td>
                    <td className="small text-muted">{row.categoryName ?? '—'}</td>
                    <td className="text-end pos-numeric">{row.salePrice.toFixed(2)}</td>
                    <td className="text-end pos-numeric">
                      {row.stockQty === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <>
                          +{row.stockQty}
                          <span className="text-muted small d-block">เป็น {row.resultingStock}</span>
                        </>
                      )}
                    </td>
                    <td className="small">
                      {row.issues.length > 0 ? (
                        <ul className="mb-0 ps-3 text-danger">
                          {row.issues.map((issue) => (
                            <li key={`${row.line}-${issue.field}-${issue.message}`}>{issue.message}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="d-flex flex-wrap gap-1 align-items-center">
                          <Badge tone={row.action === 'create' ? 'success' : 'info'}>
                            {row.action === 'create' ? 'เพิ่มใหม่' : 'อัปเดต'}
                          </Badge>
                          {row.changesPrice && <Badge tone="warning">ทับราคาเดิม</Badge>}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.rows.length > PREVIEW_LIMIT && (
            <p className="text-muted small">
              แสดง {PREVIEW_LIMIT} จาก {preview.rows.length} บรรทัด — ยอดรวมด้านบนนับครบทุกบรรทัด
            </p>
          )}

          <div className="d-flex flex-wrap align-items-center gap-3 mt-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null || preview.createCount + preview.updateCount === 0}
              onClick={() => void send('commit')}
            >
              {busy === 'commit' ? 'กำลังนำเข้า…' : `ยืนยันนำเข้า ${preview.createCount + preview.updateCount} รายการ`}
            </button>
            <span className="text-muted small">
              {preview.invalidCount > 0
                ? `แถวที่ใช้ไม่ได้ ${preview.invalidCount} แถวจะถูกข้าม ส่วนที่เหลือบันทึกพร้อมกันในครั้งเดียว`
                : 'แถวที่เหลือจะถูกบันทึกพร้อมกันในครั้งเดียว'}
            </span>
          </div>
        </>
      )}

      {summary && (
        <Alert tone="success" className="mt-3 mb-0">
          นำเข้าเสร็จแล้ว — เพิ่มใหม่ {summary.created} · อัปเดต {summary.updated} · บวกสต็อก{' '}
          {summary.stockAddedTotal}
          {summary.skipped > 0 ? ` · ข้าม ${summary.skipped} แถวที่ใช้ไม่ได้` : ''}
        </Alert>
      )}
    </Card>
  );
}
