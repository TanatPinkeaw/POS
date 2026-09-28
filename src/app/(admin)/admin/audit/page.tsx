import { AuditTrail } from '@/components/admin/AuditTrail';
import { PageHeader, Stack } from '@/components/ds';
import { countAuditLogs, listAuditLogs } from '@/lib/audit';
import { requireShellUser } from '@/lib/shell';

/**
 * The audit trail (Phase F).
 *
 * Read-only, and it has no writer anywhere in the application — the table itself
 * refuses UPDATE and DELETE, so "who approved this" survives being asked months
 * later. Loaded on the server so the screen arrives with its first page rather
 * than with a spinner where the answer should be.
 */
export const dynamic = 'force-dynamic';

export default async function AdminAuditPage() {
  await requireShellUser(['admin']);

  const [entries, total] = await Promise.all([listAuditLogs(), countAuditLogs()]);

  return (
    <Stack gap="lg">
      <PageHeader
        title="ประวัติการใช้งาน"
        subtitle="ร่องรอยของรายการที่ต้องมีผู้อนุมัติ — บันทึกแล้วแก้หรือลบไม่ได้ ตรวจสอบย้อนหลังได้เสมอ"
      />

      <AuditTrail initialEntries={entries} initialTotal={total} />
    </Stack>
  );
}
