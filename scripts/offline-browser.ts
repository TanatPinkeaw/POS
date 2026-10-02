/** Real Chromium, real IndexedDB, real PostgreSQL; never a shop's schema. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import ts from 'typescript';
import { Session, csvForm, freePort, loadEnv, resetScratchSchema, scratchUrl, shell, startServer, stopServer, waitForServer } from './harness';

loadEnv();
const schema = 'offlinebrowser';
const source = process.env.TEST_DATABASE_URL;
if (!source || !new URL(source).pathname.toLowerCase().includes('test')) throw new Error('offline:browser requires TEST_DATABASE_URL naming a test database');
const scratch = scratchUrl(source, schema);
const keep = process.argv.includes('--keep');
const skipBuild = process.argv.includes('--skip-build');
let server: ChildProcess | null = null;
let browser: Browser | null = null;
let base = '';
let checks = 0;

function check(condition: unknown, message: string): asserts condition { assert.ok(condition, message); checks++; console.log(`  ✓ ${message}`); }

/** Compile only the shipped storage adapter for probing its public port in Chromium. */
async function storageProbe(page: Page): Promise<void> {
  const compiled = ts.transpileModule(readFileSync('src/lib/offline-db.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  await page.evaluate((code) => {
    const module = { exports: {} };
    new Function('module', 'exports', code)(module, module.exports);
    (window as unknown as { storageAdapter: unknown }).storageAdapter = module.exports;
  }, compiled.outputText);    const outcome = await page.evaluate(async () => {
    const adapter = (window as unknown as { storageAdapter: { createIndexedDbStorage(): { read(): Promise<unknown>; write(value: unknown): Promise<void> } } }).storageAdapter;
    const storage = adapter.createIndexedDbStorage();
    await storage.write({ snapshot: null, queue: [] });
    const original = IDBObjectStore.prototype.put;
    let requestSucceeded = false;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      const request = original.apply(this, args);
      request.addEventListener('success', () => { requestSucceeded = true; this.transaction.abort(); });
      return request;
    };
    let refused = false;
    try { await storage.write({ snapshot: null, queue: [{ clientRef: 'must-not-survive' }] }); } catch { refused = true; }
    finally { IDBObjectStore.prototype.put = original; }
    return { refused, requestSucceeded, state: await storage.read() };
  });
  check(outcome.refused && outcome.requestSucceeded, 'storage rejects a transaction aborted after request success');
  assert.deepEqual(outcome.state, { snapshot: null, queue: [] }); checks++;
}

