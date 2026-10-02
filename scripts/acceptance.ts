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
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { roundThb } from '../src/lib/money';
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
 * These are the details the *intent* is built from, not a row: an earlier version
 * inserted this account with SQL, because no route created members and a shop that
 * had just installed the software therefore had nobody who could place a pre-order.
 * The manager now enrols them through the API (ADR 0010), and the cashier enrols a
 * second one at the till (ADR 0011) — so every account this journey uses is made by
 * somebody the journey itself signed in.
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

/**
 * A gateway this run owns, for the OTP door (ADR 0020 §5).
 *
 * Created before the app server is started, because the app reads its OTP
 * configuration from the environment at boot — the same constraint section 12's
 * notification gateway does not have, since its worker is spawned per run.
 */
let otpGateway: Server | null = null;
/** What the app posted to the OTP gateway, in order. */
const otpInbox: { to?: string; code?: string; text?: string; kind?: string }[] = [];

/**
 * A Google key set this run serves itself, and the key that signs its tokens.
 *
 * The Google door verifies against Google's published JWKS; the acceptance run points
 * `GOOGLE_JWKS_URL` at a JWKS it owns (see `readGoogleJwksUrl`) and mints tokens with a
 * key it generated, so the whole sign-in path is exercised without a live Google — the
 * same trade the notification and OTP gateways make.
 */
let googleJwks: Server | null = null;
let googlePrivateKey: CryptoKey | null = null;
const GOOGLE_TEST_CLIENT_ID = 'acceptance.apps.googleusercontent.com';

