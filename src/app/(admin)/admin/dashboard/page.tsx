import { OrderActions } from '@/components/admin/OrderActions';
import {
  Card,
  CardGrid,
  DataTable,
  EmptyState,
  Money,
  PageHeader,
  Pill,
  Stack,
  Stat,
  StatusPill,
  TrendChart,
  type Column,
} from '@/components/ds';
import { dashboardSnapshot } from '@/lib/analytics';
import { shortThaiDay, type TrendPoint } from '@/lib/chart';
import { formatThb } from '@/lib/money';

/**
 * Sales dashboard and financial analytics — SRS §2, admin-only.
 *
 * The chart is rendered here, on the server, and ships as SVG: a figure made of
 * data the page already has is not worth a charting library in the browser, and
 * the axis maths it used to delegate lives in `src/lib/chart.ts` where it is
 * tested.
 */

const STATUS_LABEL: Record<string, string> = {
  pending: 'รอยืนยัน',
  confirmed: 'กำลังเตรียม',
  ready_for_pickup: 'พร้อมรับ',
  completed: 'สำเร็จ',
  cancelled: 'ยกเลิก',
  refunded: 'คืนเงินแล้ว',
};

const PREORDER_STAGES = [
  { status: 'pending', label: '1. รอยืนยัน', key: 'pending' },
  { status: 'confirmed', label: '2. กำลังเตรียม', key: 'confirmed' },
  { status: 'ready_for_pickup', label: '3. พร้อมรับ', key: 'readyForPickup' },
  { status: 'completed', label: '4. ปิดการขายวันนี้', key: 'completedToday' },
  { status: 'cancelled', label: 'ยกเลิก/หมดอายุวันนี้', key: 'cancelledToday' },
] as const;

