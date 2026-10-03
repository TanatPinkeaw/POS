import { notFound } from 'next/navigation';

import {
  ConsignorPayouts,
  type ConsignorRow,
  type OpenDrawer,
} from '@/components/admin/ConsignorPayouts';
import {
  Card,
  DataTable,
  LinkButton,
  Money,
  PageHeader,
  Stack,
  Stat,
  type Column,
} from '@/components/ds';
import { bangkokDateString, bangkokDateTimeString } from '@/lib/bangkok-time';
import {
  getConsignorPosition,
  listConsignorLedger,
  listConsignorPositions,
  listPayoutsFor,
  loadPayoutStatement,
  payoutMethodLabel,
  type ConsignorLedgerLine,
  type ConsignorPayoutRow,
  type StatementLine,
} from '@/lib/consignment-payout';
import { prisma } from '@/lib/db';
import { requireShellUser } from '@/lib/shell';

/**
 * Consignors: what the shop owes them, one account, and one statement (ADR 0023 §6).
 *
 * One screen rather than three routes, and the account is a `searchParams` view of the
 * same page — the walk that keeps every screen styled fetches each route once and has no
 * way to invent a consignor id, so a `/consignors/[id]` route would be a screen the audit
 * could never walk. The list is the route; the account and its statement hang off it.
 *
 * Admin-only, enforced by the layout and by the payout API this page calls.
 */
export const dynamic = 'force-dynamic';

const LEDGER_KIND_LABELS: Record<ConsignorLedgerLine['kind'], string> = {
  sale: 'ขายได้',
  refund: 'คืนสินค้า',
  payout: 'จ่ายเงิน',
};

const STATEMENT_KIND_LABELS: Record<StatementLine['kind'], string> = {
  sale: 'ขายได้',
  refund: 'คืนสินค้า',
  payout: 'จ่ายเงิน',
};

type PageProps = { searchParams: Promise<{ consignor?: string; statement?: string }> };

export default async function AdminConsignorsPage({ searchParams }: PageProps) {
  await requireShellUser(['admin']);
  const params = await searchParams;

  if (params.statement) {
    return <StatementView payoutId={params.statement} />;
  }
  if (params.consignor) {
    return <ConsignorAccount consignorUserId={params.consignor} />;
  }

  const [positions, shifts] = await Promise.all([
    listConsignorPositions(),
    prisma.cash_shifts.findMany({
      where: { status: 'open' },
      orderBy: { id: 'asc' },
      include: { opener: { select: { full_name: true } } },
    }),
  ]);

  const rows: ConsignorRow[] = positions.map((position) => ({
    id: position.consignorUserId,
    fullName: position.fullName,
    phone: position.phone,
    balanceThb: position.balanceThb,
    // Formatted here so the browser's own time zone cannot shift the day.
    lastPaidOn: position.lastPaidAt ? bangkokDateString(position.lastPaidAt) : null,
  }));

  const openDrawers: OpenDrawer[] = shifts.map((shift) => ({
    id: shift.id,
    label: `ลิ้นชัก #${shift.id} · ${shift.opener.full_name}`,
  }));

  return (
    <Stack gap="lg">
      <PageHeader
        title="ฝากขาย — จ่ายเงินผู้ฝากขาย"
        subtitle="ยอดค้างจ่ายคือผลรวมบัญชีเจ้าหนี้ฝากขาย — จ่ายออกจากลิ้นชักที่เปิดอยู่ หรือโอนผ่านแอปธนาคาร พร้อมใบสำคัญและร่องรอยในประวัติ"
      />
      <ConsignorPayouts rows={rows} openDrawers={openDrawers} />
    </Stack>
  );
}

