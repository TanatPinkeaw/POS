'use client';

import { useState } from 'react';

import {
  Button,
  ConfirmDialog,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  Money,
  Overlay,
  Pill,
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

import { PaySheet } from './PaySheet';
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
}: {
  initialProducts: ProductView[];
  initialTotal: number;
  categories: CatalogueCategory[];
  shop: ShopView;
}) {
  const { shift, defaultInitialCash, loading, refresh, open, close } = useOpenShift();
  const [payOpen, setPayOpen] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [shiftBusy, setShiftBusy] = useState(false);
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [initialCash, setInitialCash] = useState('');
  const [actualCash, setActualCash] = useState('');
  /*
   * The bill being refunded, if any. Held here rather than inside the receipt
   * overlay because the refund outlives it: the sheet closes, the dialog stays
   * open through the PIN prompt and the credit note, and dismissing the receipt
   * mid-refund must not take the refund with it.
   */
  const [refundTarget, setRefundTarget] = useState<RefundTarget | null>(null);

  const toast = useToast();
  const approval = useSupervisorApproval();

  const till = useTill({
    initialProducts,
    initialTotal,
    shift,
    onSold: refresh,
    discountLimitThb: shop.supervisorDiscountLimitThb,
    requestApproval: approval.request,
  });

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
      await close(Number(actualCash || 0));
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
        </div>

        <div className={styles.tillBarActions}>
          {shift ? (
            <Pill tone="success" icon="drawer">
              รายรับกะนี้ <Money amount={shift.cashSalesThb} />
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

      <PaySheet till={till} open={payOpen} onClose={() => setPayOpen(false)} />

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
        title={till.receipt?.isVatInvoice ? 'ชำระเงินสำเร็จ · ออกใบกำกับภาษี' : 'ชำระเงินสำเร็จ'}
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
            {till.receipt ? (
              <Button
                variant="secondary"
                onClick={() =>
                  setRefundTarget({
                    orderId: till.receipt!.orderId,
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
        {till.receipt ? <Receipt shop={shop} data={till.receipt} when={till.receipt.at} /> : null}
      </Overlay>

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
