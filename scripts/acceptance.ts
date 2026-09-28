/**
 * Virgin-deployment acceptance run — `npm run acceptance`.
 *
 * This proves what `npm run smoke` structurally cannot: the whole renter journey
 * against a database that has never been used. The smoke test starts from the
 * demo seed — its personas *are* seeded accounts — so it can never tell you
 * whether a shop that has just been installed actually works. This script starts
 * from an empty schema and drives the setup wizard's API, the staff API, a
 * catalogue import, a VAT sale, and the receipt that comes out the other end.
 *
 * Why this is a Node script and not the curl/bash harness it replaces: that
 * harness lied on Windows in two independent ways.
 *
 *   1. Thai text passed as a `curl -d` argument is re-encoded through the
 *      console codepage. The shop name arrived as "?????????? ?????????" and was
 *      stored that way, so every assertion about it failed while the application
 *      was behaving perfectly. (Confirmed by reading the row back with psql.)
 *   2. `curl -F file=@/tmp/catalogue.csv` is a *mingw* curl being handed a Git
 *      Bash path. It cannot open the file, the request never leaves the machine,
 *      and the empty response looks exactly like a server bug.
 *
 * Both produced silent, plausible-looking failures. `fetch` sends UTF-8 and
 * reads real filesystem paths, so a failure here is a failure in the app.
 *
 * Isolation: everything happens in a dedicated PostgreSQL *schema* named
 * `accept`, inside the database `TEST_DATABASE_URL` points at. A schema needs
 * only CREATE privilege — no superuser, no CREATEDB — so this needs no
 * privileged setup of its own, and it cannot disturb the default schema that the
 * app and the vitest suites share. The schema is dropped again on the way out.
 *
 * Usage:
 *   npm run acceptance                      drop → migrate → build → serve → check
 *   npm run acceptance -- --skip-build      reuse the existing `.next` build
 *   npm run acceptance -- --keep            leave the scratch schema to inspect
 *   npm run acceptance -- --base-url URL    check a server that is already running
 */
import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import { hashPassword } from '../src/lib/password';
import { looksLikePickupToken } from '../src/lib/pickup-scan';

import {
  Session,
  csvForm,
  freePort,
  loadEnv,
  resetScratchSchema,
  scratchClient,
  scratchUrl,
  shell,
  startServer,
  stopServer,
  waitForServer,
} from './harness';

/* ------------------------------------------------------------------ config */

loadEnv();

const SCRATCH_SCHEMA = 'accept';
const FIRST_PORT = 3211;

/**
 * Deliberately awkward: Thai, a space, and a leading/trailing-space risk. The
 * old harness failed on exactly this string, so it is the string to keep.
 */
const SHOP = {
  name: 'ร้านกาแฟ เหลี่ยมนอก สาขาแรก',
  branchLabel: 'สาขาแรก',
  taxId: '1103700123456',
  isVatRegistered: true,
  vatRate: 7,
  receiptPrefix: 'FR',
};

const ADMIN = { fullName: 'ผู้จัดการ เหลี่ยมนอก', phone: '0800000300', password: 'accept-admin-1' };
const CASHIER = { fullName: 'มาลี เหลี่ยมนอก', phone: '0800000301', password: 'accept-cashier-1' };

/**
 * The customer in section 11.
 *
 * Inserted as a fixture rather than through the app, and that is a finding, not a
 * convenience: **the API has no way to create a member.** Staff accounts are made
 * by an admin (section 4), and a pre-order requires `requireRole(['member'])`, so a
 * shop that has just installed this software has nobody who can place one. The
 * journey below still drives every step through HTTP — this row is the starting
 * condition, the same way the setup wizard is.
 */
const MEMBER = { fullName: 'สมชาย เหลี่ยมนอก', phone: '0800000302', password: 'accept-member-1' };

/**
 * The supervisor PIN the run sets for itself.
 *
 * `7391` because `pinProblem` refuses the obvious ones: a repeated digit and a
 * consecutive run are the guesses somebody makes first, and refusing them is a
 * rule this journey should not be able to sneak past.
 */
const SUPERVISOR_PIN = '7391';

/**
 * The secret this run configures its own bridge with.
 *
 * Set here and inherited by the server the harness starts, so the journey can
 * prove the machine path works end to end without a shop having to own a mailbox
 * first. A real shop sets the same variable in `.env`.
 */
const ACCEPT_BRIDGE_SECRET = 'accept-bridge-secret';

/** One product at 107 THB — a shelf price that splits cleanly into 100 + 7. */
const COFFEE = { barcode: 'LNM0000001', name: 'กาแฟเหลี่ยมนอก 250 มล.', cost: 60, price: 107, stock: 12 };
const WATER = { barcode: 'LNM0000002', name: 'น้ำเปล่าเหลี่ยมนอก 600 มล.', cost: 8, price: 25, stock: 24 };

/**
 * Headers are the canonical Thai ones from `IMPORT_COLUMNS`. Matching is exact
 * after normalisation, so this file is also a test that the documented template
 * is the template a renter can actually fill in.
 */
const CATALOGUE_CSV = [
  'บาร์โค้ด,ชื่อสินค้า,หมวดหมู่,ราคาทุน,ราคาขาย,จำนวนสต็อก',
  `${COFFEE.barcode},${COFFEE.name},เครื่องดื่ม,${COFFEE.cost},${COFFEE.price},${COFFEE.stock}`,
  `${WATER.barcode},${WATER.name},เครื่องดื่ม,${WATER.cost},${WATER.price},${WATER.stock}`,
].join('\r\n');

/** One usable row and one with no name, which the import must skip, not die on. */
const PARTIAL_CSV = [
  'บาร์โค้ด,ชื่อสินค้า,หมวดหมู่,ราคาทุน,ราคาขาย,จำนวนสต็อก',
  'LNM0000003,ชาเหลี่ยมนอก 500 มล.,เครื่องดื่ม,20,45,6',
  'LNM0000004,,เครื่องดื่ม,10,20,5',
].join('\r\n');

/* ------------------------------------------------------------------ plumbing */