/** One consignor's account: what has moved, and what has been paid. */
async function ConsignorAccount({ consignorUserId }: { consignorUserId: string }) {
  const position = await getConsignorPosition(consignorUserId);
  if (!position) {
    notFound();
  }

  const [ledger, payouts] = await Promise.all([
    listConsignorLedger(consignorUserId),
    listPayoutsFor(consignorUserId),
  ]);

  const ledgerRows = [...ledger]
    .reverse()
    .map((line, index) => ({ ...line, key: `ledger-${index}` }));
  type LedgerRow = ConsignorLedgerLine & { key: string };

  const ledgerColumns: Column<LedgerRow>[] = [
    { key: 'at', header: 'เวลา', render: (row) => bangkokDateTimeString(row.at) },
    { key: 'kind', header: 'ประเภท', render: (row) => LEDGER_KIND_LABELS[row.kind] },
    { key: 'description', header: 'รายละเอียด', render: (row) => row.description ?? '—' },
    {
      key: 'amount',
      header: 'จำนวน',
      align: 'end',
      render: (row) => <Money amount={row.amountThb} signed />,
    },
  ];

  const payoutColumns: Column<ConsignorPayoutRow>[] = [
    { key: 'at', header: 'วันที่', render: (row) => bangkokDateString(row.createdAt) },
    { key: 'method', header: 'ช่องทาง', render: (row) => payoutMethodLabel(row.method) },
    {
      key: 'amount',
      header: 'จำนวน',
      align: 'end',
      render: (row) => <Money amount={row.amountThb} />,
    },
    { key: 'note', header: 'บันทึก', render: (row) => row.note ?? '—' },
    {
      key: 'statement',
      header: '',
      align: 'end',
      render: (row) => (
        <LinkButton
          href={`/admin/consignors?consignor=${consignorUserId}&statement=${row.payoutId}`}
          size="sm"
          variant="ghost"
        >
          ใบสำคัญ
        </LinkButton>
      ),
    },
  ];

  return (
    <Stack gap="lg">
      <PageHeader
        title={`บัญชีฝากขาย · ${position.fullName}`}
        subtitle={`${position.phone} · ${ledger.length} รายการในบัญชี · แก้ไขไม่ได้ ทำได้แค่บันทึกเพิ่ม`}
      />

      <Card>
        <Stat
          label="ยอดค้างจ่ายตอนนี้"
          value={<Money amount={position.balanceThb} size="lg" />}
          hint={
            position.lastPaidAt
              ? `จ่ายล่าสุด ${bangkokDateString(position.lastPaidAt)}`
              : 'ยังไม่เคยจ่าย'
          }
          tone={position.balanceThb > 0 ? 'warning' : 'neutral'}
          icon="cash"
        />
      </Card>

      <Card
        title="ความเคลื่อนไหวในบัญชี"
        subtitle="ขายได้เครดิต คืนสินค้าและจ่ายเงินหักออก — ยอดค้างคือผลรวม"
        flush
      >
        <DataTable
          columns={ledgerColumns}
          rows={ledgerRows}
          getRowKey={(row) => row.key}
          caption="ความเคลื่อนไหวทั้งหมดในบัญชีผู้ฝากขาย"
        />
      </Card>

      <Card title="ประวัติการจ่าย" subtitle="แต่ละครั้งมีใบสำคัญของตัวเอง" flush>
        <DataTable
          columns={payoutColumns}
          rows={payouts}
          getRowKey={(row) => row.payoutId}
          caption="ประวัติการจ่ายเงินให้ผู้ฝากขาย"
        />
      </Card>

      <LinkButton href="/admin/consignors" variant="secondary" icon="arrowLeft">
        กลับไปหน้ารวมผู้ฝากขาย
      </LinkButton>
    </Stack>
  );
}

/** The statement a payout produced: the movements it settles, and the amount. */
async function StatementView({ payoutId }: { payoutId: string }) {
  const statement = await loadPayoutStatement(payoutId);
  if (!statement) {
    notFound();
  }

  const statementRows = statement.lines.map((line, index) => ({
    ...line,
    key: `statement-${index}`,
  }));
  type StatementRow = StatementLine & { key: string };

  const columns: Column<StatementRow>[] = [
    { key: 'at', header: 'เวลา', render: (row) => bangkokDateTimeString(row.at) },
    { key: 'kind', header: 'ประเภท', render: (row) => STATEMENT_KIND_LABELS[row.kind] },
    { key: 'description', header: 'รายละเอียด', render: (row) => row.description ?? '—' },
    {
      key: 'amount',
      header: 'จำนวน',
      align: 'end',
      render: (row) => <Money amount={row.amountThb} signed />,
    },
  ];

  return (
    <Stack gap="lg">
      <PageHeader
        title={`ใบสำคัญจ่ายเงิน · ${statement.consignorName}`}
        subtitle={`จ่ายเมื่อ ${bangkokDateTimeString(statement.createdAt)} · ${payoutMethodLabel(statement.method)}`}
      />

      <Card>
        <Stat
          label="ยอดที่จ่ายครั้งนี้"
          value={<Money amount={statement.amountThb} size="lg" />}
          hint={
            statement.balanceAfterThb === 0
              ? 'ปิดยอดครบแล้ว — ไม่มีค้างจ่ายเหลือ'
              : `คงเหลือค้างจ่าย ${statement.balanceAfterThb.toFixed(2)} บาท`
          }
          tone="success"
          icon="cash"
        />
      </Card>

      <Card
        title="รายการที่จ่ายในงวดนี้"
        subtitle="ยอดยกมา + รายการด้านล่าง − ยอดที่จ่าย = ยอดคงเหลือ"
        flush
      >
        <DataTable
          columns={columns}
          rows={statementRows}
          getRowKey={(row) => row.key}
          caption="รายการที่ใบสำคัญนี้ครอบคลุม"
        />
      </Card>

      <Card>
        <Stack gap="sm">
          <p className="ln-muted">ยอดยกมางวดนี้ {statement.openingBalanceThb.toFixed(2)} บาท</p>
          <p className="ln-muted">ยอดที่จ่าย {statement.amountThb.toFixed(2)} บาท</p>
          <p className="ln-muted">ยอดคงเหลือ {statement.balanceAfterThb.toFixed(2)} บาท</p>
          {statement.note ? <p className="ln-muted">บันทึก: {statement.note}</p> : null}
        </Stack>
      </Card>

      <LinkButton
        href={`/admin/consignors?consignor=${statement.consignorUserId}`}
        variant="secondary"
        icon="arrowLeft"
      >
        กลับไปบัญชีผู้ฝากขาย
      </LinkButton>
    </Stack>
  );
}

