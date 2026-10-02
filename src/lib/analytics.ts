/**
 * Dashboard aggregates.
 *
 * Read-only reporting queries. They are plain Prisma calls rather than a
 * materialised view, because at shop scale — a few thousand orders a month —
 * the indexes from SRS §7 are more than enough, and a live number is worth more
 * to a manager than a cached one.
 */
import { Prisma } from '../generated/prisma/client';

import { addBangkokDays, bangkokDateString, parseBangkokDay } from './bangkok-time';
import { prisma } from './db';
import { fromDecimal, roundThb } from './money';
import { SALE_INSTANT_COLUMN, soldIn } from './sale-instant';

export interface DashboardSnapshot {
  today: {
    /**
     * Gross: everything that was sold today, *including* a sale refunded since.
     *
     * A refund does not rewrite history, because the day it reversed is not the
     * day it happened. A bill paid on Monday and refunded on Friday stays in
     * Monday's takings and appears in Friday's refunds — which is the only
     * reading that lets an owner reconcile a week against the bank.
     */
    salesThb: number;
    orderCount: number;
    /** Money paid out today against credit notes issued today. */
    refundsThb: number;
    refundCount: number;
    /** Gross sales today minus refunds issued today. */
    netSalesThb: number;
    /**
     * What each method actually moved today: taken by this method, minus handed
     * back through it.
     *
     * Net rather than gross because the card these feed is titled "cash in the
     * drawer", and a day that took ฿107 and refunded ฿107 leaves nothing in it.
     * This is also the same arithmetic the close-of-shift count does, so the
     * dashboard cannot disagree with the drawer the cashier is counting.
     */
    cashThb: number;
    promptpayThb: number;
    /** Cash handed back today out of a drawer, so the card can say it is net. */
    cashRefundedThb: number;
  };
  preOrders: {
    pending: number;
    confirmed: number;
    readyForPickup: number;
    completedToday: number;
    cancelledToday: number;
  };
  catalogue: {
    /** Every active product, the shop's and the consignors' alike. */
    activeProducts: number;
    /** Active products the shop owns — the ones `stockValueAtCostThb` counts. */
    ownedProducts: number;
    lowStockCount: number;
    /**
     * What the *owned* stock on the shelf cost, floored at zero per product.
     *
     * Consigned goods are excluded: the shop did not buy them, so counting them here
     * would file somebody else's inventory as the shop's own (ADR 0023 §7). What they
     * are worth is stated beside this figure in `consignment`, never inside it.
     */
    stockValueAtCostThb: number;
    reservedUnits: number;
  };
  /**
   * The consignors' side of the shelf, kept outside the shop's own figures.
   *
   * These are the numbers that would otherwise be mistaken for the shop's: goods that
   * are somebody else's, and the debt those goods have already created. `sharesOwedThb`
   * is the ledger's own sum, so a dashboard figure and the rows behind it cannot drift.
   */
  consignment: {
    /** Active products consigned to a member. */
    productCount: number;
    /** Units of those products on the shelf — the consignor's, not the shop's. */
    units: number;
    /** What those consigned goods cost, shown separately from the owned valuation. */
    stockValueAtCostThb: number;
    /** The balance of `consignor_payables`: what the shop owes consignors right now. */
    sharesOwedThb: number;
  };
  salesByDay: { day: string; salesThb: number; orderCount: number }[];
  lowStock: {
    id: string;
    name: string;
    barcode: string | null;
    stockQty: number;
    reservedQty: number;
    availableQty: number;
  }[];
  /**
   * Products the shelf says are **below zero** — the task a replayed offline sale leaves
   * behind (ADR 0019 decision 3).
   *
   * Offline there is no live row to guard a sale against, so a device can promise more than
   * the shop has and the replay accepts the bill anyway: the goods are already in a
   * customer's hands, and a record that contradicted the receipt would be worse than a
   * negative count. So `stock_qty < 0` is reachable *only* through a replay — every guarded
   * path refuses it — and that makes the sign itself the task list. Correcting the count on
   * the products screen is what removes it, which is why there is no dismiss flag: the
   * state is the reminder.
   *
   * A product can appear on both this list and `lowStock`, and that is not a contradiction:
   * one says "you are nearly out", the other says "your books disagree with the shelf".
   */
  stockShortages: {
    id: string;
    name: string;
    barcode: string | null;
    stockQty: number;
    reservedQty: number;
    availableQty: number;
    /** The last time anything changed this row, so an operator knows how stale it is. */
    updatedAt: Date;
  }[];
  recentOrders: {
    id: string;
    orderNumber: string;
    orderType: string;
    status: string;
    finalAmountThb: number;
    /** Lines on the bill — what a refund is about to return. */
    itemCount: number;
    createdAt: Date;
    cashierName: string | null;
  }[];
}

