import { redirect } from 'next/navigation';

import { SalesHistory, type SalesRow } from '@/components/admin/SalesHistory';
import { PageHeader, Stack } from '@/components/ds';
import { resolveBangkokRange } from '@/lib/bangkok-time';
import { listOrderViews } from '@/lib/order-view';
import { loadShop } from '@/lib/shop';
import { requireShellUser } from '@/lib/shell';

/**
 * Sales history — every sale the shop made, searchable by receipt number and day.
 *
 * **Why this screen exists at all.** There were three answers to "where can I see
 * past sales and their receipts", and none of them were an answer:
 *
 *   * `/admin/reports` exports spreadsheets. Useful at month end, useless when a
 *     customer is standing at the counter asking for the receipt for the ฿180 they
 *     paid last Thursday.
 *   * `/receipts?t=…` opens a receipt from a link the customer is already holding.
 *     It is deliberately unguessable — that is its security — so it cannot be the
 *     answer for a shop that wants to look one up.
 *   * The till shows the current basket and the pre-order board shows waiting orders.
 *     Neither keeps history.
 *
 * So the owner had no way to answer "what happened on Tuesday", which is the question
 * a small shop actually asks. This is that screen: the same receipt projection the
 * printed one uses, reachable from a number the customer can read out.
 *
 * Open to employees as well as admins, on the same reasoning as `/admin/reports`:
 * looking up a sale is part of working the till, and a cashier who has to ask a
 * manager to reprint a receipt in front of a customer cannot serve them. What an
 * employee *cannot* do here is refund or re-link, and those stay behind the gates
 * they already have.
 */
export const dynamic = 'force-dynamic';

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ receiptNumber?: string; customerName?: string; from?: string; to?: string; offset?: string }>;
}) {
  const user = await requireShellUser(['admin', 'employee']);
  const params = await searchParams;

  const shop = await loadShop();
  if (!shop) {
    redirect('/setup');
  }

  /*
   * The trailing thirty days by default, in Bangkok days.
   *
   * A date range rather than "everything", because the alternative is a screen that
   * opens by reading the whole orders table — and an owner who wanted last Thursday
   * should not pay for the shop's entire history to find it. The window is a
   * starting point, not a limit: the two boxes are editable and the search box is
   * not gated by them at all.
   */
  const range = resolveBangkokRange({
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
  });

  const pageSize = 50;
  const offset = Math.max(0, Number(params.offset ?? '0') || 0);

  /*
   * Two queries rather than one paginated call with a count, because the screen needs
   * "row 51 of 137" and Prisma's `count` here would count the same predicate twice
   * anyway. The extra round trip is one indexed count over a date range.
   */
  const rows: SalesRow[] = (
    await listOrderViews({
      statuses: ['completed', 'refunded'],
      limit: pageSize,
      from: range.fromDate,
      toExclusive: range.toExclusive,
      offset,
      ...(params.receiptNumber ? { receiptNumber: params.receiptNumber } : {}),
      ...(params.customerName ? { customerName: params.customerName } : {}),
    })
  ).map((order) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    receiptNumber: order.receiptNumber,
    finalAmountThb: order.finalAmountThb,
    itemCount: order.itemCount,
    customerName: order.customerName,
    completedAt: order.completedAt ? order.completedAt.toISOString() : null,
    status: order.status,
  }));

  return (
    <Stack gap="lg">
      <PageHeader
        title="ประวัติการขาย"
        subtitle="ค้นหาจากเลขใบเสร็จหรือชื่อลูกค้า แล้วดูหรือพิมพ์ใบเสร็จซ้ำได้จากที่นี่"
      />

      <SalesHistory
        initialRows={rows}
        initialFrom={range.from}
        initialTo={range.to}
        initialReceiptNumber={params.receiptNumber ?? ''}
        initialCustomerName={params.customerName ?? ''}
        initialOffset={offset}
        pageSize={pageSize}
        shop={shop}
        canRefund={user.role === 'admin'}
      />
    </Stack>
  );
}