/** A Google id token this deployment will accept, for one subject. */
async function googleIdToken(
  subject: string,
  overrides: { fullName?: string; email?: string } = {},
): Promise<string> {
  if (!googlePrivateKey) {
    throw new Error('The acceptance Google signing key was never generated');
  }
  return new SignJWT({
    email: overrides.email ?? `${subject}@example.com`,
    email_verified: true,
    name: overrides.fullName ?? 'ลูกค้า กูเกิล',
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(subject)
    .setIssuedAt()
    .setIssuer('https://accounts.google.com')
    .setAudience(GOOGLE_TEST_CLIENT_ID)
    .setExpirationTime('1h')
    .sign(googlePrivateKey);
}

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
  /** 1-based, within this sale: which note this is. */
  sequence: number;
  /** True when this note left something refundable behind. */
  partial: boolean;
  documentNumber: string;
  grossAmountThb: number;
  discountThb: number;
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
    sequence: number;
    isPartial: boolean;
    grossAmountThb: number;
    discountThb: number;
    lines: { name: string; quantity: number; unitPrice: number; totalPrice: number }[];
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

interface MemberDto {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  isActive: boolean;
  pointsBalance: number;
  orderCount: number;
  joinedAt: string;
}

/**
 * The Google door's two answers (ADR 0020 §1, §3).
 *
 * A **known** Google account answers like the password door — a session and the
 * customer's own figures — with no `linked`/`needsPhone` at all. An **unknown** one
 * answers `linked: false, needsPhone: true` and a name to prefill, having written
 * nothing. One shape holds both so the journey can assert which one it got.
 */
interface GoogleDoorDto {
  linked?: boolean;
  needsPhone?: boolean;
  fullName?: string | null;
  email?: string | null;
  id?: string;
  role?: string;
  pointsBalance?: number;
  redirectTo?: string;
}

/** What finishing a first Google sign-in answers: made, linked, or neither. */
interface GoogleSignupDto {
  id: string;
  role: string;
  fullName: string;
  pointsBalance: number;
  created: boolean;
  linked: boolean;
  redirectTo: string;
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

/**
 * A whole-row fingerprint of one order, so a download that touched *any* column
 * shows up — not just the handful a hand-written comparison would remember.
 */
async function orderFingerprint(url: string, orderId: string): Promise<string> {
  const client = await scratchClient(url);
  try {
    await client.query(`SET search_path TO "${SCRATCH_SCHEMA}"`);
    const rows = await client.query<{ fingerprint: string }>(
      'SELECT md5(o::text) AS fingerprint FROM "orders" o WHERE o."id" = $1',
      [orderId],
    );
    return rows.rows[0]?.fingerprint ?? 'missing';
  } finally {
    await client.end();
  }
}

/** Reads one order's completed-at, so a test can age it and put it back exactly. */
async function readCompletedAt(url: string, orderId: string): Promise<string | null> {
  const client = await scratchClient(url);
  try {
    await client.query(`SET search_path TO "${SCRATCH_SCHEMA}"`);
    const rows = await client.query<{ completed_at: string | null }>(
      'SELECT "completed_at"::text AS completed_at FROM "orders" WHERE "id" = $1',
      [orderId],
    );
    return rows.rows[0]?.completed_at ?? null;
  } finally {
    await client.end();
  }
}

/** Moves one order's sale instant, to test the access window; null clears it. */
async function setCompletedAt(url: string, orderId: string, iso: string | null): Promise<void> {
  const client = await scratchClient(url);
  try {
    await client.query(`SET search_path TO "${SCRATCH_SCHEMA}"`);
    await client.query('UPDATE "orders" SET "completed_at" = $2::timestamptz WHERE "id" = $1', [
      orderId,
      iso,
    ]);
  } finally {
    await client.end();
  }
}

/**
 * Writes one customer's points balance straight into the scratch schema.
 *
 * No API grants points — they are earned by sales — and the property under test in
 * section 16 is that lining a Google sign-in up against a row *leaves them alone*.
 * Making the figure non-zero first is the same trick section 9 uses to age an
 * order: it takes an assertion that would pass on 0 and makes it mean something.
 */
async function setPointsBalance(url: string, userId: string, points: number): Promise<void> {
  const client = await scratchClient(url);
  try {
    await client.query(`SET search_path TO "${SCRATCH_SCHEMA}"`);
    await client.query('UPDATE "users" SET "points_balance" = $2 WHERE "id" = $1', [
      userId,
      points,
    ]);
  } finally {
    await client.end();
  }
}

/**
 * How many rows, of any role, hold a phone number.
 *
 * The unique index already makes two impossible, so this is not the thing that
 * stops a split; it is the *observation* that the thing worked — after linking, the
 * one row is still one row, and the returning customer did not arrive as a second
 * member with the points left behind on the first.
 */
async function countUsersWithPhone(url: string, phone: string): Promise<number> {
  const client = await scratchClient(url);
  try {
    await client.query(`SET search_path TO "${SCRATCH_SCHEMA}"`);
    const rows = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "users" WHERE "phone" = $1',
      [phone],
    );
    return Number(rows.rows[0]?.count ?? '0');
  } finally {
    await client.end();
  }
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

  /* ------------------------------------------------- 6b. the receipt link */
  /*
   * A signed link a walk-in can carry away (ADR 0021 §2, §3). The counter mints
   * one for the sale in front of it; a visitor with no cookie jar at all opens it
   * and gets exactly this order's receipt; a tampered link is refused; a reissue is
   * a different token; and once the sale ages past the one-month window the file is
   * withheld while the bill itself still lists and reprints. The window half needs
   * the database, so it runs only when this script owns the schema.
   */
  const originalCompletedAt =
    seedGuardUrl === null ? null : await readCompletedAt(seedGuardUrl, sale.orderId);
  const beforeDownload =
    seedGuardUrl === null ? null : await orderFingerprint(seedGuardUrl, sale.orderId);

  const link = await cashier.call<{ token: string; path: string }>(
    `/api/v1/orders/${sale.orderId}/receipt-link`,
    { method: 'POST' },
  );
  check(
    'the counter mints a receipt link for the sale',
    /^\/api\/v1\/receipts\/[^/]+$/.test(link.path),
    link.path,
  );

  // No cookie jar and no session — the walk-in who never registered.
  const stranger = new Session(() => base);
  const downloaded = await stranger.call<{
    receipt: { receiptNumber: string | null; finalAmountThb: number };
  }>(link.path);
  check(
    'a walk-in with no session downloads exactly this order',
    downloaded.receipt.receiptNumber === sale.receiptNumber &&
      downloaded.receipt.finalAmountThb === sale.finalAmountThb,
    downloaded.receipt,
  );

  /*
   * The page the counter's QR points at. The link is handed over to be *seen*, so it
   * must open the receipt and not the JSON — the same token, read as a browser would.
   */
  const receiptPage = await stranger.raw(`/receipts?t=${encodeURIComponent(link.token)}`);
  const receiptPageHtml = await receiptPage.text();
  check(
    'and the same link opens a page that draws that receipt',
    receiptPage.status === 200 && receiptPageHtml.includes(sale.receiptNumber ?? '\u0000'),
    receiptPage.status,
  );

  /*
   * Flip the *first* character of the signature, not the last. Base64url decoders
   * tolerate non-canonical trailing bits, so a flipped last character can decode to
   * the very same signature bytes and verify — the mutation would be a no-op for
   * some tokens and the check would pass without testing anything.
   */
  const [linkHeader, linkPayload, linkSignature] = link.token.split('.');
  const tamperedToken = `${linkHeader}.${linkPayload}.${linkSignature!.startsWith('A') ? 'B' : 'A'}${linkSignature!.slice(1)}`;
  const refused = await stranger.request(`/api/v1/receipts/${tamperedToken}`);
  check('a link with one character changed is refused', refused.status === 422, refused.status);

  const relinked = await cashier.call<{ token: string }>(
    `/api/v1/orders/${sale.orderId}/receipt-link`,
    { method: 'POST' },
  );
  check('asking again reissues rather than reuses the link', relinked.token !== link.token);
  check(
    'and the reissued link still serves the order',
    (await stranger.call<{ receipt: { receiptNumber: string | null } }>(`/api/v1/receipts/${relinked.token}`))
      .receipt.receiptNumber === sale.receiptNumber,
  );

  if (beforeDownload !== null && originalCompletedAt !== null && seedGuardUrl !== null) {
    const afterDownload = await orderFingerprint(seedGuardUrl, sale.orderId);
    check(
      'a download does not touch the order it shows',
      afterDownload === beforeDownload,
      `${beforeDownload} → ${afterDownload}`,
    );

    /*
     * Age the sale past the window while leaving the link unexpired, so only the
     * window can be what refuses it. Then put the sale back.
     */
    const aged = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await setCompletedAt(seedGuardUrl, sale.orderId, aged);

    const closedFetch = await stranger.request(link.path);
    check('a link whose window has closed is refused as gone', closedFetch.status === 410, closedFetch.status);
    const closedMint = await cashier.request(`/api/v1/orders/${sale.orderId}/receipt-link`, {
      method: 'POST',
    });
    check('the counter cannot mint a link for an aged-out bill', closedMint.status === 410, closedMint.status);

    const stillThere = await cashier.call<{ receipt: { receiptNumber: string | null } }>(
      `/api/v1/orders/${sale.orderId}/receipt`,
    );
    check(
      'but the bill itself still lists, and still reprints',
      stillThere.receipt.receiptNumber === sale.receiptNumber,
      stillThere.receipt.receiptNumber,
    );
    const stillVisible = await cashier.request(`/api/v1/orders/${sale.orderId}`);
    check(
      'and the order stays visible while only the file is withheld',
      stillVisible.status === 200,
      stillVisible.status,
    );

    await setCompletedAt(seedGuardUrl, sale.orderId, originalCompletedAt);
    check(
      'once the sale is back inside the window the file is offered again',
      (await stranger.call<{ receipt: { receiptNumber: string | null } }>(link.path)).receipt.receiptNumber ===
        sale.receiptNumber,
    );
  }

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

  /* --------- 9b. a customer who brings back one item out of two */

  /*
   * The everyday case the whole-bill refund could not serve. Two items on the bill,
   * one comes back: the customer keeps the coffee and gets the water's money, and
   * the invoice stays exactly as it was issued — which is what makes a later visit
   * with the other item possible at all.
   */
  const water = (await admin.call<ProductDto[]>(`/api/v1/products?barcode=${WATER.barcode}`))[0];

  const pair = await cashier.call<OrderDto>('/api/v1/orders', {
    method: 'POST',
    body: {
      type: 'pos_walkin',
      shiftId: secondShift.id,
      lines: [
        { productId: coffee?.id, quantity: 1 },
        { productId: water?.id, quantity: 2 },
      ],
      settlement: { cash: COFFEE.price + WATER.price * 2 },
    },
  });
  check('a two-line sale rings up', pair.status === 'completed', pair.status);

  const pairDetail = await cashier.call<{
    items: { id: string; name: string; quantity: number; refundedQuantity: number; totalPrice: number }[];
  }>(`/api/v1/orders/${pair.orderId}`);
  const waterLine = pairDetail.items.find((item) => item.name === WATER.name);
  check(
    'nothing on it has been refunded yet',
    pairDetail.items.every((item) => item.refundedQuantity === 0),
    pairDetail.items.map((item) => item.refundedQuantity),
  );

  const partialGrant = await cashier.call<{ token: string }>('/api/v1/pos/approvals', {
    method: 'POST',
    body: {
      supervisorId: approvers.supervisors[0]?.id,
      pin: SUPERVISOR_PIN,
      action: 'refund_order',
      targetId: pair.orderId,
    },
  });

  const partialRefund = await cashier.call<RefundDto>(
    `/api/v1/orders/${pair.orderId}/refund`,
    {
      method: 'POST',
      headers: { 'x-supervisor-token': partialGrant.token },
      body: {
        reason: 'ลูกค้าคืนน้ำเปล่า 1 ขวด',
        refundMethod: 'cash',
        shiftId: secondShift.id,
        lines: [{ orderItemId: waterLine?.id, quantity: 1 }],
      },
    },
  );
  check(
    'the note reverses one line and leaves the bill standing',
    partialRefund.partial === true && partialRefund.status === 'completed',
    partialRefund,
  );
  check(
    `and pays back exactly that bottle (${WATER.price})`,
    partialRefund.finalAmountThb === WATER.price,
    partialRefund.finalAmountThb,
  );
  check('it is the first note on the bill', partialRefund.sequence === 1, partialRefund.sequence);

  const partialNote = await cashier.call<CreditNoteDto>(
    `/api/v1/orders/${pair.orderId}/credit-note`,
  );
  check(
    'the document itemises the bottle and nothing else',
    partialNote.creditNote.lines.length === 1 &&
      partialNote.creditNote.lines[0]?.name === WATER.name &&
      partialNote.creditNote.lines[0]?.quantity === 1,
    partialNote.creditNote.lines,
  );
  check(
    'and its own arithmetic reconciles: lines − discount = total',
    roundThb(partialNote.creditNote.grossAmountThb - partialNote.creditNote.discountThb) ===
      partialNote.creditNote.finalAmountThb,
    partialNote.creditNote,
  );

  const shelfAfterPartial = (await admin.call<ProductDto[]>(`/api/v1/products?barcode=${WATER.barcode}`))[0];
  check(
    'only that one unit is back on the shelf',
    shelfAfterPartial?.stockQty === WATER.stock - 2 + 1,
    `${WATER.stock} − 2 + 1 vs ${shelfAfterPartial?.stockQty}`,
  );

  /*
   * And the second visit, with what is left. This is the assertion the whole
   * feature turns on: the two notes together are the invoice, to the satang, so a
   * bill refunded in pieces cannot leave the shop holding money it owes.
   */
  const restGrant = await cashier.call<{ token: string }>('/api/v1/pos/approvals', {
    method: 'POST',
    body: {
      supervisorId: approvers.supervisors[0]?.id,
      pin: SUPERVISOR_PIN,
      action: 'refund_order',
      targetId: pair.orderId,
    },
  });

  const rest = await cashier.call<RefundDto>(`/api/v1/orders/${pair.orderId}/refund`, {
    method: 'POST',
    headers: { 'x-supervisor-token': restGrant.token },
    body: { reason: 'ลูกค้ากลับมาคืนที่เหลือ', refundMethod: 'cash', shiftId: secondShift.id },
  });
  check(
    'the second visit closes the bill',
    rest.partial === false && rest.status === 'refunded' && rest.sequence === 2,
    rest,
  );
  check(
    'and the two notes add up to the invoice exactly',
    roundThb(partialRefund.finalAmountThb + rest.finalAmountThb) === pair.finalAmountThb,
    `${partialRefund.finalAmountThb} + ${rest.finalAmountThb} vs ${pair.finalAmountThb}`,
  );

  const pairShelf = (await admin.call<ProductDto[]>(`/api/v1/products?barcode=${WATER.barcode}`))[0];
  check(
    'every unit is back, and none of them twice',
    pairShelf?.stockQty === WATER.stock,
    pairShelf?.stockQty,
  );

  const pairReceipt = await cashier.call<{
    receipt: { finalAmountThb: number; tenders: { method: string; amountThb: number }[] };
  }>(`/api/v1/orders/${pair.orderId}/receipt`);
  check(
    'and the invoice itself still reprints as issued',
    pairReceipt.receipt.finalAmountThb === pair.finalAmountThb &&
      pairReceipt.receipt.tenders.length === 1,
    pairReceipt.receipt,
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

  /*
   * Section 12 asserts on the code issued in section 11, so it is carried across
   * rather than re-derived: a message that names *a* PIN is not the same as one
   * that names the customer's own, and the second is the only useful property.
   */
  let packedPickupPin: string | null = null;

  /* ------------------------- 11. a pre-order, collected by QR */
  section('11. A pre-order the customer collects by QR');

  /*
   * The customer is enrolled the way a shop enrols one (ADR 0010). This used to be
   * the one leg of the journey that was not HTTP at all — a `member` row written
   * with SQL, because no route in the application created customers — which meant a
   * fresh shop could not place a pre-order at all. Now the manager adds them and the
   * customer signs in with the temporary password they were handed.
   */
  const enrolled = await admin.call<MemberDto>('/api/v1/members', {
    method: 'POST',
    body: { fullName: MEMBER.fullName, phone: MEMBER.phone, password: MEMBER.password },
  });
  check(
    'a manager enrols a customer at the counter',
    enrolled.phone === MEMBER.phone && enrolled.isActive && enrolled.pointsBalance === 0,
    enrolled,
  );

  /*
   * The same number, written the way a customer would write it. Uniqueness spans
   * every role and survives the punctuation, or a cashier's number could be reused
   * by a customer and the cashier would stop being able to sign in.
   */
  const duplicated = await admin.request('/api/v1/members', {
    method: 'POST',
    body: {
      fullName: 'สมชาย ซ้ำ',
      phone: MEMBER.phone.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3'),
      password: MEMBER.password,
    },
  });
  check(
    'and the same number written with dashes is refused as a duplicate (409)',
    duplicated.status === 409,
    duplicated.status,
  );

  /*
   * The counter enrols its own customer (ADR 0011). This check used to assert the
   * opposite — a 403 — and opening it up is the change: shops do this at the till,
   * and a cashier who has to walk to the back office is a cashier who does not.
   */
  const enrolledByCashier = await cashier.call<MemberDto>('/api/v1/members', {
    method: 'POST',
    body: {
      fullName: 'โดยแคชเชียร์',
      phone: '0800000999',
      password: 'accept-counter-1',
    },
  });
  check(
    'a cashier enrols a customer from the till',
    enrolledByCashier.phone === '0800000999' && enrolledByCashier.isActive,
    enrolledByCashier,
  );

  /*
   * The account the till made is a *customer*, and that is asserted the only way it
   * means anything: by signing in as them. The role is never read from a request
   * body, so the widest thing this route can mint is a member — and a route that
   * could mint a cashier would be a route to the drawer.
   */
  const counterCustomer = new Session(() => base);
  await counterCustomer.login({ identifier: '0800000999', password: 'accept-counter-1' });
  const counterCustomerMe = await counterCustomer.call<{ role: string }>('/api/v1/auth/me');
  check(
    'and the account it created is a customer, not staff',
    counterCustomerMe.role === 'member',
    counterCustomerMe.role,
  );

  /*
   * Adding a customer is a counter act; editing one is office work. The 403 the
   * journey used to look for did not disappear — it moved one method over.
   */
  const cashierEdits = await cashier.request(`/api/v1/members/${enrolledByCashier.id}`, {
    method: 'PATCH',
    body: { fullName: 'เปลี่ยนชื่อจากหน้าแคชเชียร์' },
  });
  check(
    'a cashier still cannot edit a customer account (403)',
    cashierEdits.status === 403,
    cashierEdits.status,
  );

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
  packedPickupPin = packed.pickupPin;
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
  /*
   * Gapless means *no number is skipped*, not that this happens to be the
   * second receipt of the run: the journey now rings up more bills before the
   * parcel is collected, so the expectation is derived from the last one
   * issued rather than hard-coded.
   */
  const lastReceiptNumber = pair.receiptNumber ?? '';
  const expectedReceiptNumber = lastReceiptNumber.replace(/(\d+)$/, (digits) =>
    String(Number(digits) + 1).padStart(digits.length, '0'),
  );
  check(
    'and it takes the next number in the same gapless series',
    expectedReceiptNumber !== '' &&
      handoverReceipt.receipt.receiptNumber === expectedReceiptNumber,
    `${handoverReceipt.receipt.receiptNumber} vs ${expectedReceiptNumber}`,
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
  check('the customer sees their own order settled', settledRow?.status === 'completed', settledRow?.status);  check(
    'and the code is gone from the screen once the parcel is',
    settledRow?.pickupToken === null,
    settledRow?.pickupToken,
  );

  /* ---------------------------- 11b. the customer's own account (ADR 0020) */
  /*
   * The portal's server half, driven over HTTP: the customer reads their own points
   * and their own receipt, and is refused somebody else's. The customer is still
   * signed in from the pre-order above, and the collection has just posted the
   * loyalty points, so the ledger is not empty. Before the trail sections that
   * tally globally, and before the admin's token is handed out below.
   */
  const points = await member.call<{
    balance: number;
    entries: { pointsChange: number; balanceAfter: number }[];
  }>('/api/v1/points');
  check(
    'the customer reads their own points ledger',
    points.entries.length > 0 && points.balance === points.entries[0]?.balanceAfter,
    { balance: points.balance, newest: points.entries[0] },
  );
  check(
    'and the points earned by the sale are on it',
    points.entries.some((entry) => entry.pointsChange > 0),
    points.entries,
  );

  const ownReceipt = await member.call<{ receipt: { orderNumber: string } }>(
    `/api/v1/orders/${placed.orderId}/receipt`,
  );
  check(
    'and the customer can read the receipt for their own order',
    ownReceipt.receipt.orderNumber === placed.orderNumber,
    ownReceipt.receipt.orderNumber,
  );

  // An order that is not theirs is refused — and the refusal is a 403, not a 404,
  // because the order exists and simply belongs to somebody else.
  const notMine = await member.request(`/api/v1/orders/${sale.orderId}/receipt`);
  check(
    'a receipt for an order that is not theirs is refused (403)',
    notMine.status === 403,
    notMine.status,
  );

  // Staff are neither scoped nor windowed: the counter still reprints the walk-in
  // sale, which is the same order the member was just refused.
  const staffReprint = await cashier.request(`/api/v1/orders/${sale.orderId}/receipt`);
  check(
    'and staff still reprint the same order the customer was refused',
    staffReprint.status === 200,
    staffReprint.status,
  );

  /* ---------------- 12. the shop hears about it without watching a screen */
  section('12. A message that leaves the building');

  if (seedGuardUrl === null) {
    console.log(
      '  • skipped: the delivery leg needs the scratch schema (not available with --base-url)',
    );
  } else {
    /*
     * A gateway the run owns. Pointing NOTIFY_WEBHOOK_URL at a service would make
     * this leg a test of somebody else's uptime and somebody else's credentials;
     * a listener on the loopback interface proves the same thing — the shop's own
     * process posts the message it promised to post — with nothing to sign up for.
     */
    const received: { to?: string; text?: string; kind?: string }[] = [];
    const gateway = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        try {
          received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          received.push({ text: 'unparseable' });
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });

    const port = await freePort(3311);
    await new Promise<void>((resolve) => gateway.listen(port, '127.0.0.1', resolve));
    const gatewayUrl = `http://127.0.0.1:${port}/notify`;

    /**
     * One pass of the real worker, against the real database.
     *
     * Asynchronous on purpose, and that is not a style choice: `spawnSync` blocks
     * this process's event loop for as long as the worker runs, and the gateway
     * above is a listener *in this process*. Blocked, it accepts the connection and
     * never answers, so the worker times out reaching a server that is sitting
     * right there — which is exactly what this leg did the first time it was run,
     * and what it would have gone on doing while reporting "the worker failed".
     */
    const runWorker = async (
      url: string,
    ): Promise<{ status: number | null; output: string }> => {
      const child = spawn('npx tsx scripts/notify-worker.ts', {
        shell: true,
        env: {
          ...process.env,
          DATABASE_URL: seedGuardUrl,
          NOTIFY_CHANNEL: 'webhook',
          NOTIFY_WEBHOOK_URL: url,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });

      const status = await new Promise<number | null>((resolve) => {
        child.once('close', (code) => resolve(code));
      });
      return { status, output };
    };

    try {
      const pass = await runWorker(gatewayUrl);
      check('the worker runs and exits cleanly', pass.status === 0, pass.output.slice(-400));

      const kinds = received.map((message) => message.kind).sort();
      check(
        'both messages left the building: the shop’s and the customer’s',
        kinds.join(',') === 'order_ready,pre_order_placed',
        kinds,
      );

      const ready = received.find((message) => message.kind === 'order_ready');
      check(
        'the customer’s message went to the customer, with their own PIN in it',
        ready?.to === MEMBER.phone && ready?.text?.includes(packedPickupPin ?? '\u0000') === true,
        ready,
      );

      const placedMessage = received.find((message) => message.kind === 'pre_order_placed');
      check(
        'the shop’s note went to the shop and names the order',
        placedMessage?.to === ADMIN.phone && (placedMessage?.text ?? '').includes('PO-'),
        placedMessage,
      );

      /*
       * The queue has to be *empty*, not merely quiet: a worker that delivered
       * everything but left the rows pending would send all of it again on the
       * next pass, which is how one order becomes three text messages.
       */
      const after = await scratchClient(seedGuardUrl);
      const statuses = await (async () => {
        try {
          await after.query(`SET search_path TO "${SCRATCH_SCHEMA}"`);
          const rows = await after.query<{ status: string; count: string }>(
            'SELECT "status"::text AS status, COUNT(*)::text AS count FROM "notifications" GROUP BY "status"',
          );
          return rows.rows;
        } finally {
          await after.end();
        }
      })();
      check(
        'every queued message is recorded as sent',
        statuses.length === 1 && statuses[0]?.status === 'sent' && statuses[0]?.count === '2',
        statuses,
      );

      const again = await runWorker(gatewayUrl);
      check(
        'a second pass sends nothing, so a retry cannot double-send',
        again.status === 0 && received.length === 2,
        `received ${received.length}`,
      );

      /*
       * And the failure path, which is the half a shop actually discovers. The
       * message is put back the way a shop would after fixing its configuration,
       * the worker is pointed at a port nothing listens on, and the run asserts
       * that the failure is *recorded* — with the gateway's own words — rather
       * than swallowed by a script that exits with a stack trace.
       */
      const requeue = await scratchClient(seedGuardUrl);
      try {
        await requeue.query(`SET search_path TO "${SCRATCH_SCHEMA}"`);
        await requeue.query(
          `UPDATE "notifications" SET "status" = 'pending', "attempts" = 0, "sent_at" = NULL,
                  "next_attempt_at" = now()
           WHERE "kind" = 'order_ready'`,
        );
      } finally {
        await requeue.end();
      }

      const broken = await runWorker('http://127.0.0.1:9/notify');
      check('a gateway that is not there does not crash the worker', broken.status === 0, broken.output.slice(-200));
      check(
        'and the failure is written down, so somebody can find it',
        broken.output.includes('Could not reach'),
        broken.output.trim().split('\n').slice(-3).join(' '),
      );

      const failures = await scratchClient(seedGuardUrl);
      const failedRow = await (async () => {
        try {
          await failures.query(`SET search_path TO "${SCRATCH_SCHEMA}"`);
          const rows = await failures.query<{ last_error: string | null; attempts: number; status: string }>(
            `SELECT "last_error", "attempts", "status"::text AS status FROM "notifications"
             WHERE "kind" = 'order_ready'`,
          );
          return rows.rows[0];
        } finally {
          await failures.end();
        }
      })();
      check(
        'the failed message is still queued, with the error attached',
        failedRow?.status === 'pending' &&
          failedRow.attempts === 1 &&
          (failedRow.last_error ?? '').includes('127.0.0.1:9'),
        failedRow,
      );
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }

  /* ---------------- 13. a door that counts the attempts */
  section('13. A door that counts the attempts');

  /*
   * Last on purpose. This leg spends a bucket, and a bucket spent in the middle
   * of the journey would make some later refusal look like the feature under test
   * when it was really the limiter. The identifier is one nobody has an account
   * for, so the only buckets it touches are this section's own.
   */
  const guessed = 'nobody-here@example.com';
  const wrongAttempts: number[] = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const refusal = await anonymous.request('/api/v1/auth/login', {
      method: 'POST',
      body: { identifier: guessed, password: 'not-the-password' },
    });
    wrongAttempts.push(refusal.status);
  }

  check(
    'ten wrong passwords are refused one at a time (401)',
    wrongAttempts.slice(0, 10).every((status) => status === 401),
    wrongAttempts,
  );
  check(
    'and the eleventh is refused by the door itself, not by the password (429)',
    wrongAttempts[10] === 429,
    wrongAttempts,
  );

  /*
   * The wait is read off the body rather than a header, because the envelope is
   * what every client here already parses and a second contract for the same fact
   * is a second thing to keep true.
   */
  const limitedResponse = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: guessed, password: 'not-the-password' }),
  });
  const limitedBody = (await limitedResponse.json()) as {
    error?: { code?: string; retryAfterSeconds?: number };
  };
  check(
    'and it says how long to wait, in the body the till already reads',
    limitedResponse.status === 429 &&
      limitedBody.error?.code === 'RATE_LIMITED' &&
      (limitedBody.error?.retryAfterSeconds ?? 0) > 0,
    limitedBody.error,
  );

  /*
   * The property that makes this usable in a shop: the bucket is the *account and
   * the address*, so guessing at one login cannot lock a colleague out of the till
   * standing next to it.
   */
  const colleague = new Session(() => base);
  const signedIn = await colleague.request('/api/v1/auth/login', {
    method: 'POST',
    body: { identifier: CASHIER.phone, password: CASHIER.password },
  });
  check(
    'and a guessed account does not lock the shop out of its own till',
    signedIn.status === 200 && signedIn.data !== null,
    signedIn.error ?? signedIn.status,
  );

  const limitedTrail = await admin.call<AuditPageDto>('/api/v1/audit?action=rate_limited');
  check(
    'the burst is written to the trail exactly once, not once per attempt',
    limitedTrail.total === 1,
    limitedTrail.total,
  );
  check(
    'and the row names the door and the account that was guessed at',
    limitedTrail.entries[0]?.detail?.policy === 'login_failure' &&
      limitedTrail.entries[0]?.detail?.scope === guessed,
    limitedTrail.entries[0],
  );

  /* ---------------- 14. a till that cannot mint accounts without limit */
  section('14. A session that cannot enrol customers without limit');

  /*
   * Section 11 proved the counter may enrol a customer; this is the other half of
   * that decision (ADR 0011 §6). What the door makes is a credential that reserves
   * stock without paying for it, so its *volume* is bounded — where the volume of
   * sales the same session rings up all day deliberately is not.
   *
   * Last, and after section 13, because it is the second policy to trip and the
   * first one asserts the trail holds exactly its own row.
   */
  const cashierAccount = await cashier.call<{ id: string }>('/api/v1/auth/me');
  const burstStatuses: number[] = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await cashier.request('/api/v1/members', {
      method: 'POST',
      body: {
        fullName: `ลูกค้าระดม ${attempt + 1}`,
        phone: `0810000${String(attempt).padStart(3, '0')}`,
        password: 'accept-burst-1',
      },
    });
    burstStatuses.push(result.status);
    if (result.status === 429) {
      break;
    }
  }

  check(
    'a session that enrols customers one after another is refused (429)',
    burstStatuses.at(-1) === 429,
    burstStatuses,
  );
  check(
    'and it let a counter\u2019s worth through first, so the ceiling is not felt by people',
    burstStatuses.filter((status) => status < 300).length >= 5,
    burstStatuses.length,
  );

  /*
   * Read off the body, as section 13 reads its own: the wait is in the envelope
   * every client here already parses, and the till's dialog shows the sentence to
   * the cashier verbatim.
   */
  const limitedEnrol = await fetch(`${base}/api/v1/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cashier.cookieHeader() },
    body: JSON.stringify({
      fullName: 'หลังถูกจำกัด',
      phone: '08100000999',
      password: 'accept-burst-1',
    }),
  });
  const limitedEnrolBody = (await limitedEnrol.json()) as {
    error?: { code?: string; retryAfterSeconds?: number };
  };
  check(
    'and the refusal carries the wait the dialog already reads',
    limitedEnrol.status === 429 &&
      limitedEnrolBody.error?.code === 'RATE_LIMITED' &&
      (limitedEnrolBody.error?.retryAfterSeconds ?? 0) > 0,
    limitedEnrolBody.error,
  );

  /*
   * The property that keeps this usable in a shop: the bucket is the *account*, so
   * a cashier who has spent theirs has not stopped the manager's session — and two
   * tills on the shop's one wifi are two budgets rather than one.
   */
  const managerEnrols = await admin.call<MemberDto>('/api/v1/members', {
    method: 'POST',
    body: {
      fullName: 'โดยผู้จัดการ หลังแคชเชียร์ถูกจำกัด',
      phone: '08100000998',
      password: 'accept-burst-1',
    },
  });
  check(
    'and another account at the same shop is not locked out',
    managerEnrols.phone === '08100000998',
    managerEnrols.phone,
  );

  const enrolTrail = await admin.call<AuditPageDto>('/api/v1/audit?action=rate_limited');
  const enrolRows = enrolTrail.entries.filter(
    (entry) => entry.detail?.policy === 'member_create',
  );
  check(
    'the enrolment burst is written to the trail once, naming the door and the account',
    enrolRows.length === 1 && enrolRows[0]?.detail?.scope === cashierAccount.id,
    enrolRows[0] ?? enrolTrail.total,
  );

  /* ------------------------------------------- 15. a code that costs money */
  section('15. A code to prove a phone');
  if (seedGuardUrl !== null) {
    /*
     * The OTP door (ADR 0020 §5) is unauthenticated on purpose, and every call pays
     * to text somebody. The run points it at a gateway it owns and asserts the code
     * gets there, then that a burst is refused — the two things a shop cannot afford
     * to get wrong about a door that spends money per attempt. Last, because the two
     * sections above count the trail globally and a trip here would be a third row.
     */
    const otpPhone = '0891112222';
    const before = otpInbox.length;
    const sent = await anonymous.call<{ sent: boolean; expiresInMinutes: number }>(
      '/api/v1/auth/otp',
      { method: 'POST', body: { phone: otpPhone } },
    );
    check('the OTP door accepts a send and reports success', sent.sent === true, sent);

    const delivered = otpInbox[before];
    check(
      "the code reaches the shop's gateway, addressed to the phone",
      delivered?.to === otpPhone && delivered?.kind === 'otp',
      delivered,
    );
    check(
      'and it is a six-digit code the customer can read',
      /^\d{6}$/.test(delivered?.code ?? ''),
      delivered?.code,
    );

    // Two more fills the per-number bucket of three; the fourth is refused by it.
    await anonymous.call('/api/v1/auth/otp', { method: 'POST', body: { phone: otpPhone } });
    await anonymous.call('/api/v1/auth/otp', { method: 'POST', body: { phone: otpPhone } });
    const burst = await anonymous.request('/api/v1/auth/otp', {
      method: 'POST',
      body: { phone: otpPhone },
    });
    check('a burst of sends to one number is refused (429)', burst.status === 429, burst.status);

    // The bucket is keyed by the number as well as the address, so a second person
    // is not locked out by the first one's burst.
    const other = await anonymous.call<{ sent: boolean }>('/api/v1/auth/otp', {
      method: 'POST',
      body: { phone: '0891113333' },
    });
    check(
      'and a different number still sends, so one person cannot lock the door for another',
      other.sent === true,
      other,
    );
  }

  /* ---------------------------- 16. One customer behind two ways in (ADR 0020) */
  section('16. A Google sign-in that makes a customer, and one that links');
  if (seedGuardUrl !== null) {
    /*
     * The failure this section exists to catch is a split balance (ADR 0020 §4): a
     * returning customer whose phone already has a row, and a second row made for
     * the same person with the points left behind on the first. The Google door is
     * driven against a JWKS this run serves itself, so the whole path — verify the
     * token, prove the phone, write one row — runs with no live Google. Last,
     * because the sections above tally the trail globally.
     */

    // (a) A number nobody owns becomes a customer, with Google supplying the name.
    const newSubject = 'accept-google-new';
    const newPhone = '0862220001';
    const firstContact = await anonymous.request<GoogleDoorDto>('/api/v1/auth/google', {
      method: 'POST',
      body: { idToken: await googleIdToken(newSubject, { fullName: 'ลูกค้าใหม่ จากกูเกิล' }) },
    });
    check(
      'an unknown Google account is asked for a phone, not signed in',
      firstContact.status === 200 &&
        firstContact.data?.linked === false &&
        firstContact.data?.needsPhone === true,
      firstContact.data,
    );
    check(
      'and the door offers the name Google gave, so the form can prefill it',
      firstContact.data?.fullName === 'ลูกค้าใหม่ จากกูเกิล',
      firstContact.data?.fullName,
    );

    const newBefore = otpInbox.length;
    await anonymous.call('/api/v1/auth/otp', { method: 'POST', body: { phone: newPhone } });
    const newCode = otpInbox[newBefore]?.code ?? '';

    const newSession = new Session(() => base);
    const created = await newSession.call<GoogleSignupDto>('/api/v1/auth/signup', {
      method: 'POST',
      body: { idToken: await googleIdToken(newSubject), phone: newPhone, code: newCode },
    });
    check(
      'the code completes a signup and the phone makes the customer',
      created.created === true && created.linked === false && created.role === 'member',
      created,
    );
    const newMe = await newSession.call<{ role: string }>('/api/v1/auth/me');
    check(
      'and the signup starts a session, so the customer is signed in',
      newMe.role === 'member',
      newMe.role,
    );

    // The subject now resolves to that row, so a second visit needs no code at all.
    const again = await anonymous.call<GoogleDoorDto>('/api/v1/auth/google', {
      method: 'POST',
      body: { idToken: await googleIdToken(newSubject) },
    });
    check(
      'a second visit with the same Google account signs straight in, with no code',
      again.id === created.id && again.role === 'member',
      again,
    );

    // (b) A number the counter already enrolled links to that row, never a second.
    await setPointsBalance(seedGuardUrl, enrolled.id, 120);
    const linkSubject = 'accept-google-returning';
    const linkBefore = otpInbox.length;
    await anonymous.call('/api/v1/auth/otp', { method: 'POST', body: { phone: MEMBER.phone } });
    const linkCode = otpInbox[linkBefore]?.code ?? '';

    const linkSession = new Session(() => base);
    const linked = await linkSession.call<GoogleSignupDto>('/api/v1/auth/signup', {
      method: 'POST',
      body: {
        idToken: await googleIdToken(linkSubject, { fullName: 'ชื่อจากกูเกิล' }),
        phone: MEMBER.phone,
        code: linkCode,
      },
    });
    check(
      'a Google sign-in on a number the counter enrolled links to that same row',
      linked.id === enrolled.id && linked.linked === true && linked.created === false,
      { linkedId: linked.id, enrolledId: enrolled.id },
    );
    check(
      'and the points earned at the counter stay on that one customer',
      linked.pointsBalance === 120,
      linked.pointsBalance,
    );
    const rowsForPhone = await countUsersWithPhone(seedGuardUrl, MEMBER.phone);
    check(
      'without splitting the number into a second customer',
      rowsForPhone === 1,
      rowsForPhone,
    );

    // (c) Now that the number is linked, a different Google account cannot take it.
    const thiefBefore = otpInbox.length;
    await anonymous.call('/api/v1/auth/otp', { method: 'POST', body: { phone: MEMBER.phone } });
    const thiefCode = otpInbox[thiefBefore]?.code ?? '';
    const thief = await anonymous.request('/api/v1/auth/signup', {
      method: 'POST',
      body: {
        idToken: await googleIdToken('accept-google-thief'),
        phone: MEMBER.phone,
        code: thiefCode,
      },
    });
    check(
      'and a second Google account is refused the number (409)',
      thief.status === 409,
      thief.status,
    );

    // (d) A number a staff account holds is refused as a customer, and stays staff.
    const staffBefore = otpInbox.length;
    await anonymous.call('/api/v1/auth/otp', { method: 'POST', body: { phone: ADMIN.phone } });
    const staffCode = otpInbox[staffBefore]?.code ?? '';
    const staffAttempt = await anonymous.request('/api/v1/auth/signup', {
      method: 'POST',
      body: {
        idToken: await googleIdToken('accept-google-staff'),
        phone: ADMIN.phone,
        code: staffCode,
      },
    });
    check(
      'a number a staff account holds is refused as a customer (409)',
      staffAttempt.status === 409,
      staffAttempt.status,
    );
  }

  /* --------------------- 17. A customer moves their number, and proves it */
  section('17. A phone change proves the new number');
  if (seedGuardUrl !== null) {
    /*
     * ADR 0020 §5: OTP verifies once at signup and again on every phone change. The
     * number is the identity, so this is the higher-risk act — moving it without
     * proof, or onto one somebody already holds, is what the rule must refuse. Last,
     * because the sections above tally the trail globally.
     */
    const beforeChange = await member.call<{ phone: string; pointsBalance: number }>(
      '/api/v1/auth/me',
    );
    check(
      'the customer starts on the number the counter enrolled',
      beforeChange.phone === MEMBER.phone,
      beforeChange.phone,
    );

    // No proof, no move.
    const noProof = await member.request('/api/v1/auth/phone', {
      method: 'PATCH',
      body: { phone: '0864440001', code: '000000' },
    });
    check('a phone change without a proved number is refused (422)', noProof.status === 422, noProof.status);

    // The new number is proved by a code *sent to it*.
    const newPhone = '0864440002';
    const changeBefore = otpInbox.length;
    await anonymous.call('/api/v1/auth/otp', { method: 'POST', body: { phone: newPhone } });
    const changeCode = otpInbox[changeBefore]?.code ?? '';
    const changed = await member.call<{ phone: string; pointsBalance: number }>('/api/v1/auth/phone', {
      method: 'PATCH',
      body: { phone: newPhone, code: changeCode },
    });
    check(
      'the code sent to the new number moves the customer onto it',
      changed.phone === newPhone,
      changed.phone,
    );
    check(
      'and the points move with the identity, on the same row',
      changed.pointsBalance === 120,
      changed.pointsBalance,
    );

    const afterChange = await member.call<{ phone: string }>('/api/v1/auth/me');
    check(
      'and the re-issued session and the row agree on the new number at once',
      afterChange.phone === newPhone,
      afterChange.phone,
    );

    // And the moved-to number is now the way in, with the password they were handed.
    const reLogin = new Session(() => base);
    await reLogin.login({ identifier: newPhone, password: MEMBER.password });
    check(
      'the customer signs in on the new number with their counter password',
      (await reLogin.call<{ phone: string }>('/api/v1/auth/me')).phone === newPhone,
      newPhone,
    );

    // A phone is the identity, so the change is a security event worth the trail.
    const phoneTrail = await admin.call<AuditPageDto>('/api/v1/audit?action=member_updated');
    const phoneRow = phoneTrail.entries.find(
      (entry) =>
        Array.isArray(entry.detail?.fields) && (entry.detail?.fields as unknown[]).includes('phone'),
    );
    check(
      'and the change is audited with the number it came from',
      phoneRow?.detail?.previousPhone === MEMBER.phone,
      phoneRow?.detail ?? null,
    );

    // A number a staff account holds is refused, exactly as enrolment refuses it.
    const takenBefore = otpInbox.length;
    await anonymous.call('/api/v1/auth/otp', { method: 'POST', body: { phone: ADMIN.phone } });
    const takenCode = otpInbox[takenBefore]?.code ?? '';
    const taken = await member.request('/api/v1/auth/phone', {
      method: 'PATCH',
      body: { phone: ADMIN.phone, code: takenCode },
    });
    check(
      'and moving onto a number a staff account holds is refused (409)',
      taken.status === 409,
      taken.status,
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

  /*
   * And this run configures its own notification channel, for the same reason: a
   * journey that depended on the renter's gateway would either fail or — worse —
   * pass by having queued nothing at all, because a shop with no channel is
   * *designed* to queue nothing. Section 12 then sends through it.
   */
  process.env.NOTIFY_CHANNEL = 'webhook';
  process.env.NOTIFY_STAFF_TO = ADMIN.phone;

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

      /*
       * The OTP gateway, in this process, and pointed at by the app's own
       * environment before it boots. A real SMS provider would make this leg a test
       * of somebody else's uptime; a loopback listener proves the same thing — the
       * code leaves the door — with nothing to sign up for.
       */
      const otpPort = await freePort(3312);
      otpGateway = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          try {
            otpInbox.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            otpInbox.push({ text: 'unparseable' });
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ok":true}');
        });
      });
      await new Promise<void>((resolve) => otpGateway!.listen(otpPort, '127.0.0.1', resolve));
      process.env.OTP_CHANNEL = 'webhook';
      process.env.OTP_WEBHOOK_URL = `http://127.0.0.1:${otpPort}/otp`;

      // The Google door, pointed at a JWKS this run serves, before the app boots.
      const jwksPort = await freePort(3313);
      const pair = await generateKeyPair('RS256');
      googlePrivateKey = pair.privateKey;
      const publicJwk = await exportJWK(pair.publicKey);
      googleJwks = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ keys: [publicJwk] }));
      });
      await new Promise<void>((resolve) => googleJwks!.listen(jwksPort, '127.0.0.1', resolve));
      process.env.GOOGLE_CLIENT_ID = GOOGLE_TEST_CLIENT_ID;
      process.env.GOOGLE_JWKS_URL = `http://127.0.0.1:${jwksPort}/certs`;

      const port = await freePort(FIRST_PORT);
      base = `http://127.0.0.1:${port}`;
      console.log(`\n4. Serving the build on ${base}`);
      const started = startServer(scratch, port);
      child = started.child;
      await waitForServer(base, child, started.log);
      console.log(`  • up (${new Date().toISOString()})`);
    }

    const failures = await runChecks(scratch);

    if (otpGateway !== null) {
      await new Promise<void>((resolve) => otpGateway!.close(() => resolve()));
      otpGateway = null;
    }
    if (googleJwks !== null) {
      await new Promise<void>((resolve) => googleJwks!.close(() => resolve()));
      googleJwks = null;
    }

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
    if (otpGateway !== null) {
      await new Promise<void>((resolve) => otpGateway!.close(() => resolve()));
      otpGateway = null;
    }
    if (googleJwks !== null) {
      await new Promise<void>((resolve) => googleJwks!.close(() => resolve()));
      googleJwks = null;
    }
    if (child !== null) {
      await stopServer(child);
    }
    console.error(`\nAcceptance run could not complete:\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

void main();
