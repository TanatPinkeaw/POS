'use client';

/**
 * Report picker and downloader for the admin reports screen.
 *
 * The download goes through `fetch` + a blob URL rather than a plain
 * `window.location.assign`, because the endpoint can legitimately answer with a
 * JSON error (a 403 for a stale session, a 422 for a reversed range). Navigating
 * would replace the screen with that JSON; this way the message is shown inline
 * and the page stays put.
 */
import { useState } from 'react';

export interface ReportMeta {
  type: string;
  title: string;
  columns: string[];
}

export function ReportExportPanel({
  reports,
  defaultFrom,
  defaultTo,
}: {
  reports: ReportMeta[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const [type, setType] = useState(reports[0]?.type ?? 'sales_summary');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<string | null>(null);

  const selected = reports.find((report) => report.type === type);

  const download = async (): Promise<void> => {
    setError(null);
    setLastFile(null);

    if (from > to) {
      setError('วันเริ่มต้นต้องไม่หลังวันสิ้นสุด');
      return;
    }

    setBusy(true);
    try {
      const params = new URLSearchParams({ type, from, to });
      const response = await fetch(`/api/v1/reports/export?${params.toString()}`, {
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? `ดาวน์โหลดไม่สำเร็จ (${response.status})`);
        return;
      }

      const blob = await response.blob();
      const filename = filenameFromHeader(response.headers.get('content-disposition'))
        ?? `${type}_${from}_${to}.xlsx`;

      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      setLastFile(filename);
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row g-3">
      <div className="col-12 col-xl-5">
        <div className="card">
          <div className="card-header">
            <h5 className="card-title mb-0">เลือกช่วงข้อมูล</h5>
          </div>
          <div className="card-body d-flex flex-column gap-3">
            <div>
              <label htmlFor="report-type" className="form-label">
                ประเภทรายงาน
              </label>
              <select
                id="report-type"
                className="form-select"
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                {reports.map((report) => (
                  <option key={report.type} value={report.type}>
                    {report.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="row g-2">
              <div className="col-6">
                <label htmlFor="report-from" className="form-label">
                  ตั้งแต่วันที่
                </label>
                <input
                  id="report-from"
                  type="date"
                  className="form-control"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </div>
              <div className="col-6">
                <label htmlFor="report-to" className="form-label">
                  ถึงวันที่
                </label>
                <input
                  id="report-to"
                  type="date"
                  className="form-control"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </div>
            </div>

            <p className="text-muted small mb-0">
              วันที่นับตามเวลาประเทศไทย (UTC+7) และรวมวันสิ้นสุดทั้งวัน
            </p>

            {error && (
              <div className="alert alert-danger mb-0" role="alert">
                {error}
              </div>
            )}

            {lastFile && !error && (
              <div className="alert alert-success mb-0" role="alert">
                ดาวน์โหลดแล้ว: <code className="small">{lastFile}</code>
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void download()}
              disabled={busy}
            >
              {busy ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true" />
                  กำลังสร้างไฟล์…
                </>
              ) : (
                'ดาวน์โหลด Excel (.xlsx)'
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="col-12 col-xl-7">
        <div className="card h-100">
          <div className="card-header">
            <h5 className="card-title mb-0">คอลัมน์ในไฟล์</h5>
            <p className="text-muted mb-0 small">
              {selected?.title ?? ''} — ตรงตามข้อกำหนด SRS §8
            </p>
          </div>
          <div className="card-body">
            <div className="table-responsive">
              <table className="table table-sm mb-0">
                <thead>
                  <tr>
                    <th style={{ width: '3rem' }}>#</th>
                    <th>หัวคอลัมน์</th>
                  </tr>
                </thead>
                <tbody>
                  {(selected?.columns ?? []).map((column, index) => (
                    <tr key={column}>
                      <td className="text-muted">{index + 1}</td>
                      <td>{column}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Extracts the filename from a Content-Disposition header, if present. */
function filenameFromHeader(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const match = /filename="?([^";]+)"?/.exec(header);
  return match?.[1] ?? null;
}
