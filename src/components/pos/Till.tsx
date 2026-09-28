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
} from '@/components/ds';
import { bangkokTimeString } from '@/lib/bangkok-time';
import type { ProductView } from '@/lib/product-view';
import type { ShopView } from '@/lib/shop-view';
import { vatLabel } from '@/lib/shop-view';

import { PaySheet } from './PaySheet';
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

  const till = useTill({
    initialProducts,
    initialTotal,
    shift,
    onSold: refresh,
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

      {/* The receipt, printed from the same component the reprint uses. */}
      <Overlay
        open={Boolean(till.receipt)}
        onClose={() => till.setReceipt(null)}
        title={till.receipt?.isVatInvoice ? 'ชำระเงินสำเร็จ · ออกใบกำกับภาษี' : 'ชำระเงินสำเร็จ'}
        description={till.receipt ? `บิล ${till.receipt.orderNumber}` : undefined}
        footer={
          <>
            <Button variant="secondary" icon="print" onClick={() => window.print()}>
              พิมพ์ใบเสร็จ
            </Button>
            <Button
              onClick={() => {
                till.setReceipt(null);
                till.scanInput.current?.focus();
              }}
            >
              ปิดและขายต่อ
            </Button>
          </>
        }
      >
        {till.receipt ? <Receipt shop={shop} data={till.receipt} when={till.receipt.at} /> : null}
      </Overlay>

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