/** Units at or below this level are surfaced as "running low". */
const LOW_STOCK_THRESHOLD = 5;

/** How many days the dashboard's trend covers, today inclusive. */
export const DASHBOARD_DAYS = 7;

/**
 * The seven Bangkok days the dashboard covers, oldest first, ending with today.
 *
 * Pure and exported because the equivalent expression used to live inline and was
 * wrong in a way nothing could see: it started from `setHours(0, 0, 0, 0)` — the
 * *host's* midnight — and serialised through `toISOString()`, which is UTC. On a
 * deployment ahead of UTC (Bangkok is seven hours ahead) every key came out one day
 * early, so the chart's labels named the wrong date for every bar and the last bar
 * was always yesterday, with today's takings falling off the end of the window.
 *
 * The test for it is a `now` at 18:30 UTC, which is already tomorrow in Bangkok.
 */
export function dashboardDays(now: Date = new Date()): string[] {
  const today = bangkokDateString(now);
  return Array.from({ length: DASHBOARD_DAYS }, (_, index) =>
    addBangkokDays(today, index - (DASHBOARD_DAYS - 1)),
  );
}


export async function dashboardSnapshot(now: Date = new Date()): Promise<DashboardSnapshot> {
  /*
   * Every window on this screen is a *Bangkok* day, and until it was written this
   * way it was the server's: `setHours(0, 0, 0, 0)` reads the host's clock, so on a
   * deployment that is not in Bangkok "today" began at the wrong instant, and the
   * seven day keys below drifted a day away from the keys the SQL produces. The
   * measurement that found it: a chart whose last bar was yesterday and whose
   * tooltips named the wrong date for every sale.
   *
   * `parseBangkokDay` gives the instant of Bangkok midnight; `addBangkokDays`
   * moves along the calendar. Nothing here reads the host timezone at all.
   */
  const days = dashboardDays(now);
  const todayStart = parseBangkokDay(days[days.length - 1]!);
  const weekStart = parseBangkokDay(days[0]!);

  const [
    todayAggregate,
    todayPayments,
    todayRefundLegs,
    todayRefunds,
    preOrderCounts,
    completedToday,
    cancelledToday,
    activeProducts,
    reservedAggregate,
    sharesOwedAggregate,
    stockRows,
    salesByDayRows,
    recentOrders,
  ] = await Promise.all([
    prisma.orders.aggregate({
      /*
       * `refunded` is included on purpose: this figure is gross takings, and a
       * refunded sale was still a sale. Its reversal is the next query.
       *
       * The window is the day a sale *happened* (`soldIn`, ADR 0019 decision 4). A bill
       * closed offline at 21:00 and replayed at 08:12 is yesterday's takings: it was rung
       * up, handed over and counted in that evening's drawer, and a dashboard that moved it
       * to this morning would disagree with the person who counted.
       */
      where: { status: { in: ['completed', 'refunded'] }, ...soldIn({ from: todayStart }) },
      _sum: { final_amount: true },
      _count: { _all: true },
    }),
    prisma.payments.groupBy({
      by: ['method'],
      where: {
        paid_at: { gte: todayStart },
        method: { in: ['cash', 'promptpay'] },
        direction: 'sale',
      },
      _sum: { amount: true },
    }),
    prisma.payments.groupBy({
      by: ['method'],
      where: { paid_at: { gte: todayStart }, direction: 'refund' },
      _sum: { amount: true },
    }),
    prisma.credit_notes.aggregate({
      where: { created_at: { gte: todayStart } },
      _sum: { final_amount: true },
      _count: { _all: true },
    }),
    prisma.orders.groupBy({
      by: ['status'],
      where: { order_type: 'preorder', status: { in: ['pending', 'confirmed', 'ready_for_pickup'] } },
      _count: { _all: true },
    }),
    prisma.orders.count({
      // Collected today counts as collected even if it was refunded since; the
      // refund is a Friday event, not a correction to Tuesday's board. A pre-order's
      // sale instant *is* its handover, so this reads the same as `completed_at` used to.
      where: {
        order_type: 'preorder',
        status: { in: ['completed', 'refunded'] },
        ...soldIn({ from: todayStart }),
      },
    }),
    prisma.orders.count({
      where: { order_type: 'preorder', status: 'cancelled', cancelled_at: { gte: todayStart } },
    }),
    prisma.products.count({ where: { is_active: true } }),
    prisma.products.aggregate({
      where: { is_active: true },
      _sum: { reserved_qty: true },
    }),
    /*
     * The total the shop owes consignors, read as the ledger's own sum rather than a
     * cached column — the same arithmetic `ledgerBalance` does, so the figure on the
     * dashboard is the rows it claims to be (ADR 0023 §2). Zero when nothing is owed,
     * which is also what an empty ledger means.
     */
    prisma.consignor_payables.aggregate({ _sum: { amount_thb: true } }),
    prisma.products.findMany({
      where: { is_active: true },
      select: {
        id: true,
        name: true,
        barcode: true,
        stock_qty: true,
        reserved_qty: true,
        cost_price: true,
        /** Non-null means a consignor's goods, kept out of the owned valuation. */
        consignor_user_id: true,
        // Read for the shortage list: how recently anything moved this row.
        updated_at: true,
      },
    }),
    /*
     * The day bucket is Bangkok's, stated in the query rather than inherited
     * from the connection's session timezone.
     *
     * Two conversions, and the second is the one that is easy to get wrong: the
     * inner one moves the instant onto the Bangkok wall clock, and the outer one
     * re-attaches UTC so the value that comes back is midnight **UTC** of the
     * Bangkok calendar day — the same convention `dateColumnFromDay` uses, which
     * is what lets the keys below line up with `weekStart`. A plain
     * `date_trunc('day', …)` would file a 01:00 Bangkok sale under the previous
     * day the moment the session stopped being Bangkok's.
     */
    prisma.$queryRaw<{ day: Date; sales: unknown; order_count: unknown }[]>(
      /*
       * The column comes from `SALE_INSTANT_COLUMN` rather than being written here, and it
       * is the only place in the codebase that has to be: PostgreSQL is doing the day
       * arithmetic (below), so this is the one read the type checker cannot help with. If a
       * later edit reached for `created_at` here the chart would quietly start disagreeing
       * with the figure above it — the same shape of defect, one layer down.
       */
      Prisma.sql`
        SELECT date_trunc('day', ${Prisma.raw(`"${SALE_INSTANT_COLUMN}"`)} AT TIME ZONE 'Asia/Bangkok')
                 AT TIME ZONE 'UTC'                AS day,
               COALESCE(SUM("final_amount"), 0) AS sales,
               COUNT(*)                         AS order_count
          FROM "orders"
         WHERE "status" IN ('completed', 'refunded')
           AND ${Prisma.raw(`"${SALE_INSTANT_COLUMN}"`)} >= ${weekStart}
         GROUP BY 1
         ORDER BY 1 ASC
      `,
    ),
    prisma.orders.findMany({
      orderBy: { created_at: 'desc' },
      take: 10,
      include: {
        cashier: { select: { full_name: true } },
        _count: { select: { items: true } },
      },
    }),
  ]);

  const paymentTotals = new Map<string, number>();
  for (const row of todayPayments) {
    paymentTotals.set(row.method, fromDecimal(row._sum.amount ?? 0));
  }

  const refundTotals = new Map<string, number>();
  for (const row of todayRefundLegs) {
    refundTotals.set(row.method, fromDecimal(row._sum.amount ?? 0));
  }

  const statusCounts = new Map<string, number>();
  for (const row of preOrderCounts) {
    statusCounts.set(row.status, row._count._all);
  }

  // Fill the gaps: a day with no sales must still appear on the chart.
  const salesByDayMap = new Map<string, { salesThb: number; orderCount: number }>();
  for (const row of salesByDayRows) {
    const key = new Date(row.day).toISOString().slice(0, 10);
    salesByDayMap.set(key, {
      salesThb: Number(row.sales),
      orderCount: Number(row.order_count),
    });
  }

  const salesByDay: DashboardSnapshot['salesByDay'] = [];
  for (const key of days) {
    const found = salesByDayMap.get(key);
    salesByDay.push({
      day: key,
      salesThb: found?.salesThb ?? 0,
      orderCount: found?.orderCount ?? 0,
    });
  }

  const lowStock = stockRows
    .map((row) => ({
      id: row.id,
      name: row.name,
      barcode: row.barcode,
      stockQty: row.stock_qty,
      reservedQty: row.reserved_qty,
      availableQty: row.stock_qty - row.reserved_qty,
      costPrice: fromDecimal(row.cost_price),
    }))
    .filter((row) => row.availableQty <= LOW_STOCK_THRESHOLD)
    .sort((a, b) => a.availableQty - b.availableQty)
    .slice(0, 10);

  /*
   * The shortage task. Most-negative first, because the largest disagreement between the
   * books and the shelf is the one to count first, and capped like the low-stock list so a
   * screen cannot become a wall.
   */
  const stockShortages = stockRows
    .filter((row) => row.stock_qty < 0)
    .sort((left, right) => left.stock_qty - right.stock_qty)
    .slice(0, 20)
    .map((row) => ({
      id: row.id,
      name: row.name,
      barcode: row.barcode,
      stockQty: row.stock_qty,
      reservedQty: row.reserved_qty,
      availableQty: row.stock_qty - row.reserved_qty,
      updatedAt: row.updated_at,
    }));

  /*
   * The shelf, split by who owns it. `consignor_user_id` is the whole distinction (ADR
   * 0023 §1): a product is the shop's or a consignor's, never both and never part. The
   * two sets are summed by the same rule so the figures are comparable, and the
   * consignors' one is reported *beside* the shop's — never added into it.
   */
  const ownedRows = stockRows.filter((row) => row.consignor_user_id === null);
  const consignedRows = stockRows.filter((row) => row.consignor_user_id !== null);

  const valueAtCost = (rows: (typeof stockRows)[number][]): number =>
    rows.reduce(
      /*
       * Floored at zero per product, because a replayed offline sale can leave a row negative
       * (ADR 0019 decision 3, and the migration that relaxed the CHECK): goods left the shelf
       * that nobody counted, and a shop does not own minus two of anything. Counting the
       * negative would *reduce* what the stock is worth — the opposite of what it means — while
       * the shortage itself is stated on its own card below.
       */
      (total, row) => total + Math.max(0, row.stock_qty) * fromDecimal(row.cost_price),
      0,
    );

  const stockValueAtCostThb = valueAtCost(ownedRows);
  const consignedStockValueAtCostThb = valueAtCost(consignedRows);
  const consignedUnits = consignedRows.reduce(
    (total, row) => total + Math.max(0, row.stock_qty),
    0,
  );

  const salesThb = fromDecimal(todayAggregate._sum.final_amount ?? 0);
  const refundsThb = fromDecimal(todayRefunds._sum.final_amount ?? 0);
  const netByMethod = (method: string) =>
    roundThb((paymentTotals.get(method) ?? 0) - (refundTotals.get(method) ?? 0));

  return {
    today: {
      salesThb,
      orderCount: todayAggregate._count._all,
      refundsThb,
      refundCount: todayRefunds._count._all,
      netSalesThb: roundThb(salesThb - refundsThb),
      cashThb: netByMethod('cash'),
      promptpayThb: netByMethod('promptpay'),
      cashRefundedThb: roundThb(refundTotals.get('cash') ?? 0),
    },
    preOrders: {
      pending: statusCounts.get('pending') ?? 0,
      confirmed: statusCounts.get('confirmed') ?? 0,
      readyForPickup: statusCounts.get('ready_for_pickup') ?? 0,
      completedToday,
      cancelledToday,
    },
    catalogue: {
      activeProducts,
      ownedProducts: ownedRows.length,
      lowStockCount: lowStock.length,
      stockValueAtCostThb,
      reservedUnits: reservedAggregate._sum.reserved_qty ?? 0,
    },
    consignment: {
      productCount: consignedRows.length,
      units: consignedUnits,
      stockValueAtCostThb: consignedStockValueAtCostThb,
      sharesOwedThb: fromDecimal(sharesOwedAggregate._sum.amount_thb ?? 0),
    },
    salesByDay,
    lowStock: lowStock.map(({ costPrice: _costPrice, ...rest }) => rest),
    stockShortages,
    recentOrders: recentOrders.map((order) => ({
      id: order.id,
      orderNumber: order.order_number,
      orderType: order.order_type,
      status: order.status,
      finalAmountThb: fromDecimal(order.final_amount),
      itemCount: order._count.items,
      createdAt: order.created_at,
      cashierName: order.cashier?.full_name ?? null,
    })),
  };
}