/**
 * Set once in `main`; every request goes through it.
 *
 * The HTTP session, the port picker and the production server all live in
 * `scripts/harness.ts` now, because `route-audit.ts` needs exactly the same
 * ones — and a second copy of "how do we start the server on Windows" is how the
 * two scripts drift apart.
 */
let base = '';

/* ------------------------------------------------------------------ the run */

interface ShopDto {
  name: string;
  branchLabel: string | null;
  taxId: string | null;
  isVatRegistered: boolean;
  vatRate: number;
  receiptPrefix: string;
  receiptRunningNumber: number | string;
}

interface ProductDto {
  id: string;
  name: string;
  salePrice: number;
  stockQty: number;
  availableQty: number;
}

interface OrderDto {
  orderId: string;
  receiptNumber: string | null;
  status: string;
  finalAmountThb: number;
  netThb: number;
  vatThb: number;
  vatRatePercent: number | null;
  isVatInvoice: boolean;
}

interface ImportPreviewDto {
  mode: string;
  preview?: { createCount: number; updateCount: number; invalidCount: number; stockAddedTotal: number };
  summary?: { created: number; updated: number; skipped: number; stockAddedTotal: number };
}

interface StockLogDto {
  productId: string;
  movementType: string;
  reason: string | null;
  qtyChanged: number;
  balanceAfter: number;
}

interface RefundDto {
  orderId: string;
  orderNumber: string;
  status: string;
  documentNumber: string;
  finalAmountThb: number;
  refundMethod: string;
  returnedLines: number;
  returnedUnits: number;
  pointsClawedBack: number;
  pointsForgiven: number;
}

interface CreditNoteDto {
  shop: { name: string; taxId: string | null };
  creditNote: {
    documentNumber: string;
    reason: string;
    refundMethod: string;
    finalAmountThb: number;
    netThb: number;
    vatThb: number;
    vatRatePercent: number | null;
    isVatInvoice: boolean;
    issuedBy: string;
    approvedBy: string | null;
    original: {
      orderNumber: string;
      receiptNumber: string | null;
      tenders: { method: string; amountThb: number }[];
    };
  };
}

interface AuditPageDto {
  entries: { action: string; detail: Record<string, unknown> | null }[];
  total: number;
}

interface PreOrderPlacedDto {
  orderId: string;
  orderNumber: string;
  status: string;
  subtotalThb: number;
  confirmDeadline: string;
}

/** One row of the order boards, which is where the handover QR comes from. */
interface OrderBoardRowDto {
  id: string;
  orderNumber: string;
  status: string;
  pickupPin: string | null;
  pickupToken: string | null;
}

interface PickupLookupDto {
  orderNumber: string;
  status: string;
}

