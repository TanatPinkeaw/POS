'use client';

import { useState } from 'react';

import {
  Button,
  ConfirmDialog,
  Icon,
  InlineNotice,
  Menu,
  MenuItem,
  MenuSeparator,
  Money,
  Overlay,
  Pill,
  SearchField,
  SplitPane,
  TextField,
  useToast,
} from '@/components/ds';
import { bangkokTimeString } from '@/lib/bangkok-time';
import { apiFetch } from '@/lib/client-api';
import type { ProductView } from '@/lib/product-view';
import type { ShopView } from '@/lib/shop-view';
import { vatLabel } from '@/lib/shop-view';
import { APPROVAL_HEADER } from '@/lib/supervisor-view';
import { numbersRemaining, offlineNotice } from '@/lib/till-store';

import { PaySheet } from './PaySheet';
import { PreOrderHandover, lookupHandoverOrder, type HandoverOrder } from './PreOrderHandover';
import { ReceiptLinkDialog } from './ReceiptLinkDialog';
import { RefundDialog, type RefundTarget } from './RefundDialog';
import { SupervisorApprovalDialog } from './SupervisorApprovalDialog';
import { useSupervisorApproval } from './useSupervisorApproval';
import { Receipt } from './Receipt';
import type { CatalogueCategory } from './TillCatalog';
import { TillCatalog } from './TillCatalog';
import { TillBill } from './TillBill';
import type { Shift } from './useOpenShift';
import { useOpenShift } from './useOpenShift';
import { useTill } from './useTill';
import styles from './Till.module.css';

/**
 * The till, and the one place the layout decision is visible.
 *
 * **The bill is on the left and the catalogue on the right.** That is the reference
 * design's own arrangement — their menu grid is the second pane, the open order is
 * the first — and it is the opposite of what a barcode-first grocery screen
 * suggests by instinct. Copying it anyway is deliberate: the point of this work is
 * that the two applications feel like the same language, and a layout is most of
 * that language.
 *
 * The bill pane is fixed-width so the product grid never moves mid-tap. The scan
 * field keeps focus regardless of pane order, which is what makes a scanner-driven
 * shop work at all.
 */
