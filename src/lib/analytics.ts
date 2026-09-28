/**
 * Dashboard aggregates.
 *
 * Read-only reporting queries. They are plain Prisma calls rather than a
 * materialised view, because at shop scale — a few thousand orders a month —
 * the indexes from SRS §7 are more than enough, and a live number is worth more
 * to a manager than a cached one.
 */
import { addBangkokDays, bangkokDateString, parseBangkokDay } from './bangkok-time';
import { prisma } from './db';
import { fromDecimal } from './money';

export interface DashboardSnapshot {
  today: {
    salesThb: number;
    orderCount: number;
    cashThb: number;
    promptpayThb: number;
  };
  preOrders: {
    pending: number;
    confirmed: number;
    readyForPickup: number;
    completedToday: number;
    cancelledToday: number;
  };
  catalogue: {
    activeProducts: number;
    lowStockCount: number;
    stockValueAtCostThb: number;
    reservedUnits: number;
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
  recentOrders: {
    id: string;
    orderNumber: string;
    orderType: string;
    status: string;
    finalAmountThb: number;
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
    preOrderCounts,
    completedToday,
    cancelledToday,
    activeProducts,
    reservedAggregate,
    stockRows,
    salesByDayRows,
    recentOrders,
  ] = await Promise.all([
    prisma.orders.aggregate({
      where: { status: 'completed', completed_at: { gte: todayStart } },
      _sum: { final_amount: true },
      _count: { _all: true },
    }),
    prisma.payments.groupBy({
      by: ['method'],
      where: { paid_at: { gte: todayStart }, method: { in: ['cash', 'promptpay'] } },
      _sum: { amount: true },
    }),
    prisma.orders.groupBy({
      by: ['status'],
      where: { order_type: 'preorder', status: { in: ['pending', 'confirmed', 'ready_for_pickup'] } },
      _count: { _all: true },
    }),
    prisma.orders.count({
      where: { order_type: 'preorder', status: 'completed', completed_at: { gte: todayStart } },
    }),
    prisma.orders.count({
      where: { order_type: 'preorder', status: 'cancelled', cancelled_at: { gte: todayStart } },
    }),
    prisma.products.count({ where: { is_active: true } }),
    prisma.products.aggregate({
      where: { is_active: true },
      _sum: { reserved_qty: true },
    }),
    prisma.products.findMany({
      where: { is_active: true },
      select: {
        id: true,
        name: true,
        barcode: true,
        stock_qty: true,
        reserved_qty: true,
        cost_price: true,
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
    prisma.$queryRaw<{ day: Date; sales: unknown; order_count: unknown }[]>`
      SELECT date_trunc('day', "completed_at" AT TIME ZONE 'Asia/Bangkok')
               AT TIME ZONE 'UTC'                AS day,
             COALESCE(SUM("final_amount"), 0) AS sales,
             COUNT(*)                         AS order_count
        FROM "orders"
       WHERE "status" = 'completed'
         AND "completed_at" >= ${weekStart}
       GROUP BY 1
       ORDER BY 1 ASC
    `,
    prisma.orders.findMany({
      orderBy: { created_at: 'desc' },
      take: 10,
      include: { cashier: { select: { full_name: true } } },
    }),
  ]);

  const paymentTotals = new Map<string, number>();
  for (const row of todayPayments) {
    paymentTotals.set(row.method, fromDecimal(row._sum.amount ?? 0));
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

  const stockValueAtCostThb = stockRows.reduce(
    (total, row) => total + row.stock_qty * fromDecimal(row.cost_price),
    0,
  );

  return {
    today: {
      salesThb: fromDecimal(todayAggregate._sum.final_amount ?? 0),
      orderCount: todayAggregate._count._all,
      cashThb: paymentTotals.get('cash') ?? 0,
      promptpayThb: paymentTotals.get('promptpay') ?? 0,
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
      lowStockCount: lowStock.length,
      stockValueAtCostThb,
      reservedUnits: reservedAggregate._sum.reserved_qty ?? 0,
    },
    salesByDay,
    lowStock: lowStock.map(({ costPrice: _costPrice, ...rest }) => rest),
    recentOrders: recentOrders.map((order) => ({
      id: order.id,
      orderNumber: order.order_number,
      orderType: order.order_type,
      status: order.status,
      finalAmountThb: fromDecimal(order.final_amount),
      createdAt: order.created_at,
      cashierName: order.cashier?.full_name ?? null,
    })),
  };
}
