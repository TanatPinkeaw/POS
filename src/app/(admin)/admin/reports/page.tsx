import { ReportExportPanel, type ReportMeta } from '@/components/admin/ReportExportPanel';
import { REPORT_TITLES, REPORT_TYPES, reportColumns } from '@/lib/report-spec';
import { resolveReportRange } from '@/lib/reports';

/** SRS §2: financial analytics and exports are admin-only. */
export default function ReportsPage() {
  // Resolved on the server so the default range is always a Bangkok calendar
  // range, whatever timezone the admin's browser happens to be in.
  const range = resolveReportRange({});

  const reports: ReportMeta[] = REPORT_TYPES.map((type) => ({
    type,
    title: REPORT_TITLES[type],
    columns: reportColumns(type),
  }));

  return (
    <div className="d-flex flex-column gap-4">
      <div>
        <h4 className="mb-1">รายงานและส่งออกข้อมูล</h4>
        <p className="text-muted mb-0 small">
          ดาวน์โหลดเป็นไฟล์ Excel (.xlsx) ตามข้อกำหนด SRS §8 — หนึ่งไฟล์ต่อหนึ่งรายงาน
        </p>
      </div>

      <ReportExportPanel reports={reports} defaultFrom={range.from} defaultTo={range.to} />
    </div>
  );
}