async function state(page: Page): Promise<{ queue: { clientRef: string }[]; snapshot: { catalogue: unknown[]; heldBlocks: unknown[] } | null }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('pos-offline', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise((resolve, reject) => { const r = db.transaction('till').objectStore('till').get('state'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
    finally { db.close(); }
  });
}

async function main(): Promise<void> {
  try {
    await resetScratchSchema(source!, schema, true);
    shell('migrate browser scratch', 'npx prisma migrate deploy', { ...process.env, DATABASE_URL: scratch });
    if (!skipBuild) shell('production build', 'npm run build');
    else if (!existsSync('.next/BUILD_ID')) throw new Error('No production build to reuse');
    const port = await freePort(3331);
    base = `http://127.0.0.1:${port}`;
    const started = startServer(scratch, port); server = started.child;
    await waitForServer(base, server, started.log);
    const anonymous = new Session(() => base);
    await anonymous.call('/api/v1/setup', { method: 'POST', body: { shop: { name: 'ร้านทดสอบออฟไลน์', isVatRegistered: true, taxId: '1103700123456', vatRate: 7, receiptPrefix: 'OB' }, admin: { fullName: 'ผู้ดูแลทดสอบ', phone: '0800000500', password: 'browser-admin-1' } } });
    const admin = new Session(() => base); await admin.login({ identifier: '0800000500', password: 'browser-admin-1' });
    await admin.call('/api/v1/staff', { method: 'POST', body: { fullName: 'แคชเชียร์ทดสอบ', phone: '0800000501', password: 'browser-cashier-1', role: 'employee' } });
    const csv = ['บาร์โค้ด,ชื่อสินค้า,หมวดหมู่,ราคาทุน,ราคาขาย,จำนวนสต็อก', ...Array.from({ length: 65 }, (_, i) => `OB${String(i).padStart(3, '0')},สินค้าทดสอบ ${String(i).padStart(3, '0')},เครื่องดื่ม,50,100,20`)].join('\r\n');
    const imported = await admin.postForm('/api/v1/products/import', csvForm(csv, 'commit'));
    check(imported.status < 400, 'catalogue of 65 products imported');
    const cashier = new Session(() => base); await cashier.login({ identifier: '0800000501', password: 'browser-cashier-1' });
    await cashier.call('/api/v1/shifts/current', { method: 'POST', body: { initialCash: 500 } });
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'pos_session', value: cashier.cookieHeader().slice('pos_session='.length), url: base, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/pos`);
    await expect(page.getByRole('button', { name: 'เตรียมเครื่องขายออฟไลน์' })).toBeEnabled();
    await storageProbe(page);
    // Reset the page's in-memory store after probing its adapter.
    await page.reload();
    await page.getByRole('button', { name: 'เตรียมเครื่องขายออฟไลน์' }).click();
    await page.getByLabel('ชื่อเครื่อง', { exact: true }).fill('เครื่อง Chromium');
    await page.getByRole('button', { name: 'ยืนยันเตรียมเครื่อง' }).click();
    await expect(page.getByText(/แคช 65 รายการ/)).toBeVisible(); checks++;
    const second = await context.newPage(); await second.goto(`${base}/pos`);
    await expect(second.getByText(/เครื่องนี้ไม่ได้สิทธิ์เขียนบิล/)).toBeVisible();
    check(await second.getByRole('button', { name: 'เตรียมเครื่องขายออฟไลน์' }).isDisabled(), 'second tab cannot borrow or checkout');
    await second.close();
    await context.setOffline(true);
    await page.getByLabel('สแกนบาร์โค้ด หรือค้นหาสินค้า').fill('OB064');
    await page.getByLabel('สแกนบาร์โค้ด หรือค้นหาสินค้า').press('Enter');
    await expect(page.getByText('สินค้าทดสอบ 064').first()).toBeVisible();
    // The scan already added one line; complete it without tapping the tile again.
    await page.getByRole('button', { name: /รับชำระ|ชำระเงิน/ }).first().click();
    await page.getByRole('button', { name: 'พอดี', exact: true }).click();
    await page.getByRole('button', { name: 'ยืนยันรับเงิน', exact: true }).click();
    await expect(page.getByRole('button', { name: 'ปิดและขายต่อ' })).toBeVisible();
    await page.getByRole('button', { name: 'ปิดและขายต่อ' }).click();
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/offline-active.png', fullPage: true });
    const pending = await state(page);
    check(pending.queue.length === 1, 'offline scan beyond first 60 persists a bill before confirmation');
    const ref = pending.queue[0]!.clientRef;
    await page.getByRole('button', { name: 'เสร็จแล้ว', exact: true }).click();
    await page.getByRole('button', { name: 'รับแล้ว', exact: true }).click();
    await page.getByRole('button', { name: 'ปิดลิ้นชัก', exact: true }).first().click();
    await page.getByLabel('นับได้จริง (บาท)').fill('600');
    await page.getByRole('dialog').getByRole('button', { name: 'ปิดลิ้นชัก', exact: true }).click();
    await expect(page.getByText(/Failed to fetch|ส่งบิลไม่สำเร็จ|fetch/i).last()).toBeVisible();
    check((await cashier.call<{ shift: unknown }>('/api/v1/shifts/current')).shift !== null, 'offline close refuses and leaves drawer open');
    await page.getByRole('dialog').getByRole('button', { name: 'ยกเลิก', exact: true }).click();
    // Reach the page while intercepting replay: state must reload before any new sale.
    await page.route('**/api/v1/pos/sync', (route) => route.abort());
    await context.setOffline(false); await page.reload();
    await expect(page.getByText(/ค้างส่ง 1 ใบ/)).toBeVisible(); checks++;
    check((await state(page)).queue[0]?.clientRef === ref, 'reload retains the original sale identity');
    await page.unroute('**/api/v1/pos/sync');
    let dropped = false;
    await page.route('**/api/v1/pos/sync', async (route) => {
      if (!dropped && route.request().postDataJSON().bills.length) {
        dropped = true; await route.fetch(); await route.abort();
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'ส่งบิลตอนนี้' }).click();
    await expect.poll(() => dropped).toBe(true);
    await expect(page.getByRole('button', { name: 'ส่งบิลตอนนี้' })).toBeEnabled();
    check((await state(page)).queue.length === 1, 'server commit with lost response retains the pending identity');
    await page.getByRole('button', { name: 'ส่งบิลตอนนี้' }).click();
    await expect.poll(async () => (await state(page)).queue.length).toBe(0); checks++;
    const orders = await cashier.call<{ id: string; clientRef?: string }[]>('/api/v1/orders');
    check(orders.length === 1, 'retry after lost response records one order');
    await context.setOffline(true);
    await page.getByLabel('สแกนบาร์โค้ด หรือค้นหาสินค้า').fill('OB064');
    await page.getByLabel('สแกนบาร์โค้ด หรือค้นหาสินค้า').press('Enter');
    await page.getByRole('button', { name: /รับชำระ|ชำระเงิน/ }).first().click();
    await page.getByRole('button', { name: 'พอดี', exact: true }).click();
    await page.getByRole('button', { name: 'ยืนยันรับเงิน', exact: true }).click();
    await expect(page.getByRole('button', { name: 'ปิดและขายต่อ' })).toBeVisible();
    await page.getByRole('button', { name: 'ปิดและขายต่อ' }).click();
    await context.setOffline(false);
    await expect.poll(async () => (await state(page)).queue.length, { timeout: 20_000 }).toBe(0);
    check((await cashier.call<unknown[]>('/api/v1/orders')).length === 2, 'reconnect sends automatically without a manual click');
    await page.getByRole('button', { name: 'ปิดลิ้นชัก', exact: true }).first().click();
    await page.getByLabel('นับได้จริง (บาท)').fill('700');
    await page.getByRole('dialog').getByRole('button', { name: 'ปิดลิ้นชัก', exact: true }).click();
    await expect(page.getByText('ยังไม่เปิดลิ้นชัก — เปิดก่อนจึงจะรับชำระเงินได้')).toBeVisible();
    check((await state(page)).snapshot?.heldBlocks.length === 0, 'normal close releases all number loans');
    // A storage failure in the actual checkout must not display a receipt or burn a number.
    await cashier.call('/api/v1/shifts/current', { method: 'POST', body: { initialCash: 500 } });
    await page.reload();
    await page.getByRole('button', { name: 'เตรียมเครื่องขายออฟไลน์' }).click();
    await page.getByRole('button', { name: 'ยืนยันเตรียมเครื่อง' }).click();
    await expect(page.getByRole('button', { name: 'ยืนยันเตรียมเครื่อง' })).not.toBeVisible();
    const [pricedProduct] = await admin.call<{ id: string }[]>('/api/v1/products?barcode=OB000');
    await admin.call(`/api/v1/products/${pricedProduct!.id}`, { method: 'PATCH', body: { salePrice: 120 } });
    await page.getByRole('button', { name: /^สินค้าทดสอบ 000/ }).click();
    await page.getByRole('button', { name: /รับชำระ|ชำระเงิน/ }).first().click();
    await page.getByRole('button', { name: 'พอดี', exact: true }).click();
    await page.getByRole('button', { name: 'ยืนยันรับเงิน', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(/ราคาสินค้าเปลี่ยนแล้ว/)).toBeVisible();
    check((await state(page)).queue.length === 0, 'online price change requires cashier reconfirmation before persisting a sale');
    await page.getByRole('button', { name: 'ยกเลิก', exact: true }).click();
    await context.setOffline(true);
    await page.getByLabel('สแกนบาร์โค้ด หรือค้นหาสินค้า').fill('');
    await expect(page.getByRole('button', { name: /^สินค้าทดสอบ 000/ })).toBeVisible();
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
        const request = original.apply(this, args);
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      };
    });
    const beforeFailedWrite = await state(page);
    await page.getByRole('button', { name: /^สินค้าทดสอบ 000/ }).click();
    await page.getByRole('button', { name: /รับชำระ|ชำระเงิน/ }).first().click();
    await page.getByRole('button', { name: 'พอดี', exact: true }).click();
    await page.getByRole('button', { name: 'ยืนยันรับเงิน', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(/aborted/i)).toBeVisible();
    check(await page.getByRole('button', { name: 'ปิดและขายต่อ' }).count() === 0, 'failed checkout commit never confirms a receipt');
    assert.deepEqual(await state(page), beforeFailedWrite); checks++;
    await page.getByRole('button', { name: 'ยกเลิก', exact: true }).click();
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/offline-pos.png', fullPage: true });
    await context.setOffline(false);
    // Recover deliberately stranded, unused loans through the admin surface.
    const loans = await admin.call<{ blocks: { id: string }[] }>('/api/v1/pos/number-blocks');
    check((await cashier.request(`/api/v1/pos/number-blocks/${loans.blocks[0]!.id}`, { method: 'POST', body: { action: 'cancel', evidenceConfirmed: true } })).status === 403, 'cashier cannot manually recover a loan');
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await adminContext.addCookies([{ name: 'pos_session', value: admin.cookieHeader().slice('pos_session='.length), url: base }]);
    const managerPage = await adminContext.newPage();
    await managerPage.goto(`${base}/admin/dashboard`);
    await managerPage.getByRole('button', { name: 'ตรวจและคืนชุดเลข' }).first().click();
    check(await managerPage.getByRole('button', { name: 'ยืนยันคืนชุดเลข' }).isDisabled(), 'admin recovery requires actual-document confirmation');
    await managerPage.getByLabel('ตรวจเอกสารจริงและหยุดขายบนเครื่องเดิมแล้ว').check();
    await managerPage.getByRole('button', { name: 'ยืนยันคืนชุดเลข' }).click();
    await expect(managerPage.getByRole('button', { name: 'ยืนยันคืนชุดเลข' })).not.toBeVisible(); checks++;
    await managerPage.screenshot({ path: 'test-results/offline-admin.png', fullPage: true });
    await adminContext.close();
    check(errors.length === 0, `no browser page errors (${errors.join('; ')})`);
    console.log(`\noffline browser: ${checks} checks passed`);
  } finally {
    await browser?.close();
    if (server) await stopServer(server);
    if (!keep) await resetScratchSchema(source!, schema, false);
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