export default async function DashboardPage() {
  const snapshot = await dashboardSnapshot();

  const points: TrendPoint[] = snapshot.salesByDay.map((day) => ({
    label: shortThaiDay(day.day),
    value: day.salesThb,
    secondary: day.orderCount,
    caption: `${shortThaiDay(day.day)} · ${formatThb(day.salesThb)} · ${day.orderCount} ออเดอร์`,
  }));

  type StockRow = (typeof snapshot.lowStock)[number];
  type OrderRow = (typeof snapshot.recentOrders)[number];

  const lowStockColumns: Column<StockRow>[] = [
    {
      key: 'name',
      header: 'สินค้า',
      cardLabel: 'สินค้า',
      render: (row) => (
        <>
          <span>{row.name}</span>
          {row.barcode ? <span className="ln-mono">{row.barcode}</span> : null}
        </>
      ),
    },
    {
      key: 'stock',
      header: 'คงเหลือ',
      align: 'end',
      render: (row) => row.stockQty,
    },
    {
      key: 'reserved',
      header: 'จองไว้',
      align: 'end',
      render: (row) => row.reservedQty,
    },
    {
      key: 'available',
      header: 'ขายได้',
      align: 'end',
      render: (row) => (
        <Pill tone={row.availableQty <= 0 ? 'danger' : 'warning'}>{row.availableQty}</Pill>
      ),
    },
  ];

  const recentOrderColumns: Column<OrderRow>[] = [
    {
      key: 'number',
      header: 'เลขที่',
      cardLabel: 'เลขที่',
      render: (row) => <span className="ln-mono">{row.orderNumber}</span>,
    },
    {
      key: 'type',
      header: 'ประเภท',
      render: (row) => (
        <Pill tone={row.orderType === 'preorder' ? 'brand' : 'neutral'}>
          {row.orderType === 'preorder' ? 'ออนไลน์' : 'หน้าร้าน'}
        </Pill>
      ),
    },
    {
      key: 'status',
      header: 'สถานะ',
      render: (row) => (
        <StatusPill status={row.status} label={STATUS_LABEL[row.status] ?? row.status} />
      ),
    },
    {
      key: 'cashier',
      header: 'พนักงาน',
      render: (row) => row.cashierName ?? '—',
    },
    {
      key: 'amount',
      header: 'ยอด',
      align: 'end',
      render: (row) => <Money amount={row.finalAmountThb} />,
    },
    {
      key: 'documents',
      header: '',
      cardLabel: 'เอกสาร',
      align: 'end',
      render: (row) => (
        /*
         * One control for the three document operations a row can offer. It
         * decides what to show from the order's own status — a completed sale can
         * be refunded, a refunded one has a credit note, an unpaid one has
         * nothing — which is knowledge that belongs beside the state machine
         * rather than duplicated per screen.
         */
        <OrderActions
          orderId={row.id}
          orderNumber={row.orderNumber}
          status={row.status}
          amountThb={row.finalAmountThb}
          lineCount={row.itemCount}
        />
      ),
    },
  ];

  return (
    <Stack gap="lg">
      <PageHeader
        title="ภาพรวมวันนี้"
        subtitle="ข้อมูลสดจากฐานข้อมูล — ยอดขายเป็นยอดรวมก่อนหักการคืนเงิน"
      />

      <CardGrid min="15rem">
        <Card>
          <Stat
            label="ยอดขายวันนี้"
            value={<Money amount={snapshot.today.salesThb} />}
            hint={`${snapshot.today.orderCount} ออเดอร์ · ก่อนหักคืนเงิน`}
            icon="chart"
          />
        </Card>
        {/*
          Refunds get their own figure rather than being netted into the sales
          one, because a refund is an event on the day it happens: a bill paid on
          Monday and reversed on Friday belongs in Monday's takings and in
          Friday's refunds, and a single netted number could not say both.
        */}
        <Card>
          <Stat
            label="คืนเงินวันนี้"
            value={<Money amount={snapshot.today.refundsThb} />}
            hint={
              snapshot.today.refundCount === 0
                ? 'ยังไม่มีการคืนเงินวันนี้'
                : `${snapshot.today.refundCount} ใบลดหนี้ · สุทธิ ${formatThb(snapshot.today.netSalesThb)}`
            }
            tone={snapshot.today.refundsThb > 0 ? 'warning' : 'neutral'}
            icon="refresh"
          />
        </Card>
        <Card>
          <Stat
            label="เงินสดในลิ้นชัก"
            value={<Money amount={snapshot.today.cashThb} />}
            hint={
              snapshot.today.cashRefundedThb > 0
                ? `หักเงินสดที่คืนแล้ว ${formatThb(snapshot.today.cashRefundedThb)}`
                : 'เฉพาะที่ชำระด้วยเงินสด'
            }
            tone="success"
            icon="cash"
          />
        </Card>
        <Card>
          <Stat
            label="พร้อมเพย์"
            value={<Money amount={snapshot.today.promptpayThb} />}
            hint="ไม่นับเป็นเงินสดตอนปิดกะ · หักที่คืนแล้ว"
            tone="info"
            icon="qr"
          />
        </Card>
        <Card>
          <Stat
            label="มูลค่าสต็อก (ทุน)"
            value={<Money amount={snapshot.catalogue.stockValueAtCostThb} />}
            hint={`${snapshot.catalogue.activeProducts} รายการ · จองไว้ ${snapshot.catalogue.reservedUnits} ชิ้น`}
            tone="warning"
            icon="box"
          />
        </Card>
      </CardGrid>

      <Card title="ยอดขาย 7 วันย้อนหลัง" subtitle="แท่งคือยอดขาย (บาท) · เส้นคือจำนวนออเดอร์">
        <TrendChart points={points} primaryLabel="ยอดขาย (บาท)" secondaryLabel="จำนวนออเดอร์" />
      </Card>

      <CardGrid min="22rem">
        <Card title="พรีออเดอร์ตามขั้นตอน" subtitle="SRS §3 — วงจร 4 ขั้นตอน" flush>
          <DataTable
            columns={[
              {
                key: 'stage',
                header: 'ขั้นตอน',
                render: (row: (typeof PREORDER_STAGES)[number]) => (
                  <StatusPill status={row.status} label={row.label} />
                ),
              },
              {
                key: 'count',
                header: 'จำนวน',
                align: 'end',
                render: (row) => <strong className="ln-num">{snapshot.preOrders[row.key]}</strong>,
              },
            ]}
            rows={[...PREORDER_STAGES]}
            getRowKey={(row) => row.status}
            caption="จำนวนออเดอร์พรีออเดอร์ในแต่ละขั้นตอน"
          />
        </Card>

        <Card
          title="สินค้าใกล้หมด"
          subtitle="นับจากจำนวนที่ขายได้จริง (คงเหลือ − จองไว้)"
          flush
        >
          <DataTable
            columns={lowStockColumns}
            rows={snapshot.lowStock}
            getRowKey={(row) => String(row.id)}
            caption="สินค้าที่เหลือขายได้ไม่เกินห้าชิ้น"
            empty={<EmptyState icon="check" title="สต็อกทุกรายการเพียงพอ" />}
          />
        </Card>
      </CardGrid>

      <Card title="ออเดอร์ล่าสุด" subtitle="ทุกช่องทาง ทั้งหน้าร้านและออนไลน์" flush>
        <DataTable
          columns={recentOrderColumns}
          rows={snapshot.recentOrders}
          getRowKey={(row) => String(row.id)}
          caption="ออเดอร์ล่าสุดสิบรายการ"
          empty={
            <EmptyState
              title="ยังไม่มีออเดอร์"
              description="เริ่มขายที่หน้าร้านเพื่อดูข้อมูลที่นี่"
            />
          }
        />
      </Card>
    </Stack>
  );
}