async function runChecks(seedGuardUrl: string | null): Promise<number> {
  let passed = 0;
  let failed = 0;

  const check = (label: string, condition: boolean, detail?: unknown): void => {
    if (condition) {
      passed += 1;
      console.log(`  ✓ ${label}`);
      return;
    }
    failed += 1;
    console.error(
      `  ✗ ${label}${detail === undefined ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
    );
  };
  const section = (title: string): void => console.log(`\n${title}`);

  /* ---------------------------------------------------------- 1. virgin */
  section('1. A deployment nobody has set up yet');

  const anonymous = new Session(() => base);
  const initial = await anonymous.request<{ initialized: boolean }>('/api/v1/setup');
  check('setup reports initialized: false', initial.data?.initialized === false, initial.data);

  const wizard = await anonymous.raw('/setup');
  const wizardHtml = await wizard.text();
  check(
    '/setup serves the wizard',
    wizard.status === 200 && wizardHtml.includes('ตั้งค่าระบบครั้งแรก'),
    wizard.status,
  );

  const loginRedirect = await anonymous.raw('/login');
  const location = loginRedirect.headers.get('location') ?? '';
  check(
    '/login sends an unconfigured deployment to the wizard',
    [302, 307, 308].includes(loginRedirect.status) && location.includes('/setup'),
    `${loginRedirect.status} ${location}`,
  );

  /* -------------------------------------------------------- 2. the wizard */
  section('2. The wizard creates the shop and its first administrator');

  const setupBody = {
    shop: {
      name: SHOP.name,
      branchLabel: SHOP.branchLabel,
      taxId: SHOP.taxId,
      isVatRegistered: SHOP.isVatRegistered,
      vatRate: SHOP.vatRate,
      receiptPrefix: SHOP.receiptPrefix,
    },
    admin: { fullName: ADMIN.fullName, phone: ADMIN.phone, password: ADMIN.password },
  };

  const created = await anonymous.request<{ initialized: boolean }>('/api/v1/setup', {
    method: 'POST',
    body: setupBody,
  });
  check('the shop and its first administrator are created', created.data?.initialized === true, created.error ?? created.data);

  const afterSetup = await anonymous.request<{ initialized: boolean }>('/api/v1/setup');
  check('the wizard closes behind itself', afterSetup.data?.initialized === true, afterSetup.data);

  const secondSetup = await anonymous.request('/api/v1/setup', {
    method: 'POST',
    body: { ...setupBody, admin: { ...setupBody.admin, phone: '0800000399' } },
  });
  check('a second setup attempt is refused with 409', secondSetup.status === 409, secondSetup.status);

  /* ------------------------------------------------- 3. the renter's shop */
  section('3. The renter signs in and reads their own settings back');

  const admin = new Session(() => base);
  await admin.login({ identifier: ADMIN.phone, password: ADMIN.password });

  const me = await admin.call<{ role: string; fullName: string }>('/api/v1/auth/me');
  check('the wizard administrator signs in as an admin', me.role === 'admin', me.role);
  check(
    'their name survives the round trip byte for byte (Thai and a space)',
    me.fullName === ADMIN.fullName,
    me.fullName,
  );

  const shop = await admin.call<ShopDto>('/api/v1/shop');
  check(
    'the shop name survives the round trip — the check the old harness could never make',
    shop.name === SHOP.name,
    shop.name,
  );
  check(
    'the branch label and tax id are stored',
    shop.branchLabel === SHOP.branchLabel && shop.taxId === SHOP.taxId,
    `${shop.branchLabel} / ${shop.taxId}`,
  );
  check(
    'VAT registration and rate are recorded',
    shop.isVatRegistered === true && shop.vatRate === 7,
    `${shop.isVatRegistered} @ ${shop.vatRate}`,
  );
  check(
    'the receipt series has not been used yet',
    Number(shop.receiptRunningNumber) === 0,
    shop.receiptRunningNumber,
  );

  /* -------------------------------------------------------- 4. the staff */
  section('4. Staff accounts are created from the app, not from SQL');

  const staff = await admin.call<{ id: string }>('/api/v1/staff', {
    method: 'POST',
    body: { fullName: CASHIER.fullName, phone: CASHIER.phone, role: 'employee', password: CASHIER.password },
  });
  check('the administrator creates a cashier', typeof staff.id === 'string', staff);

  const weakPassword = await admin.request('/api/v1/staff', {
    method: 'POST',
    body: { fullName: 'ทดสอบ', phone: '0800000398', role: 'employee', password: 'short' },
  });
  check('a 5-character password is refused with 422', weakPassword.status === 422, weakPassword.status);

  const cashier = new Session(() => base);
  await cashier.login({ identifier: CASHIER.phone, password: CASHIER.password });
  const cashierMe = await cashier.call<{ role: string }>('/api/v1/auth/me');
  check('the new cashier can sign in', cashierMe.role === 'employee', cashierMe.role);

  const staffAsCashier = await cashier.request('/api/v1/staff', {
    method: 'POST',
    body: { fullName: 'ทดสอบ', phone: '0800000397', role: 'admin', password: 'accept-real-1' },
  });
  check('the cashier cannot create accounts (403)', staffAsCashier.status === 403, staffAsCashier.status);

  const exportAsCashier = await cashier.raw('/api/v1/reports/export?type=sales_summary');
  check('the cashier cannot export reports (403)', exportAsCashier.status === 403, exportAsCashier.status);

  /* ------------------------------------------------------ 5. the catalogue */
  section('5. The catalogue arrives as a spreadsheet');

  const preview = await admin.postForm<ImportPreviewDto>(
    '/api/v1/products/import',
    csvForm(CATALOGUE_CSV, 'preview'),
  );
  check('preview answers in preview mode', preview.data?.mode === 'preview', preview.data?.mode);
  check(
    'preview plans two creates',
    preview.data?.preview?.createCount === 2,
    preview.data?.preview,
  );
  check(
    'preview totals the opening stock (12 + 24)',
    preview.data?.preview?.stockAddedTotal === 36,
    preview.data?.preview?.stockAddedTotal,
  );
  check(
    'preview rejects no rows of a well-formed sheet',
    preview.data?.preview?.invalidCount === 0,
    preview.data?.preview?.invalidCount,
  );

  const beforeImport = await admin.call<ProductDto[]>('/api/v1/products');
  check('a preview writes nothing', beforeImport.length === 0, beforeImport.length);

  const commit = await admin.postForm<ImportPreviewDto>(
    '/api/v1/products/import',
    csvForm(CATALOGUE_CSV, 'commit'),
  );
  check('commit creates both products', commit.data?.summary?.created === 2, commit.data?.summary);
  check(
    'commit adds the opening stock',
    commit.data?.summary?.stockAddedTotal === 36,
    commit.data?.summary?.stockAddedTotal,
  );
  check('commit skips nothing', commit.data?.summary?.skipped === 0, commit.data?.summary?.skipped);

  const coffee = (await admin.call<ProductDto[]>(`/api/v1/products?barcode=${COFFEE.barcode}`))[0];
  check(
    'the imported product is sellable at the sheet price',
    coffee?.name === COFFEE.name && coffee.salePrice === COFFEE.price && coffee.availableQty === COFFEE.stock,
    coffee,
  );

  const categories = await admin.call<{ name: string }[]>('/api/v1/categories');
  check(
    'the category the sheet named was created rather than demanded first',
    categories.some((entry) => entry.name === 'เครื่องดื่ม'),
    categories.map((entry) => entry.name),
  );

  const logs = await admin.call<StockLogDto[]>(`/api/v1/inventory/logs?productId=${coffee?.id ?? ''}`);
  check(
    'the opening stock left an audit trail',
    logs[0]?.qtyChanged === COFFEE.stock && logs[0]?.balanceAfter === COFFEE.stock,
    logs[0],
  );
  check(
    'and the trail says why (REASON_IMPORT)',
    logs[0]?.reason === 'REASON_IMPORT',
    logs[0]?.reason,
  );

  const partial = await admin.postForm<ImportPreviewDto>(
    '/api/v1/products/import',
    csvForm(PARTIAL_CSV, 'commit'),
  );
  check(
    'a row with no name is skipped instead of failing the whole file',
    partial.data?.summary?.created === 1 && partial.data?.summary?.skipped === 1,
    partial.data?.summary,
  );

  /* ------------------------------------------------------------ 6. the sale */
  section('6. A sale, with the tax derived out of the shelf price');

  const shift = await cashier.call<{ id: number; initialCashThb: number }>('/api/v1/shifts/current', {
    method: 'POST',
    body: { initialCash: 500 },
  });
  check('the cashier opens a drawer with a 500 THB float', shift.initialCashThb === 500, shift);

  const sale = await cashier.call<OrderDto>('/api/v1/orders', {
    method: 'POST',
    body: {
      type: 'pos_walkin',
      shiftId: shift.id,
      lines: [{ productId: coffee?.id, quantity: 1 }],
      settlement: { cash: COFFEE.price },
    },
  });
  check('the sale completes', sale.status === 'completed', sale.status);
  check(
    `the customer pays the shelf price (${COFFEE.price})`,
    sale.finalAmountThb === COFFEE.price,
    sale.finalAmountThb,
  );
  check(
    'the tax is taken out of it: 100.00 net + 7.00 VAT',
    sale.netThb === 100 && sale.vatThb === 7,
    `${sale.netThb} / ${sale.vatThb}`,
  );
  check(
    'the net and the tax reconstruct the total exactly',
    sale.netThb + sale.vatThb === sale.finalAmountThb,
    `${sale.netThb} + ${sale.vatThb} vs ${sale.finalAmountThb}`,
  );
  check('the order records the rate it used (7%)', sale.vatRatePercent === 7, sale.vatRatePercent);
  check('the sale is issued as a VAT invoice', sale.isVatInvoice === true, sale.isVatInvoice);
  check(
    "the first receipt takes the renter's own series (FR-<year>-000001)",
    /^FR-\d{4}-000001$/.test(sale.receiptNumber ?? ''),
    sale.receiptNumber,
  );

  const receipt = await cashier.call<{
    shop: { name: string; taxId: string | null };
    receipt: { netThb: number; vatThb: number; receiptNumber: string | null };
  }>(`/api/v1/orders/${sale.orderId}/receipt`);
  check(
    'the reprint matches the sale exactly',
    receipt.receipt.netThb === sale.netThb &&
      receipt.receipt.vatThb === sale.vatThb &&
      receipt.receipt.receiptNumber === sale.receiptNumber,
    receipt.receipt,
  );
  check(
    "the reprint carries the renter's shop name, not ours",
    receipt.shop.name === SHOP.name,
    receipt.shop.name,
  );
  check("and the renter's tax id", receipt.shop.taxId === SHOP.taxId, receipt.shop.taxId);

  const shopAfterSale = await admin.call<ShopDto>('/api/v1/shop');
  check(
    'the receipt series advanced to 1',
    Number(shopAfterSale.receiptRunningNumber) === 1,
    shopAfterSale.receiptRunningNumber,
  );

  const soldCoffee = (await admin.call<ProductDto[]>(`/api/v1/products?barcode=${COFFEE.barcode}`))[0];
  check(
    'stock fell by exactly the one unit sold',
    soldCoffee?.stockQty === COFFEE.stock - 1 && soldCoffee?.availableQty === COFFEE.stock - 1,
    soldCoffee,
  );

  /* --------------------------------------------------------- 7. the drawer */
  section('7. The drawer reconciles to the sale');

  const drawer = await cashier.call<{ shift: { id: number; expectedCashThb: number } | null }>(
    '/api/v1/shifts/current',
  );
  check(
    'the drawer expects the float plus the cash sale (500 + 107 = 607)',
    drawer.shift?.expectedCashThb === 607,
    drawer.shift?.expectedCashThb,
  );

  const closed = drawer.shift
    ? await cashier.call<{ discrepancyThb: number; discrepancyKind: string }>(
        `/api/v1/shifts/${drawer.shift.id}/close`,
        { method: 'POST', body: { actualCash: 607 } },
      )
    : null;
  check(
    'an exact count reconciles to zero',
    closed?.discrepancyThb === 0 && closed?.discrepancyKind === 'balanced',
    closed,
  );

  /* --------------------------------------------------------- 8. the guards */
  section('8. Guards that protect a live shop');

  if (seedGuardUrl === null) {
    console.log('  • skipped: the demo-seed guard needs the scratch database (not available with --base-url)');
  } else {
    const seed = spawnSync('npx tsx prisma/seed.ts', {
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: seedGuardUrl },
    });
    const output = `${seed.stdout ?? ''}${seed.stderr ?? ''}`;
    check('the demo seed refuses to touch a configured shop', seed.status !== 0, seed.status);
    check(
      'and explains why rather than failing silently',
      output.includes('already been set up'),
      output.trim().split('\n').slice(-4).join(' '),
    );
  }

  const anonymousShop = await new Session(() => base).raw('/api/v1/shop');
  check('an anonymous request for the settings is refused (401)', anonymousShop.status === 401, anonymousShop.status);

  /* ------------------------------- 9. a refund, and the credit note behind it */
  section('9. A refund, and the credit note behind it');

  /*
   * The wizard's administrator starts with no PIN, because a PIN is a credential
   * a person chooses rather than one an installer generates. Setting it here is
   * also the first thing that proves the PIN rules are enforced. An operator who
   * types 0000 in front of a queue is exactly the mistake `pinProblem` exists for,
   * so the run tries one and is refused.
   */
  const weakPin = await admin.request('/api/v1/pos/pin', { method: 'POST', body: { pin: '0000' } });
  check('a repeated-digit supervisor PIN is refused', weakPin.status === 422, weakPin.status);

  const pinSet = await admin.call<{ hasPin: boolean }>('/api/v1/pos/pin', {
    method: 'POST',
    body: { pin: SUPERVISOR_PIN },
  });
  check('the administrator sets a supervisor PIN', pinSet.hasPin === true, pinSet);

  const approvers = await admin.call<{ supervisors: { id: string; fullName: string }[] }>(
    '/api/v1/pos/approvals',
  );
  check(
    'the till can see who is allowed to approve',
    approvers.supervisors.length === 1 && approvers.supervisors[0]?.fullName === ADMIN.fullName,
    approvers.supervisors,
  );

  // A cash refund has to come out of a drawer, and the one from section 7 was
  // counted and closed — so the cashier opens a fresh one.
  const secondShift = await cashier.call<{ id: number }>('/api/v1/shifts/current', {
    method: 'POST',
    body: { initialCash: 500 },
  });
  check('the cashier opens a drawer to refund out of', secondShift.id > 0, secondShift);

  /*
   * The gate, before the approval: the same request with no token has to be
   * refused. This is the assertion that makes the rest of the section meaningful —
   * without it, a route that had quietly stopped asking for an approval would
   * still pass every check below.
   */
  const ungated = await cashier.request(`/api/v1/orders/${sale.orderId}/refund`, {
    method: 'POST',
    body: {
      reason: 'ลูกค้าแจ้งว่าสินค้าชำรุด',
      refundMethod: 'cash',
      shiftId: secondShift.id,
    },
  });
  check('a refund without a supervisor approval is refused (403)', ungated.status === 403, ungated.status);

  const wrongPin = await cashier.request('/api/v1/pos/approvals', {
    method: 'POST',
    body: {
      supervisorId: approvers.supervisors[0]?.id,
      pin: '1379',
      action: 'refund_order',
      targetId: sale.orderId,
    },
  });
  check('a wrong supervisor PIN is refused', wrongPin.status === 401 || wrongPin.status === 403, wrongPin.status);

  const grant = await cashier.call<{ token: string; approverName: string }>(
    '/api/v1/pos/approvals',
    {
      method: 'POST',
      body: {
        supervisorId: approvers.supervisors[0]?.id,
        pin: SUPERVISOR_PIN,
        action: 'refund_order',
        targetId: sale.orderId,
      },
    },
  );
  check('the supervisor approves the refund', typeof grant.token === 'string', grant.approverName);

  const refunded = await cashier.request<RefundDto>(`/api/v1/orders/${sale.orderId}/refund`, {
    method: 'POST',
    headers: { 'x-supervisor-token': grant.token },
    body: {
      reason: 'ลูกค้าแจ้งว่าสินค้าชำรุด',
      refundMethod: 'cash',
      shiftId: secondShift.id,
    },
  });
  check('the refund completes', refunded.data?.status === 'refunded', refunded.error ?? refunded.data);
  check(
    'it is numbered from its own series, not the receipt series',
    /^CN-\d{4}-000001$/.test(refunded.data?.documentNumber ?? ''),
    refunded.data?.documentNumber,
  );
  check(
    'the whole bill comes back: 107.00 in one unit',
    refunded.data?.finalAmountThb === COFFEE.price && refunded.data?.returnedUnits === 1,
    refunded.data,
  );

  const restocked = (await admin.call<ProductDto[]>(`/api/v1/products?barcode=${COFFEE.barcode}`))[0];
  check(
    'the unit is back on the shelf',
    restocked?.stockQty === COFFEE.stock && restocked?.availableQty === COFFEE.stock,
    restocked,
  );

  const refundLogs = await admin.call<StockLogDto[]>(
    `/api/v1/inventory/logs?productId=${coffee?.id ?? ''}`,
  );
  check(
    'the return is its own kind of stock movement',
    refundLogs[0]?.movementType === 'pos_refund' && refundLogs[0]?.qtyChanged === 1,
    refundLogs[0],
  );

  const note = await admin.call<CreditNoteDto>(`/api/v1/orders/${sale.orderId}/credit-note`);
  check(
    "the credit note reverses the sale's own tax figures",
    note.creditNote.netThb === 100 &&
      note.creditNote.vatThb === 7 &&
      note.creditNote.finalAmountThb === COFFEE.price,
    note.creditNote,
  );
  check(
    'it references the invoice it reverses',
    note.creditNote.original.receiptNumber === sale.receiptNumber,
    note.creditNote.original.receiptNumber,
  );
  check(
    "it prints the renter's shop identity, not ours",
    note.shop.name === SHOP.name && note.shop.taxId === SHOP.taxId,
    note.shop,
  );
  check(
    'and names both people: who was at the till, and who allowed it',
    note.creditNote.issuedBy === CASHIER.fullName && note.creditNote.approvedBy === ADMIN.fullName,
    `${note.creditNote.issuedBy} / ${note.creditNote.approvedBy}`,
  );
  check(
    'the reason is on the document',
    note.creditNote.reason === 'ลูกค้าแจ้งว่าสินค้าชำรุด',
    note.creditNote.reason,
  );

  const shopAfterRefund = await admin.call<ShopDto>('/api/v1/shop');
  check(
    'a credit note does not consume a receipt number',
    Number(shopAfterRefund.receiptRunningNumber) === 1,
    shopAfterRefund.receiptRunningNumber,
  );

  /*
   * 500 float − 107 handed back. The sale was taken in the drawer that section 7
   * counted and closed, so the money leaves the drawer that is open *now* — which
   * is the only drawer the cashier will actually count, and the reason a refund
   * leg carries its own `shift_id` rather than inheriting the sale's. A figure that
   * did not move here would mean the cash was paid out of a drawer whose expected
   * total still claimed it.
   */
  const drawerAfterRefund = await cashier.call<{ shift: { expectedCashThb: number } | null }>(
    '/api/v1/shifts/current',
  );
  check(
    'the refund comes out of the drawer that is open now (500 − 107 = 393)',
    drawerAfterRefund.shift?.expectedCashThb === 393,
    drawerAfterRefund.shift?.expectedCashThb,
  );

  const refundAgain = await cashier.request(`/api/v1/orders/${sale.orderId}/refund`, {
    method: 'POST',
    headers: { 'x-supervisor-token': grant.token },
    body: {
      reason: 'คืนซ้ำ',
      refundMethod: 'cash',
      shiftId: secondShift.id,
    },
  });
  check('a second refund is refused', refundAgain.status === 409, refundAgain.status);

  const trail = await admin.call<AuditPageDto>('/api/v1/audit?action=refund_order');
  check(
    'the refund is in the audit trail, with the amount and the reason',
    trail.total === 1 && trail.entries[0]?.detail?.finalAmountThb === COFFEE.price,
    trail.entries[0],
  );

  /*
   * The receipt of a refunded sale is still reprintable, and the reprint must not
   * show the refund as a tender line: the customer paid 107.00, and a copy of that
   * document has to keep saying so even after the money went back.
   */
  const receiptAfterRefund = await cashier.call<{
    receipt: { tenders: { method: string; amountThb: number }[]; finalAmountThb: number };
  }>(`/api/v1/orders/${sale.orderId}/receipt`);
  check(
    'the original receipt still reprints without the refund leg on it',
    receiptAfterRefund.receipt.tenders.length === 1 &&
      receiptAfterRefund.receipt.tenders[0]?.amountThb === COFFEE.price,
    receiptAfterRefund.receipt.tenders,
  );

  /* ----------------------------- 10. a transfer that closes its own bill */
  section('10. A bank notification that closes its own bill');

  /*
   * The shop's own QR, which needs PromptPay configured. Done here rather than in
   * the wizard because a shop that takes transfers turns this on later, in
   * settings — and the journey should take the same road.
   */
  const settings = await admin.call<ShopDto & { promptpayId?: string | null }>('/api/v1/shop');
  const withPromptPay = await cashier.request('/api/v1/shop', {
    method: 'PUT',
    body: {
      name: settings.name,
      branchLabel: settings.branchLabel,
      taxId: settings.taxId,
      isVatRegistered: settings.isVatRegistered,
      vatRate: settings.vatRate,
      receiptPrefix: settings.receiptPrefix,
      promptpayId: '0812345678',
      promptpayType: 'mobile',
    },
  });
  check(
    'a cashier cannot configure where the shop receives money (403)',
    withPromptPay.status === 403,
    withPromptPay.status,
  );

  await admin.call('/api/v1/shop', {
    method: 'PUT',
    body: {
      name: settings.name,
      branchLabel: settings.branchLabel,
      taxId: settings.taxId,
      isVatRegistered: settings.isVatRegistered,
      vatRate: settings.vatRate,
      receiptPrefix: settings.receiptPrefix,
      promptpayId: '0812345678',
      promptpayType: 'mobile',
    },
  });

  const qr = await cashier.call<{ ref: string; status: string; amountThb: number }>(
    '/api/v1/payments/intents',
    { method: 'POST', body: { shiftId: secondShift.id, amountThb: COFFEE.price } },
  );
  check(
    'the till shows a QR for the amount due',
    qr.status === 'pending' && qr.amountThb === COFFEE.price,
    qr,
  );

  const unauthenticated = await anonymous.request('/api/v1/payments/inbound', {
    method: 'POST',
    body: { amountThb: COFFEE.price, text: `โอน ${qr.ref}` },
  });
  check(
    'a notification without the shop\'s secret is refused',
    unauthenticated.status >= 400 && unauthenticated.status < 500,
    unauthenticated.status,
  );

  const wrongSecret = await anonymous.request('/api/v1/payments/inbound', {
    method: 'POST',
    headers: { 'x-payment-secret': 'not-the-secret' },
    body: { amountThb: COFFEE.price, text: `โอน ${qr.ref}` },
  });
  check(
    'and so is one with the wrong secret',
    wrongSecret.status >= 400 && wrongSecret.status < 500,
    wrongSecret.status,
  );

  const bridge = await anonymous.request<{
    status: string;
    intentRef: string | null;
    refusalReason: string | null;
  }>('/api/v1/payments/inbound', {
    method: 'POST',
    headers: { 'x-payment-secret': ACCEPT_BRIDGE_SECRET },
    body: {
      amountThb: COFFEE.price,
      text: `รับเงินโอน ${COFFEE.price.toFixed(2)} บาท ${qr.ref}`,
      source: 'bank-bridge',
      externalId: 'accept-mail-1',
    },
  });
  check(
    'a notification naming the QR closes it, with no human involved',
    bridge.data?.status === 'matched' && bridge.data?.intentRef === qr.ref,
    bridge.data ?? bridge.error,
  );

  const intentAfter = await cashier.call<{ status: string }>(`/api/v1/payments/intents/${qr.ref}`);
  check(
    'the QR the till is polling reads as paid',
    intentAfter.status === 'paid',
    intentAfter.status,
  );

  const repeated = await anonymous.request<{ duplicate: boolean }>('/api/v1/payments/inbound', {
    method: 'POST',
    headers: { 'x-payment-secret': ACCEPT_BRIDGE_SECRET },
    body: {
      amountThb: COFFEE.price,
      text: `รับเงินโอน ${COFFEE.price.toFixed(2)} บาท ${qr.ref}`,
      source: 'bank-bridge',
      externalId: 'accept-mail-1',
    },
  });
  check(
    'a bridge that retries records the same message once',
    repeated.data?.duplicate === true,
    repeated.data,
  );

  /*
   * The other half of the feature, and the reason the first half is safe: money
   * that cannot be attributed has to end up somewhere a person will look. An
   * amount with no reference is exactly that case, and it must not be guessed at
   * even though a QR for that amount is open.
   */
  const unreadable = await anonymous.request('/api/v1/payments/inbound', {
    method: 'POST',
    headers: { 'x-payment-secret': ACCEPT_BRIDGE_SECRET },
    body: { text: 'มีเงินเข้าบัญชี จำนวนหนึ่ง บาท', source: 'bank-bridge' },
  });
  check(
    'a notification it cannot read an amount out of is kept, not dropped',
    unreadable.status === 200,
    unreadable.status,
  );

  const unattributed = await admin.call<{
    transfers: { id: string; status: string; amountThb: number | null; refusalReason: string | null }[];
  }>('/api/v1/payments/inbound');
  check(
    'unattributed money is listed for a person, with the reason',
    unattributed.transfers.length === 1 &&
      unattributed.transfers[0]?.refusalReason === 'amount_unreadable',
    unattributed.transfers,
  );

  const dismissed = await cashier.request(`/api/v1/payments/inbound/${unattributed.transfers[0]?.id ?? ''}/dismiss`, {
    method: 'POST',
    body: { reason: 'โอนผิดบัญชี' },
  });
  check('a cashier cannot write off a transfer (403)', dismissed.status === 403, dismissed.status);

  await admin.call(`/api/v1/payments/inbound/${unattributed.transfers[0]?.id ?? ''}/dismiss`, {
    method: 'POST',
    body: { reason: 'โอนผิดบัญชี ไม่ใช่ยอดขาย' },
  });
  const cleared = await admin.call<{ transfers: unknown[] }>('/api/v1/payments/inbound');
  check('a dismissed transfer leaves the list', cleared.transfers.length === 0, cleared.transfers);

  const dismissTrail = await admin.call<AuditPageDto>(
    '/api/v1/audit?action=inbound_transfer_dismissed',
  );
  check(
    'and the decision is in the audit trail, with the reason',
    dismissTrail.total === 1 &&
      dismissTrail.entries[0]?.detail?.reason === 'โอนผิดบัญชี ไม่ใช่ยอดขาย',
    dismissTrail.entries[0],
  );

  /* ------------------------- 11. a pre-order, collected by QR */
  section('11. A pre-order the customer collects by QR');

  if (seedGuardUrl === null) {
    console.log(
      '  • skipped: the member fixture needs the scratch schema (not available with --base-url)',
    );
  } else {
    /*
     * The fixture, and it is the one thing in this journey that is not HTTP — see
     * `MEMBER`. No route in this application creates a customer, so a run that
     * places a pre-order has to be handed one, exactly as the setup wizard hands
     * it an administrator.
     */
    const fixture = await scratchClient(seedGuardUrl);
    try {
      await fixture.query(`SET search_path TO "${SCRATCH_SCHEMA}"`);
      await fixture.query(
        `INSERT INTO "users" ("full_name", "phone", "password_hash", "role", "is_active")
         VALUES ($1, $2, $3, 'member', true)`,
        [MEMBER.fullName, MEMBER.phone, await hashPassword(MEMBER.password)],
      );
    } finally {
      await fixture.end();
    }

    const member = new Session(() => base);
    await member.login({ identifier: MEMBER.phone, password: MEMBER.password });
    const memberMe = await member.call<{ role: string }>('/api/v1/auth/me');
    check('the customer signs in as a member', memberMe.role === 'member', memberMe.role);

    const beforePreOrder = (
      await admin.call<ProductDto[]>(`/api/v1/products?barcode=${COFFEE.barcode}`)
    )[0];

    const placed = await member.call<PreOrderPlacedDto>('/api/v1/orders', {
      method: 'POST',
      body: { type: 'preorder', lines: [{ productId: coffee?.id, quantity: 2 }] },
    });
    check('the customer places a pre-order for two', placed.status === 'pending', placed);

    const reserved = (
      await admin.call<ProductDto[]>(`/api/v1/products?barcode=${COFFEE.barcode}`)
    )[0];
    check(
      'two units leave the shelf for sale the moment they are promised',
      reserved?.availableQty === (beforePreOrder?.availableQty ?? 0) - 2,
      `${beforePreOrder?.availableQty} → ${reserved?.availableQty}`,
    );
    check(
      'but nothing has left stock yet — the promise is not a sale',
      reserved?.stockQty === beforePreOrder?.stockQty,
      `${beforePreOrder?.stockQty} → ${reserved?.stockQty}`,
    );

    const accepted = await cashier.call<{ status: string }>(
      `/api/v1/orders/${placed.orderId}/confirm`,
      { method: 'POST', body: {} },
    );
    check('staff accept it', accepted.status === 'confirmed', accepted.status);

    const packed = await cashier.call<{
      status: string;
      pickupPin: string;
      pickupExpiresAt: string;
    }>(`/api/v1/orders/${placed.orderId}/ready`, { method: 'POST' });
    check('packing it issues a 4-digit PIN', /^\d{4}$/.test(packed.pickupPin ?? ''), packed.pickupPin);
    check(
      'and a hold deadline in the future',
      new Date(packed.pickupExpiresAt).getTime() > Date.now(),
      packed.pickupExpiresAt,
    );

    const staffBoard = await admin.call<OrderBoardRowDto[]>(
      '/api/v1/orders?status=ready_for_pickup',
    );
    const packedRow = staffBoard.find((row) => row.orderNumber === placed.orderNumber);
    const shownCode = packedRow?.pickupToken ?? '';
    check(
      'the same screen also carries the signed code behind the QR',
      looksLikePickupToken(shownCode),
      shownCode.slice(0, 32),
    );

    const customerBoard = await member.call<OrderBoardRowDto[]>('/api/v1/orders');
    check(
      'the customer sees that code on their own order',
      customerBoard.find((row) => row.orderNumber === placed.orderNumber)?.pickupToken ===
        shownCode,
      customerBoard.find((row) => row.orderNumber === placed.orderNumber)?.pickupToken?.slice(0, 32),
    );

    const scanned = await cashier.call<PickupLookupDto>('/api/v1/orders/lookup', {
      method: 'POST',
      body: { pickupToken: shownCode },
    });
    check(
      'scanning it brings up exactly that parcel',
      scanned.orderNumber === placed.orderNumber,
      scanned.orderNumber,
    );

    const byPin = await cashier.call<PickupLookupDto>('/api/v1/orders/lookup', {
      method: 'POST',
      body: { pin: packed.pickupPin },
    });
    check(
      'and the PIN still works, for the customer whose phone is flat',
      byPin.orderNumber === placed.orderNumber,
      byPin.orderNumber,
    );

    /*
     * One character changed, the same edit the unit test makes. This is the leg that
     * checks the *status*: a bad code has to arrive as a refusal the cashier can read,
     * and it arrived as a 500 until `InvalidPickupTokenError` became a domain error.
     */
    const [header, payload, signature] = shownCode.split('.');
    const tampered = `${header}.${payload}.${signature?.startsWith('A') ? 'B' : 'A'}${signature?.slice(1)}`;
    const forged = await cashier.request('/api/v1/orders/lookup', {
      method: 'POST',
      body: { pickupToken: tampered },
    });
    check('a code with one character changed is refused as a bad code', forged.status === 422, {
      status: forged.status,
      error: forged.error,
    });

    const openShift = await cashier.call<{ shift: { id: number; status: string } | null }>(
      '/api/v1/shifts/current',
    );
    const handover = await cashier.call<OrderDto>(`/api/v1/orders/${placed.orderId}/complete`, {
      method: 'POST',
      body: {
        shiftId: openShift.shift?.id,
        settlement: { cash: placed.subtotalThb, receivedCash: placed.subtotalThb },
      },
    });
    check('the collection settles and closes the bill', handover.status === 'completed', handover);
    check(
      'the customer pays the price agreed when they ordered',
      handover.finalAmountThb === placed.subtotalThb,
      `${handover.finalAmountThb} vs ${placed.subtotalThb}`,
    );
    /*
     * Read off the document rather than off the response, because the document is
     * what the customer leaves with — and because this is the tax that was *frozen*
     * at handover. The order was placed at a price with no tax on it at all; the
     * handover is the moment the money and the tax both become real.
     */
    const handoverReceipt = await cashier.call<{
      receipt: { receiptNumber: string | null; netThb: number; vatThb: number };
    }>(`/api/v1/orders/${placed.orderId}/receipt`);
    check(
      'the tax is worked out at handover, not at placement',
      handoverReceipt.receipt.vatThb > 0 &&
        handoverReceipt.receipt.netThb + handoverReceipt.receipt.vatThb === placed.subtotalThb,
      handoverReceipt.receipt,
    );
    check(
      'and it takes the next number in the same gapless series',
      /^FR-\d{4}-000002$/.test(handoverReceipt.receipt.receiptNumber ?? ''),
      handoverReceipt.receipt.receiptNumber,
    );

    const afterPreOrder = (
      await admin.call<ProductDto[]>(`/api/v1/products?barcode=${COFFEE.barcode}`)
    )[0];
    check(
      'the two units leave the shelf when the parcel does',
      afterPreOrder?.stockQty === (beforePreOrder?.stockQty ?? 0) - 2 &&
        afterPreOrder?.availableQty === afterPreOrder?.stockQty,
      `${beforePreOrder?.stockQty}/${beforePreOrder?.availableQty} → ${afterPreOrder?.stockQty}/${afterPreOrder?.availableQty}`,
    );

    /*
     * Both credentials, after collection, and both are the same answer. Neither can
     * release the parcel a second time, because the code is minted only while an
     * order is waiting and the lookup filters on that status either way. The PIN
     * stays on the row as the record of what was issued — it is inert, and
     * `allocatePickupPin` only ever worries about PINs on parcels still on the shelf.
     */
    const codeAgain = await cashier.request('/api/v1/orders/lookup', {
      method: 'POST',
      body: { pickupToken: shownCode },
    });
    check('a code cannot collect the same parcel twice', codeAgain.status === 404, codeAgain.status);

    const pinAgain = await cashier.request('/api/v1/orders/lookup', {
      method: 'POST',
      body: { pin: packed.pickupPin },
    });
    check('nor can the PIN it was packed with', pinAgain.status === 404, pinAgain.status);

    const settledRow = (await member.call<OrderBoardRowDto[]>('/api/v1/orders')).find(
      (row) => row.orderNumber === placed.orderNumber,
    );
    check('the customer sees their own order settled', settledRow?.status === 'completed', settledRow?.status);
    check(
      'and the code is gone from the screen once the parcel is',
      settledRow?.pickupToken === null,
      settledRow?.pickupToken,
    );
  }

  console.log(
    failed === 0
      ? `\nacceptance: ${passed} passed, 0 failed`
      : `\nacceptance: ${passed} passed, ${failed} FAILED`,
  );
  return failed;
}

/* ------------------------------------------------------------------ driver */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const skipBuild = argv.includes('--skip-build');
  const keep = argv.includes('--keep');
  const baseUrlOption = argv.indexOf('--base-url');
  const providedBase = baseUrlOption === -1 ? null : argv[baseUrlOption + 1] ?? null;

  let child: ChildProcess | null = null;
  let scratch: string | null = null;

  const sourceUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;

  /*
   * The server this harness starts inherits this process's environment, so the
   * machine-confirmation secret has to be set here rather than in `.env` — a
   * run that depended on the renter's own secret would either fail or, worse,
   * pass by using one nobody configured.
   */
  if (!process.env.PAYMENT_WEBHOOK_SECRET) {
    process.env.PAYMENT_WEBHOOK_SECRET = ACCEPT_BRIDGE_SECRET;
  }

  console.log('');
  console.log('POS — virgin deployment acceptance run');
  console.log('=====================================');

  try {
    if (providedBase !== null) {
      base = providedBase.replace(/\/$/, '');
      console.log(`\nChecking the server already running at ${base}`);
    } else {
      if (sourceUrl === null) {
        throw new Error('Neither TEST_DATABASE_URL nor DATABASE_URL is set. Run `npm run setup` first.');
      }
      scratch = scratchUrl(sourceUrl, SCRATCH_SCHEMA);

      console.log(`\nScratch schema: ${SCRATCH_SCHEMA} (in ${new URL(sourceUrl).pathname.replace(/^\//, '')})`);
      console.log('\n1. Resetting the scratch schema');
      await resetScratchSchema(sourceUrl, SCRATCH_SCHEMA, true);
      console.log('  • dropped and recreated, so this starts from empty');

      console.log('\n2. Applying migrations to the empty schema');
      shell('prisma migrate deploy', 'npx prisma migrate deploy', { ...process.env, DATABASE_URL: scratch });

      if (skipBuild) {
        console.log('\n3. Build: skipped (--skip-build); reusing the existing .next output');
        if (!existsSync('.next/BUILD_ID')) {
          throw new Error('There is no .next build to reuse. Run without --skip-build.');
        }
      } else {
        console.log('\n3. Building (this also type-checks every route)');
        shell('next build', 'npx next build');
      }

      const port = await freePort(FIRST_PORT);
      base = `http://127.0.0.1:${port}`;
      console.log(`\n4. Serving the build on ${base}`);
      const started = startServer(scratch, port);
      child = started.child;
      await waitForServer(base, child, started.log);
      console.log(`  • up (${new Date().toISOString()})`);
    }

    const failures = await runChecks(scratch);

    if (child !== null) {
      console.log('\n5. Shutting the acceptance server down');
      await stopServer(child);
      child = null;
      console.log('  • stopped');
    }

    if (scratch !== null && !keep) {
      await resetScratchSchema(sourceUrl as string, SCRATCH_SCHEMA, false);
      console.log('\n6. Scratch schema dropped');
    } else if (scratch !== null) {
      console.log(`\n6. Scratch schema kept: ${scratch}`);
    }

    console.log('');
    process.exit(failures === 0 ? 0 : 1);
  } catch (error) {
    if (child !== null) {
      await stopServer(child);
    }
    console.error(`\nAcceptance run could not complete:\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

void main();
