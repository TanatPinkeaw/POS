import { InboundDismissButton } from '@/components/admin/InboundDismissButton';
import { OrderActions } from '@/components/admin/OrderActions';
import { NumberLoanRecovery } from '@/components/admin/NumberLoanRecovery';
import { loadOpenNumberBlocks } from '@/lib/number-blocks';
import {
  Card,
  CardGrid,
  DataTable,
  LinkButton,
  EmptyState,
  InlineNotice,
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
import { bangkokDateTimeString, bangkokDayBounds } from '@/lib/bangkok-time';
import { shortThaiDay, type TrendPoint } from '@/lib/chart';
import { inboundDaySummary, listInboundTransfers } from '@/lib/inbound-payments';
import { reconcileTransfers } from '@/lib/inbound-reconcile';
import {
  INBOUND_REFUSAL_LABELS,
  RECONCILE_VERDICTS,
  type InboundTransferView,
} from '@/lib/inbound-transfer-view';
import { formatThb } from '@/lib/money';
import { listAbandonedNotifications, outboxHealth } from '@/lib/notify-outbox';
import { closedTransferTotals, listAwaitingCollection } from '@/lib/payment-intents';
import type { AwaitingCollectionView } from '@/lib/payment-intents-view';
import { requireShellUser } from '@/lib/shell';

/**
 * Sales dashboard and financial analytics — SRS §2, admin-only.
 *
 * The chart is rendered here, on the server, and ships as SVG: a figure made of
 * data the page already has is not worth a charting library in the browser, and
 * the axis maths it used to delegate lives in `src/lib/chart.ts` where it is
 * tested.
 */

/**
 * What each kind of queued message is, in the words a manager uses.
 * A map rather than a template string, so an unknown kind shows its own name
 * instead of a sentence with a hole in it.
 */
const NOTIFICATION_KIND_LABELS: Record<string, string> = {
  pre_order_placed: 'พรีออเดอร์ใหม่',
  order_ready: 'ของพร้อมรับ',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'รอยืนยัน',
  confirmed: 'กำลังเตรียม',
  ready_for_pickup: 'พร้อมรับ',
  completed: 'สำเร็จ',
  cancelled: 'ยกเลิก',
  refunded: 'คืนเงินแล้ว',
};

/**
 * Enough of a bank notification to recognise it, without a wall of prose in a
 * table cell. The whole text is in the record, and in the dismiss dialog, for
 * whoever has to read it properly.
 */
function shorten(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) {
    return '—';
  }
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const PREORDER_STAGES = [
  { status: 'pending', label: '1. รอยืนยัน', key: 'pending' },
  { status: 'confirmed', label: '2. กำลังเตรียม', key: 'confirmed' },
  { status: 'ready_for_pickup', label: '3. พร้อมรับ', key: 'readyForPickup' },
  { status: 'completed', label: '4. ปิดการขายวันนี้', key: 'completedToday' },
  { status: 'cancelled', label: 'ยกเลิก/หมดอายุวันนี้', key: 'cancelledToday' },
] as const;

export default async function DashboardPage() {
  /*
   * Employees may read this page (ADR 0022), so the role decides whether the
   * admin-only controls render. The API would refuse them anyway — but a button
   * that answers 403 is a button that should not have been there, and hiding it is
   * what makes "read-only" true in the UI rather than only on the server.
   */
  const user = await requireShellUser(['admin', 'employee']);
  const isAdmin = user.role === 'admin';

  /*
   * Money the bank reported that this system could not attribute to a bill. Read
   * here rather than inside the snapshot because it is not a figure on a chart —
   * it is a to-do, and the only thing that makes the automatic confirmation path
   * safe to run: a notification that cannot be matched has to end up somewhere a
   * person will see it.
   */
  const dayBounds = bangkokDayBounds();
  /*
   * Notifications that gave up, read here for the same reason the unattributed
   * transfers are: a message that never arrived is invisible from inside the
   * system that queued it. Six failed attempts is a wrong gateway URL, and the
   * only place a shop will find that out is a screen like this one.
   */
  const [snapshot, unattributed, inboundToday, closedToday, awaiting, outbox, undelivered, loans] =
    await Promise.all([
      dashboardSnapshot(),
      listInboundTransfers(),
      inboundDaySummary(),
      closedTransferTotals(dayBounds),
      listAwaitingCollection(),
      outboxHealth(),
      listAbandonedNotifications(),
      loadOpenNumberBlocks(),
    ]);

  /*
   * The day's transfers, read two ways: what the bank confirmed, and what actually
   * closed a bill. Where they disagree the screen says which side is larger and
   * names the two normal causes — because a shop that confirms transfers by hand
   * has no notifications at all, and that is not a fault. What it *cannot* say is
   * "nothing is wrong", which is why the transfers themselves are listed under it.
   */
  const reconciled = reconcileTransfers({
    confirmedThb: inboundToday.matchedThb,
    closedThb: closedToday.amountThb,
  });
  const hasTransferNews =
    inboundToday.matchedCount + closedToday.count + awaiting.length > 0;

  const points: TrendPoint[] = snapshot.salesByDay.map((day) => ({
    label: shortThaiDay(day.day),
    value: day.salesThb,
    secondary: day.orderCount,
    caption: `${shortThaiDay(day.day)} · ${formatThb(day.salesThb)} · ${day.orderCount} ออเดอร์`,
  }));

  type StockRow = (typeof snapshot.lowStock)[number];
  type OrderRow = (typeof snapshot.recentOrders)[number];
  type InboundRow = InboundTransferView;

  const awaitingColumns: Column<AwaitingCollectionView>[] = [
    {
      key: 'ref',
      header: 'รหัสรับเงิน',
      cardLabel: 'รหัสรับเงิน',
      render: (row) => <span className="ln-mono">{row.ref}</span>,
    },
    {
      key: 'amount',
      header: 'ยอดที่ลูกค้าโอน',
      align: 'end',
      render: (row) => <Money amount={row.amountThb} />,
    },
    {
      key: 'paidAt',
      header: 'ธนาคารยืนยันเมื่อ',
      cardLabel: 'ธนาคารยืนยันเมื่อ',
      render: (row) => <span className="ln-num">{bangkokDateTimeString(new Date(row.paidAt))}</span>,
    },
    {
      key: 'waiting',
      header: 'รอมาแล้ว',
      cardLabel: 'รอมาแล้ว',
      render: (row) => (
        <Pill tone={row.waitingMinutes >= 60 ? 'danger' : 'warning'}>
          {row.waitingMinutes < 60
            ? `${row.waitingMinutes} นาที`
            : `${Math.floor(row.waitingMinutes / 60)} ชม.`}
        </Pill>
      ),
    },
    {
      key: 'cashier',
      header: 'แคชเชียร์',
      render: (row) => row.cashierName ?? '—',
    },
  ];

  const inboundColumns: Column<InboundRow>[] = [
    {
      key: 'receivedAt',
      header: 'เวลาเข้า',
      cardLabel: 'เวลาเข้า',
      render: (row) => <span className="ln-num">{bangkokDateTimeString(row.receivedAt)}</span>,
    },
    {
      key: 'amount',
      header: 'จำนวน',
      align: 'end',
      // Not `Money`: an amount that could not be read is not zero, and formatting
      // it as one would put a number on the screen that nobody ever sent.
      render: (row) =>
        row.amountThb === null ? (
          <Pill tone="warning">อ่านยอดไม่ได้</Pill>
        ) : (
          <Money amount={row.amountThb} />
        ),
    },
    {
      key: 'reason',
      header: 'เหตุที่ยังจับคู่ไม่ได้',
      cardLabel: 'เหตุที่ยังจับคู่ไม่ได้',
      render: (row) =>
        row.refusalReason ? INBOUND_REFUSAL_LABELS[row.refusalReason] : '—',
    },
    {
      key: 'text',
      header: 'ข้อความจากธนาคาร',
      cardLabel: 'ข้อความจากธนาคาร',
      render: (row) => <span className="ln-mono">{shorten(row.rawText)}</span>,
    },
    {
      key: 'action',
      header: '',
      cardLabel: 'จัดการ',
      align: 'end',
      // Dismissing money the bank sent is an admin act.
      render: (row) => (isAdmin ? <InboundDismissButton transfer={row} /> : null),
    },
  ];

  type UndeliveredRow = (typeof undelivered)[number];
  const undeliveredColumns: Column<UndeliveredRow>[] = [
    {
      key: 'kind',
      header: 'ข้อความ',
      cardLabel: 'ข้อความ',
      render: (row) => NOTIFICATION_KIND_LABELS[row.kind] ?? row.kind,
    },
    {
      key: 'recipient',
      header: 'ปลายทาง',
      cardLabel: 'ปลายทาง',
      render: (row) => <span className="ln-mono">{row.recipient}</span>,
    },
    {
      key: 'attempts',
      header: 'ลองแล้ว',
      cardLabel: 'ลองแล้ว',
      align: 'end',
      render: (row) => <span className="ln-num">{row.attempts} ครั้ง</span>,
    },
    {
      key: 'error',
      header: 'สาเหตุที่ผู้ให้บริการแจ้ง',
      cardLabel: 'สาเหตุ',
      render: (row) => <span className="ln-mono">{shorten(row.lastError ?? '—', 60)}</span>,
    },
  ];

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

  type ShortageRow = (typeof snapshot.stockShortages)[number];
  const shortageColumns: Column<ShortageRow>[] = [
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
      header: 'คงเหลือในระบบ',
      cardLabel: 'คงเหลือในระบบ',
      align: 'end',
      /* Negative and shown as it is: the number is the size of the disagreement with the shelf. */
      render: (row) => <Pill tone="danger">{row.stockQty}</Pill>,
    },
    {
      key: 'reserved',
      header: 'จองไว้',
      align: 'end',
      render: (row) => <span className="ln-num">{row.reservedQty}</span>,
    },
    {
      key: 'updated',
      header: 'แก้ล่าสุดเมื่อ',
      cardLabel: 'แก้ล่าสุดเมื่อ',
      render: (row) => (
        <span className="ln-num">{bangkokDateTimeString(row.updatedAt)}</span>
      ),
    },
    {
      key: 'action',
      header: '',
      cardLabel: 'จัดการ',
      align: 'end',
      render: () => (
        isAdmin ? (
          <LinkButton href="/admin/products" size="sm">
            ปรับสต็อก
          </LinkButton>
        ) : null
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
        isAdmin ? (
          <OrderActions
            orderId={row.id}
            orderNumber={row.orderNumber}
            status={row.status}
            amountThb={row.finalAmountThb}
            lineCount={row.itemCount}
          />
        ) : null
      ),
    },
  ];

  return (
    <Stack gap="lg">
      <PageHeader
        title="ภาพรวมวันนี้"
        subtitle="ข้อมูลสดจากฐานข้อมูล — ยอดขายเป็นยอดรวมก่อนหักการคืนเงิน"
      />

      {isAdmin && loans.length ? <Card title="ชุดเลขออฟไลน์ที่ยังไม่คืน" subtitle="ชุดที่เปิดอยู่จะหยุดการออกเลขจากเครื่องอื่น — ให้เครื่องเดิมส่งบิลและคืนเลขก่อน ใช้กู้คืนเฉพาะเมื่อเครื่องกลับมาไม่ได้">
        <Stack gap="md">
          {loans.map((loan) => <div key={loan.id} className="ln-row">
            <span>{loan.deviceLabel} · {loan.kind === 'receipt' ? 'ใบกำกับภาษี' : `คิว ${loan.day}`} · {loan.from}–{loan.to} · บันทึกใช้ถึง {loan.lastUsed ?? '—'}</span>
            <NumberLoanRecovery loan={{ id: loan.id, deviceLabel: loan.deviceLabel, kind: loan.kind, day: loan.day, from: loan.from, to: loan.to, lastUsed: loan.lastUsed }} />
          </div>)}
        </Stack>
      </Card> : null}

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
            label="มูลค่าสต็อกของร้าน (ทุน)"
            value={<Money amount={snapshot.catalogue.stockValueAtCostThb} />}
            hint={`${snapshot.catalogue.ownedProducts} รายการของร้าน · จองไว้ ${snapshot.catalogue.reservedUnits} ชิ้น`}
            tone="warning"
            icon="box"
          />
        </Card>
      </CardGrid>

      {/*
        Consigned goods are somebody else's, so their figures sit in their own card rather
        than beside the owned ones: filing a consignor's stock — or the debt it created —
        under the shop's own numbers is the reporting mistake ADR 0023 §7 exists to stop.
        The card appears only when the shop actually has consignments to show.
      */}
      {snapshot.consignment.productCount > 0 || snapshot.consignment.sharesOwedThb !== 0 ? (
        <Card
          title="สินค้าฝากขาย"
          subtitle="แยกจากของร้าน — ของเป็นของผู้ฝากขาย และยอดค้างจ่ายคือผลรวมของบัญชีผู้ฝากขาย (ADR 0023)"
        >
          <CardGrid min="13rem">
            <Stat
              label="สินค้าฝากขาย"
              value={<strong className="ln-num">{snapshot.consignment.productCount}</strong>}
              hint={`${snapshot.consignment.units} ชิ้นอยู่บนชั้น`}
              icon="box"
            />
            <Stat
              label="มูลค่าของฝากขาย (ทุน)"
              value={<Money amount={snapshot.consignment.stockValueAtCostThb} />}
              hint="ไม่นับรวมในมูลค่าสต็อกของร้าน"
              tone="info"
              icon="box"
            />
            <Stat
              label="ยอดค้างจ่ายผู้ฝากขาย"
              value={<Money amount={snapshot.consignment.sharesOwedThb} />}
              hint="ผลรวมบัญชีเจ้าหนี้ผู้ฝากขาย — ยังไม่ได้จ่าย"
              tone={snapshot.consignment.sharesOwedThb > 0 ? 'warning' : 'neutral'}
              icon="cash"
            />
          </CardGrid>
        </Card>
      ) : null}

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

      {/*
        Negative stock — the task a day of offline selling can leave behind (ADR 0019). The
        device sold from a snapshot, the shelf turned out to be shorter, and the bill was
        accepted because the customer already had the goods. This is the only way a negative
        count is reachable, so the card says so rather than leaving a manager to wonder what
        they did wrong — and it disappears when the count is corrected, which is why there is
        no dismiss button.
      */}
      {snapshot.stockShortages.length > 0 ? (
        <Card
          title="สต็อกติดลบ — ต้องนับของจริง"
          subtitle="เกิดจากการขายออฟไลน์เกินของที่นับไว้ บิลถูกบันทึกไปแล้วเพราะของถึงมือลูกค้า · นับของจริงแล้วปรับสต็อกให้ตรง"
          flush
        >
          <DataTable
            columns={shortageColumns}
            rows={snapshot.stockShortages}
            getRowKey={(row) => String(row.id)}
            caption="สินค้าที่คงเหลือในระบบติดลบ"
          />
        </Card>
      ) : null}

      {/*
        The reconciliation, rendered only on a day that had transfers. Everything
        on it is read from the same two sources the till writes — the bank's
        confirmation and the QR that closed — so an owner comparing a statement can
        do it here rather than from two lists.
      */}
      {hasTransferNews ? (
        <Card
          title="เงินโอนเข้าวันนี้"
          subtitle="เงินที่ธนาคารยืนยัน เทียบกับบิลที่ปิดด้วยการโอน — พร้อมรายการที่ยังต้องตาม"
        >
          <Stack gap="lg">
            <Stat
              label="ธนาคารยืนยัน"
              value={<Money amount={reconciled.confirmedThb} />}
              hint={`${inboundToday.matchedCount} รายการ`}
              icon="cash"
            />
            <Stat
              label="ปิดบิลด้วยการโอน"
              value={<Money amount={reconciled.closedThb} />}
              hint={`${closedToday.count} บิล`}
              icon="check"
            />
            <InlineNotice
              tone={reconciled.verdict === 'balanced' ? 'success' : 'warning'}
              title={
                reconciled.verdict === 'balanced'
                  ? 'ยอดโอนตรงกับบิลที่ปิด'
                  : `ต่างกัน ${formatThb(Math.abs(reconciled.differenceThb))}`
              }
            >
              {RECONCILE_VERDICTS[reconciled.verdict]}
            </InlineNotice>

            {awaiting.length > 0 ? (
              <DataTable
                columns={awaitingColumns}
                rows={awaiting}
                getRowKey={(row) => row.ref}
                caption="เงินที่ลูกค้าโอนแล้วแต่ยังไม่ปิดบิล"
              />
            ) : null}
          </Stack>
        </Card>
      ) : null}

      {/*
        Rendered only when there is something to do, and that is a judgement: an
        empty "no unattributed transfers" card every day would teach an owner to
        skip the one card that means money is sitting in the bank with no bill
        behind it.
      */}
      {unattributed.length > 0 ? (
        <Card
          title="เงินโอนที่ยังจับคู่กับบิลไม่ได้"
          subtitle="อ่านจากข้อความแจ้งเตือนของธนาคาร — ถ้าไม่ใช่ยอดขายของร้าน ปิดรายการพร้อมเหตุผลได้"
          flush
        >
          <DataTable
            columns={inboundColumns}
            rows={unattributed}
            getRowKey={(row) => row.id}
            caption="เงินโอนเข้าที่ระบบยังไม่รู้ว่าเป็นบิลไหน"
          />
        </Card>
      ) : null}

      {/*
        Delivery that has given up. Rendered only when it has, and with the
        gateway's own words attached — a shop that has just fixed a URL needs to
        know which messages never made it, not that the queue is empty.
      */}
      {outbox.abandoned > 0 ? (
        <Card
          title="ข้อความแจ้งเตือนที่ส่งไม่ออก"
          subtitle="ระบบลองส่งซ้ำหลายครั้งแล้วไม่สำเร็จ — มักเกิดจาก URL หรือคีย์ของช่องทางที่ตั้งไว้ผิด"
          flush
        >
          <DataTable
            columns={undeliveredColumns}
            rows={undelivered}
            getRowKey={(row) => row.id}
            caption="ข้อความที่ส่งไม่ออก และเหตุผลที่ผู้ให้บริการตอบกลับมา"
          />
        </Card>
      ) : null}

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