export function Till({
  initialProducts,
  initialTotal,
  categories,
  shop,
  cashierId,
}: {
  initialProducts: ProductView[];
  initialTotal: number;
  categories: CatalogueCategory[];
  shop: ShopView;
  cashierId: string;
}) {
  const { shift, source: shiftSource, deviceNotice, defaultInitialCash, loading, refresh, open, close } = useOpenShift();
  const [payOpen, setPayOpen] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [shiftBusy, setShiftBusy] = useState(false);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [initialCash, setInitialCash] = useState('');
  const [actualCash, setActualCash] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('เครื่องหน้าร้าน');
  const [prepareOpen, setPrepareOpen] = useState(false);
  /*
   * The bill being refunded, if any. Held here rather than inside the receipt
   * overlay because the refund outlives it: the sheet closes, the dialog stays
   * open through the PIN prompt and the credit note, and dismissing the receipt
   * mid-refund must not take the refund with it.
   */
  const [refundTarget, setRefundTarget] = useState<RefundTarget | null>(null);
  /*
   * The bill whose receipt link is being handed over. Held like `refundTarget`
   * rather than inside the dialog, so the dialog can render over the receipt sheet
   * the cashier is already looking at.
   */
  const [linkTarget, setLinkTarget] = useState<{ orderId: string; orderNumber: string } | null>(
    null,
  );
  /*
   * The pre-order being collected, found by scanning the customer's QR, by their PIN
   * or by their phone number.
   *
   * Its own field rather than the catalogue's search box, because that box is wired to
   * the till's barcode scanner: a collection QR that went through it would be looked
   * up as a product barcode, find nothing, and read to the cashier as "unknown code".
   * Two scanners' worth of input, two boxes.
   */
  const [handoverOrder, setHandoverOrder] = useState<HandoverOrder | null>(null);
  const [handoverTerm, setHandoverTerm] = useState('');
  const [handoverBusy, setHandoverBusy] = useState(false);
  const [handoverError, setHandoverError] = useState<string | null>(null);

  const collectHandover = async (): Promise<void> => {
    const term = handoverTerm.trim();
    if (!term) {
      return;
    }
    setHandoverBusy(true);
    setHandoverError(null);
    try {
      const found = await lookupHandoverOrder(term);
      setHandoverOrder(found);
      setHandoverTerm('');
    } catch (caught) {
      setHandoverError(
        caught instanceof Error ? caught.message : 'ไม่พบพรีออเดอร์ที่ตรงกับรหัสนี้',
      );
    } finally {
      setHandoverBusy(false);
    }
  };

  const toast = useToast();
  const approval = useSupervisorApproval();

  const till = useTill({
    initialProducts,
    initialTotal,
    shift,
    shiftLoaded: !loading,
    cashierId,
    shop,
    onSold: refresh,
    discountLimitThb: shop.supervisorDiscountLimitThb,
    requestApproval: approval.request,
  });

  /*
   * The device's own state, said out loud (ADR 0019, `CONTEXT.md` item 4). An outage the
   * till does not mention is the silent failure the offline work exists for: the cashier
   * needs to know that cash still works, that a member lookup does not, and how many bills
   * are waiting — and none of that can be inferred from a spinner that never resolves.
   */
  const device = till.offline ? offlineNotice(till.offline) : null;

  /*
   * Shown beside the total, because "รวม VAT แล้วหรือยัง" is the question a cashier
   * gets asked at the counter, and the answer is a property of the shop's settings
   * rather than something the till should be guessing at.
   */
  const taxLabel = shop.isVatRegistered
    ? `ราคารวม ${vatLabel(shop.vatRate)} · ออกใบกำกับภาษี${shop.taxId ? '' : ' (ยังไม่กรอกเลขผู้เสียภาษี)'}`
    : null;

  const doOpenShift = async (): Promise<void> => {
    setShiftBusy(true);
    setShiftError(null);
    try {
      await open(Number(initialCash || defaultInitialCash));
      setShiftOpen(false);
      setInitialCash('');
    } catch (caught) {
      setShiftError(caught instanceof Error ? caught.message : 'เปิดลิ้นชักไม่สำเร็จ');
    } finally {
      setShiftBusy(false);
    }
  };

  /*
   * The no-sale drawer opening. A browser cannot push a physical drawer, so what
   * this does is ask for the PIN and write the record; the operator opens the
   * till by hand. That record is the whole reason the action is gated — it is the
   * one drawer event with no payment behind it to reconstruct it from.
   */
  const doOpenDrawer = async (): Promise<void> => {
    if (!shift) {
      return;
    }
    setShiftError(null);

    const token = await approval.request({
      action: 'drawer_open',
      targetId: String(shift.id),
      summary: `ลิ้นชัก #${shift.id} · เปิดโดยไม่มีการขาย`,
    });
    if (!token) {
      return;
    }

    try {
      await apiFetch('/api/v1/pos/drawer-open', {
        method: 'POST',
        body: JSON.stringify({ shiftId: shift.id }),
        headers: { [APPROVAL_HEADER]: token },
      });
      toast.show({
        title: 'บันทึกการเปิดลิ้นชักแล้ว',
        body: 'รายการนี้อยู่ในประวัติการใช้งาน พร้อมชื่อผู้อนุมัติ',
        tone: 'success',
      });
    } catch (caught) {
      toast.show({
        title: 'เปิดลิ้นชักไม่สำเร็จ',
        ...(caught instanceof Error ? { body: caught.message } : {}),
        tone: 'danger',
      });
    }
  };

  /*
   * Dismissing the receipt also closes the pay sheet.
   *
   * A sale normally ends with the cashier pressing something in the sheet, and
   * the sheet closes itself. One that ended *without* a press — a PromptPay QR
   * closing the bill the moment the money landed — leaves nobody to do that, and
   * dismissing the receipt reveals a sheet showing a bill for ฿0.00 that has to
   * be cancelled before the next customer can be served. `checkout` has already
   * emptied the basket by then, so there is nothing left for the sheet to be
   * open *for*.
   */
  const finishSale = (): void => {
    till.setReceipt(null);
    setPayOpen(false);
    till.scanInput.current?.focus();
  };

  const doCloseShift = async (): Promise<void> => {
    setShiftBusy(true);
    setShiftError(null);
    try {
      if (!till.writer || till.busy || till.deviceBusy) throw new Error('รอเครื่องพร้อมและหยุดรับเงินก่อนปิดกะ');
      await till.closePreparedShift(() => close(Number(actualCash || 0)));
      setShiftOpen(false);
      setActualCash('');
    } catch (caught) {
      setShiftError(caught instanceof Error ? caught.message : 'ปิดลิ้นชักไม่สำเร็จ');
    } finally {
      setShiftBusy(false);
    }
  };

  return (
    <div className={styles.till}>
      <div className={styles.tillBar}>
        <div>
          <h1 className={styles.tillTitle}>ขายหน้าร้าน</h1>
          <p className={styles.tillSubtitle}>
            {shift
              ? `ลิ้นชักเปิดอยู่ · เริ่ม ${bangkokTimeString(new Date(shift.openedAt))}`
              : 'ยังไม่เปิดลิ้นชัก — เปิดก่อนจึงจะรับชำระเงินได้'}
          </p>
          {/*
            Said here, under the drawer, rather than in place of it — because the drawer is
            real and only its *figures* are remembered (ADR 0024). Hiding the shift because
            the network is gone would stop a sale the till is already equipped to keep; the
            number that needs the caveat is the takings, so that is what carries one.
          */}
          {deviceNotice ? <p className={styles.hint}>{deviceNotice}</p> : null}
        </div>

        <div className={styles.tillBarActions}>
          {shift ? (
            <Pill tone="success" icon="drawer">
              รายรับกะนี้ {shiftSource === 'device' ? '(จากเครื่อง) ' : ''}
              <Money amount={shift.cashSalesThb} />
            </Pill>
          ) : (
            <Pill tone="warning" icon="warning">
              ยังไม่เปิดลิ้นชัก
            </Pill>
          )}

          <Button
            variant={shift ? 'secondary' : 'primary'}
            icon="drawer"
            loading={loading}
            onClick={() => setShiftOpen(true)}
          >
            {shift ? 'ปิดลิ้นชัก' : 'เปิดลิ้นชัก'}
          </Button>

          {/*
           * The star is the reference design's settings hub in the corner of the
           * selling screen. Ours is the short list of things an operator actually
           * needs mid-shift rather than a settings tree.
           */}
          <Menu
            label="เมนูลัดของลิ้นชัก"
            align="end"
            trigger={<Icon name="star" size={18} />}
          >
            <MenuItem icon="receipt" onSelect={() => setShiftOpen(true)}>
              สรุปกะและลิ้นชัก
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon="drawer" disabled={!shift} onSelect={() => void doOpenDrawer()}>
              เปิดลิ้นชัก (ไม่มีการขาย)
            </MenuItem>
            <MenuItem icon="print" onSelect={() => window.print()}>
              พิมพ์หน้าจอนี้
            </MenuItem>
          </Menu>
        </div>
      </div>

      {!till.writer && till.offline?.loaded ? <InlineNotice tone="danger">เครื่องนี้ไม่ได้สิทธิ์เขียนบิล — ปิดแท็บขายอื่นแล้วเปิดหน้านี้ใหม่</InlineNotice> : null}
      <div className="ln-row">
        <Button variant="secondary" disabled={!shift || !till.writer || till.busy || till.deviceBusy} onClick={() => setPrepareOpen(true)}>เตรียมเครื่องขายออฟไลน์</Button>
        <Button variant="secondary" loading={till.deviceBusy} disabled={!till.writer || till.busy} onClick={() => void till.sendPending().catch(() => undefined)}>ส่งบิลตอนนี้</Button>
        {till.offline?.snapshot?.heldBlocks.length ? <Button variant="secondary" disabled={!till.writer || till.busy || till.deviceBusy} onClick={() => void till.sendPending(true, true).catch(() => undefined)}>ส่งบิลและคืนชุดเลข</Button> : null}
        {till.offline?.snapshot?.heldBlocks.length ? <span>เลขใบกำกับเหลือ {numbersRemaining(till.offline.snapshot).receipt ?? '—'} · เลขคิวเหลือ {numbersRemaining(till.offline.snapshot).call ?? '—'}</span> : null}
      </div>
      {till.offline?.snapshot ? <p>แคช {till.offline.snapshot.catalogue.length} รายการ · บันทึก {bangkokTimeString(new Date(till.offline.snapshot.capturedAt))} · เปิดหน้าใหม่ขณะออฟไลน์ไม่ได้</p> : null}
      {till.offline?.lastSyncMessage ? <InlineNotice tone="info">{till.offline.lastSyncMessage}</InlineNotice> : null}
      <Overlay open={prepareOpen} onClose={() => setPrepareOpen(false)} title="เตรียมเครื่องขายออฟไลน์" footer={<Button loading={till.deviceBusy} onClick={() => void till.prepareOffline(deviceLabel).then(() => setPrepareOpen(false)).catch((error: unknown) => till.setOfflineWarning(error instanceof Error ? error.message : 'เตรียมเครื่องไม่สำเร็จ'))}>ยืนยันเตรียมเครื่อง</Button>}>
        <InlineNotice tone="warning">เครื่องนี้จะถือเลขใบกำกับและเลขคิว ร้านออกเลขชุดเดียวกันจากเครื่องอื่นไม่ได้จนคืนชุดเลข เครื่องที่เตรียมแล้วรับเฉพาะเงินสดไม่ผูกสมาชิกแม้เน็ตกลับมา ส่งบิลและคืนชุดเลขก่อนใช้พร้อมเพย์ สมาชิก หรือส่วนลดอนุมัติ ต้องส่งบิลให้ครบก่อนปิดกะ ห้ามล้างข้อมูลเบราว์เซอร์</InlineNotice>
        <TextField id="offline-device-label" label="ชื่อเครื่อง" value={deviceLabel} onChange={(event) => setDeviceLabel(event.target.value)} help="ใช้ระบุเครื่องที่ถือชุดเลข ไม่ใช่รหัสผ่าน" />
      </Overlay>
      {till.offline?.queue.some((bill) => bill.fulfilment !== 'collected') ? <section aria-label="คิวในเครื่อง">
        <h2>คิวในเครื่อง · ยังไม่ส่ง</h2>
        {till.offline.queue.filter((bill) => bill.fulfilment !== 'collected').map((bill) => <div key={bill.clientRef}>
          <strong>{bill.numbers?.call?.value ?? 'ไม่มีเลขคิว'}</strong> · {bill.lines.map((line) => `${till.offline?.snapshot?.catalogue.find((p) => p.productId === line.productId)?.name ?? 'สินค้า'} ×${line.quantity}`).join(' · ')}
          <Button variant="secondary" disabled={till.deviceBusy || !till.writer} onClick={() => void till.markLocalTicket(bill.clientRef, bill.fulfilment === 'ready' ? 'collected' : 'ready').catch(() => till.setOfflineWarning('บันทึกคิวไม่ได้'))}>{bill.fulfilment === 'ready' ? 'รับแล้ว' : 'เสร็จแล้ว'}</Button>
          {bill.refusal ? <p role="alert">{bill.refusal}</p> : null}
        </div>)}
      </section> : null}
      {device ? (
        <InlineNotice tone={device.tone} title={device.title}>
          {device.body}
        </InlineNotice>
      ) : null}

      {/*
        A warning is not an error: the sale went through and something about the numbers
        needs somebody's attention — the last call number of the day, or one that ran out.
        It carries its own dismissal rather than clearing itself, because "ไม่มีเลขคิว" is
        worth reading twice.
      */}
      {till.offlineWarning ? (
        <InlineNotice
          tone="info"
          actions={
            <Button variant="ghost" size="sm" onClick={() => till.setOfflineWarning(null)}>
              รับทราบ
            </Button>
          }
        >
          {till.offlineWarning}
        </InlineNotice>
      ) : null}

      {/*
        The collection desk, at the till rather than on the pre-order board.
        Before this, taking money for a pre-order meant walking the customer to
        another screen — which is not a thing you do with a queue behind them.
      */}
      <div className={styles.handoverStrip}>
        <SearchField
          id="preorder-collect"
          label="รับพรีออเดอร์ — สแกนคิวอาร์ของลูกค้า หรือพิมพ์ PIN 4 หลัก / เบอร์โทร"
          placeholder="สแกนคิวอาร์, PIN 4 หลัก, หรือเบอร์โทร"
          value={handoverTerm}
          onChange={setHandoverTerm}
          onSubmit={() => void collectHandover()}
          mono
        />
        <Button
          icon="scan"
          loading={handoverBusy}
          disabled={handoverTerm.trim() === ''}
          onClick={() => void collectHandover()}
        >
          รับสินค้า
        </Button>
      </div>
      {handoverError ? <InlineNotice tone="danger">{handoverError}</InlineNotice> : null}

      <div style={{ flex: 1, minHeight: 0 }}>
        <SplitPane
          label="บิลปัจจุบัน"
          panelWidth="24rem"
          stackOrder="content-first"
          fill
          panel={
            <TillBill
              till={till}
              taxLabel={taxLabel}
              onPay={() => {
                till.setReceivedCash(String(till.cashDue || ''));
                setPayOpen(true);
              }}
            />
          }
        >
          <TillCatalog till={till} categories={categories} disabled={!shift} />
        </SplitPane>
      </div>

      <PaySheet till={till} shop={shop} open={payOpen} onClose={() => setPayOpen(false)} />

      <PreOrderHandover
        order={handoverOrder}
        open={handoverOrder !== null}
        onClose={() => setHandoverOrder(null)}
        onCompleted={() => {
          setHandoverOrder(null);
          // The collection happened, so the bar's board and the till's own counts are
          // both stale. `refresh` re-reads the drawer; the stock totals are pushed by
          // the server's broadcast rather than fetched here.
          refresh();
          till.scanInput.current?.focus();
        }}
      />

      {/*
        Rendered after the pay sheet so it paints over it: a discount past the
        limit is confirmed on the pay sheet, and the PIN question has to be the
        thing the operator sees next rather than a dialog hidden behind it.
      */}
      {approval.pending ? (
        <SupervisorApprovalDialog
          open
          action={approval.pending.action}
          targetId={approval.pending.targetId}
          {...(approval.pending.summary === undefined
            ? {}
            : { summary: approval.pending.summary })}
          onCancel={() => approval.pending?.settle(null)}
          onApproved={(grant) => approval.pending?.settle(grant)}
        />
      ) : null}

      {/* The receipt, printed from the same component the reprint uses. */}
      <Overlay
        open={Boolean(till.receipt)}
        onClose={finishSale}
        title={
          till.receipt?.offline
            ? 'ขายแล้ว · ยังไม่ได้ส่งเข้าระบบ'
            : till.receipt?.isVatInvoice
              ? 'ชำระเงินสำเร็จ · ออกใบกำกับภาษี'
              : 'ชำระเงินสำเร็จ'
        }
        description={till.receipt ? `บิล ${till.receipt.orderNumber}` : undefined}
        footer={
          <>
            <Button variant="secondary" icon="print" onClick={() => window.print()}>
              พิมพ์ใบเสร็จ
            </Button>
            {/*
              The customer changed their mind before leaving the counter, which
              is the one return that needs no lookup: the bill is already on
              screen. Offering it here is what makes the common case a two-tap
              action rather than a trip to the back office — and it still asks a
              supervisor for a PIN, because that is about the money and not about
              who is standing where.
            */}
            {/*
              Only for a bill the shop has: a refund needs a credit note, a PIN and the
              server's arithmetic, and a sale still sitting in the device's queue has none of
              the three yet (ADR 0019). The button is absent rather than present-and-failing,
              because a cashier who taps it is a cashier telling the customer yes.
            */}
            {/*
              Hand the customer the link to keep. Only for a bill the shop has: a
              sale still sitting in the device's queue has no order on the server to
              mint a link against (ADR 0019), so the button is absent rather than
              present-and-failing.
            */}
            {till.receipt?.orderId && !till.receipt.offline ? (
              <Button
                variant="secondary"
                icon="qr"
                onClick={() =>
                  setLinkTarget({
                    orderId: till.receipt!.orderId!,
                    orderNumber: till.receipt!.orderNumber,
                  })
                }
              >
                ให้ลิงก์ใบเสร็จ
              </Button>
            ) : null}
            {till.receipt?.orderId ? (
              <Button
                variant="secondary"
                onClick={() =>
                  setRefundTarget({
                    orderId: till.receipt!.orderId!,
                    orderNumber: till.receipt!.orderNumber,
                    amountThb: till.receipt!.finalAmountThb,
                    lineCount: till.receipt!.lines.length,
                  })
                }
              >
                คืนเงินบิลนี้
              </Button>
            ) : null}
            <Button onClick={finishSale}>ปิดและขายต่อ</Button>
          </>
        }
      >
        {till.receipt?.offline ? (
          <InlineNotice tone="warning">
            บิลนี้ยังไม่ถูกส่งเข้าระบบ — จะส่งให้อัตโนมัติเมื่อเน็ตกลับมา เลขที่ใบกำกับภาษีและเลขคิว
            เป็นเลขที่เครื่องนี้พิมพ์จริง
          </InlineNotice>
        ) : null}
        {till.receipt ? <Receipt shop={shop} data={till.receipt} when={till.receipt.at} /> : null}
      </Overlay>

      {linkTarget ? (
        <ReceiptLinkDialog
          orderId={linkTarget.orderId}
          orderNumber={linkTarget.orderNumber}
          onClose={() => setLinkTarget(null)}
        />
      ) : null}

      {refundTarget ? (
        <RefundDialog
          target={refundTarget}
          onClose={() => setRefundTarget(null)}
          onRefunded={() => {
            /*
             * The refunded bill has left the shelf, so the catalogue pane and the
             * shift's own takings figure are both stale now. `refresh` re-reads the
             * drawer, which is the figure the cashier is about to reconcile against.
             */
            void refresh();
          }}
        />
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {shift ? (
        <ConfirmDialog
          open={shiftOpen}
          title="ปิดลิ้นชัก"
          description="นับเงินในลิ้นชักแล้วกรอกยอดจริง ระบบจะเทียบกับยอดที่ควรมี"
          confirmLabel="ปิดลิ้นชัก"
          tone="primary"
          busy={shiftBusy}
          onCancel={() => setShiftOpen(false)}
          onConfirm={() => void doCloseShift()}
        >
          <div style={{ display: 'grid', gap: 'var(--ln-space-3)' }}>
            <div className={styles.settingsRow}>
              <span className={styles.settingsLabel}>เงินตั้งต้น</span>
              <span className={styles.settingsValue}>{shift.initialCashThb.toFixed(2)}</span>
            </div>
            <div className={styles.settingsRow}>
              <span className={styles.settingsLabel}>ขายเป็นเงินสด</span>
              <span className={styles.settingsValue}>{shift.cashSalesThb.toFixed(2)}</span>
            </div>
            <div className={styles.settingsRow}>
              <span className={styles.settingsLabel}>ควรมีในลิ้นชัก</span>
              <span className={styles.settingsValue}>{shift.expectedCashThb.toFixed(2)}</span>
            </div>
            <div className={styles.settingsRow}>
              <span className={styles.settingsLabel}>จำนวนบิล</span>
              <span className={styles.settingsValue}>{shift.orderCount}</span>
            </div>
            <TextField
              id="actual-cash"
              label="นับได้จริง (บาท)"
              inputMode="decimal"
              value={actualCash}
              onChange={(event) => setActualCash(event.target.value)}
              error={shiftError}
            />
          </div>
        </ConfirmDialog>
      ) : (
        <Overlay
          open={shiftOpen}
          onClose={() => setShiftOpen(false)}
          title="เปิดลิ้นชัก"
          description="ระบุเงินตั้งต้นในลิ้นชักก่อนเริ่มขาย"
          footer={
            <>
              <Button variant="secondary" onClick={() => setShiftOpen(false)} disabled={shiftBusy}>
                ยกเลิก
              </Button>
              <Button loading={shiftBusy} icon="drawer" onClick={() => void doOpenShift()}>
                เปิดลิ้นชัก
              </Button>
            </>
          }
        >
          <TextField
            id="initial-cash"
            label="เงินตั้งต้น (บาท)"
            inputMode="decimal"
            placeholder={String(defaultInitialCash)}
            value={initialCash}
            onChange={(event) => setInitialCash(event.target.value)}
            help={`ค่าเริ่มต้นของร้านคือ ${defaultInitialCash.toFixed(2)} บาท`}
            error={shiftError}
          />
        </Overlay>
      )}
    </div>
  );
}
