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

import {
  Button,
  Card,
  DataTable,
  FieldRow,
  InlineNotice,
  SelectField,
  SplitPane,
  Stack,
  TextField,
  type Column,
} from '@/components/ds';

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

  /*
   * The preview is a `DataTable` over numbered rows rather than a bare table, so
   * a long column list reflows into cards on a tablet instead of scrolling
   * sideways — the same treatment every other list on these screens gets.
   */
  const columnRows = (selected?.columns ?? []).map((name, index) => ({ n: index + 1, name }));

  const columnTable: Column<{ n: number; name: string }>[] = [
    { key: 'n', header: '#', cardLabel: 'ลำดับ', width: '3rem', render: (row) => row.n },
    { key: 'name', header: 'หัวคอลัมน์', render: (row) => row.name },
  ];

  return (
    /*
     * The form is the pane that holds its width and the preview takes the rest,
     * because the two are read differently: the controls are aimed at, the column
     * list is scanned. On a narrow screen the form comes first — it is the thing
     * you came here to do.
     */
    <SplitPane
      panelWidth="21rem"
      stackOrder="panel-first"
      panel={
        <Card
          title="เลือกช่วงข้อมูล"
          subtitle="เลือกประเภทรายงานและช่วงวันที่ แล้วดาวน์โหลดเป็นไฟล์ Excel"
        >
          <Stack gap="md">
            <SelectField
              id="report-type"
              label="ประเภทรายงาน"
              value={type}
              onChange={(event) => setType(event.target.value)}
            >
              {reports.map((report) => (
                <option key={report.type} value={report.type}>
                  {report.title}
                </option>
              ))}
            </SelectField>

            <FieldRow columns={2}>
              <TextField
                id="report-from"
                type="date"
                label="ตั้งแต่วันที่"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
              <TextField
                id="report-to"
                type="date"
                label="ถึงวันที่"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </FieldRow>

            <p className="ln-muted">
              วันที่นับตามเวลาประเทศไทย (UTC+7) และรวมวันสิ้นสุดทั้งวัน
            </p>

            {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

            {lastFile && !error ? (
              <InlineNotice tone="success">
                ดาวน์โหลดแล้ว: <code className="ln-mono">{lastFile}</code>
              </InlineNotice>
            ) : null}

            <Button block loading={busy} onClick={() => void download()}>
              ดาวน์โหลด Excel (.xlsx)
            </Button>
          </Stack>
        </Card>
      }
    >
      <Card
        title="คอลัมน์ในไฟล์"
        subtitle={`${selected?.title ?? ''} — ตรงตามข้อกำหนด SRS §8`}
        flush
      >
        <DataTable
          columns={columnTable}
          rows={columnRows}
          getRowKey={(row) => String(row.n)}
          caption="คอลัมน์ที่จะอยู่ในไฟล์ที่ดาวน์โหลด"
        />
      </Card>
    </SplitPane>
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
