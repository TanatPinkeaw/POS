'use client';

/**
 * Shop settings (ADR 0002).
 *
 * The point of this screen is that a renter never edits code or a seed file to
 * put their own name on a receipt. It also shows the *next* receipt number, so
 * an operator can confirm the series is continuous before a customer is standing
 * at the till rather than discovering a gap on a printed document — which is why
 * that card sits beside the form rather than below it.
 *
 * The VAT-dependent fields only exist while the shop is VAT-registered: showing a
 * tax id box to a shop that has none invites a value that would then print on
 * every receipt.
 *
 * The two decimal fields hold their **text** in state, not their number.
 *
 * Storing `Number(event.target.value)` and rendering `String(number)` looks
 * harmless and is not: `Number("1.")` is `1`, so the moment a decimal point is
 * typed it is parsed away and the field is re-rendered without it — "1.5" arrives
 * as "15", and an operator typing 7.5 into the VAT rate silently sets 75%. The
 * draft stays a string here and is converted once, on save, which is also how the
 * setup wizard already does it.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import {
  Button,
  Card,
  FieldRow,
  InlineNotice,
  SelectField,
  SplitPane,
  Stack,
  Stat,
  TextAreaField,
  TextField,
  ToggleField,
  Toolbar,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { apiFetch, apiPut } from '@/lib/client-api';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import { nextReceiptPreview, type ShopView } from '@/lib/shop-view';

export function ShopSettingsForm({
  initialShop,
  previewYear,
}: {
  initialShop: ShopView;
  previewYear: number;
}) {
  const router = useRouter();
  const [shop, setShop] = useState(initialShop);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  /*
   * The counter, re-read from the server rather than remembered.
   *
   * This card used to compute its number from `initialShop` — a snapshot the server
   * rendered when the page loaded — and never ask again. It therefore showed
   * `RC-2026-000001` for as long as the tab stayed open, which is what "เลขใบเสร็จถัดไป
   * ไม่อัปเดต" is: the number was right when the page loaded and wrong an hour later,
   * because the shop sold things on the till meanwhile. The card's whole purpose is to
   * tell an operator the series is continuous *right now*, and a stale figure is worse
   * than no figure — it says something false with confidence.
   *
   * Two things move it: this shop's own saves already return the fresh row, and a sale
   * anywhere in the shop arrives as a socket event, so the counter follows the till
   * without anybody pressing anything.
   */
  const refreshCounter = useCallback(async (): Promise<void> => {
    try {
      const fresh = await apiFetch<ShopView>('/api/v1/shop');
      setShop((current) => ({ ...current, receiptRunningNumber: fresh.receiptRunningNumber }));
    } catch {
      // The card is a readout, not a gate: a failed refresh must not put an error
      // banner above a form the operator is halfway through.
    }
  }, []);

  useRealtimeEvent(
    REALTIME_EVENTS.orderUpdated,
    useCallback(() => void refreshCounter(), [refreshCounter]),
  );

  /*
   * The two decimal fields keep what was typed, as typed.
   *
   * The `shop` object stays the source of truth for everything else; these are the
   * text half of the same values, and they are what the inputs render. A blank
   * field is a legitimate draft (it is how a person clears one to retype it), so
   * blank parses as 0 — the same thing the old `|| 0` did — and the two are kept in
   * step by the change handlers below.
   */
  const [vatRateDraft, setVatRateDraft] = useState(String(initialShop.vatRate));
  const [discountLimitDraft, setDiscountLimitDraft] = useState(
    String(initialShop.supervisorDiscountLimitThb),
  );

  const nextReceipt = nextReceiptPreview(shop, previewYear);

  async function save(): Promise<void> {
    setNotice(null);
    setSaving(true);
    try {
      const updated = await apiPut<ShopView>('/api/v1/shop', {
        name: shop.name,
        legalName: shop.legalName,
        branchLabel: shop.branchLabel,
        taxId: shop.taxId,
        address: shop.address,
        phone: shop.phone,
        isVatRegistered: shop.isVatRegistered,
        // Parsed once, here, from the text the operator is actually looking at.
        vatRate: Number(vatRateDraft) || 0,
        receiptPrefix: shop.receiptPrefix,
        receiptFooter: shop.receiptFooter,
        logoUrl: shop.logoUrl,
        supervisorDiscountLimitThb: Number(discountLimitDraft) || 0,
        // Always sent, never omitted: this form is the switch's home, and a save
        // that left it out would be a save that could not turn it off.
        callsNumbers: shop.callsNumbers,
        acceptsPreorders: shop.acceptsPreorders,
        // Blank means "no PromptPay", which is a state rather than a gap: the
        // till then asks a cashier to confirm the transfer instead of issuing a
        // code. Both fields clear together, because half a setting cannot build
        // a payload.
        promptpayId: shop.promptpayId,
        promptpayType: shop.promptpayId ? shop.promptpayType : null,
      });
      setShop(updated);
      // Re-seeded from the server's answer, so a value the server normalised is shown
      // normalised. The draft and the shop cannot drift, because only the server writes
      // `updated` and this is the one place the drafts are set from it.
      setVatRateDraft(String(updated.vatRate));
      setDiscountLimitDraft(String(updated.supervisorDiscountLimitThb));
      setNotice({ tone: 'success', text: 'บันทึกการตั้งค่าแล้ว' });
      router.refresh();
    } catch (error) {
      setNotice({
        tone: 'danger',
        text: error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SplitPane
      side="end"
      panelWidth="20rem"
      label="เลขใบเสร็จถัดไป"
      panel={
        <Card title="เลขใบเสร็จถัดไป">
          <Stack gap="sm">
            <Stat
              label="เลขที่จะออกให้ลูกค้ารายถัดไป"
              value={<span className="ln-mono">{nextReceipt}</span>}
              hint={`ออกแล้ว ${shop.receiptRunningNumber.toLocaleString('en-US')} ใบ`}
              icon="receipt"
            />
            <p className="ln-muted">
              เลขจะเดินต่อเนื่องไม่ข้าม และไม่ซ้ำ แม้รายการที่บันทึกไม่สำเร็จจะถูกยกเลิกทั้งรายการ
            </p>
            <Button variant="ghost" size="sm" icon="refresh" onClick={() => void refreshCounter()}>
              รีเฟรช
            </Button>
          </Stack>
        </Card>
      }
    >
      <Stack gap="lg">
        <Card title="ข้อมูลร้าน" subtitle="พิมพ์อยู่บนหัวใบเสร็จ">
          <Stack gap="md">
            <FieldRow columns={2}>
              <TextField
                id="shop-name"
                label="ชื่อร้าน"
                autoComplete="organization"
                required
                value={shop.name}
                onChange={(event) => setShop({ ...shop, name: event.target.value })}
              />
              <TextField
                id="shop-branch"
                label="สาขา"
                autoComplete="off"
                value={shop.branchLabel ?? ''}
                onChange={(event) => setShop({ ...shop, branchLabel: event.target.value })}
              />
            </FieldRow>

            <FieldRow columns={2}>
              <TextField
                id="shop-legal"
                label="ชื่อนิติบุคคล"
                autoComplete="off"
                help="ใช้เมื่อชื่อบริษัทต่างจากชื่อร้าน"
                value={shop.legalName ?? ''}
                onChange={(event) => setShop({ ...shop, legalName: event.target.value })}
              />
              <TextField
                id="shop-phone"
                label="เบอร์โทร"
                autoComplete="tel"
                inputMode="tel"
                className="ln-num"
                value={shop.phone ?? ''}
                onChange={(event) => setShop({ ...shop, phone: event.target.value })}
              />
            </FieldRow>

            <TextAreaField
              id="shop-address"
              label="ที่อยู่"
              autoComplete="street-address"
              rows={2}
              value={shop.address ?? ''}
              onChange={(event) => setShop({ ...shop, address: event.target.value })}
            />
          </Stack>
        </Card>

        <Card title="ภาษีและการออกใบเสร็จ">
          <Stack gap="md">
            <ToggleField
              id="shop-vat"
              label="ร้านจดทะเบียน VAT"
              help="เปิดแล้วใบเสร็จจะแสดงยอดก่อนภาษีและภาษีแยกให้ลูกค้าเห็น"
              checked={shop.isVatRegistered}
              onChange={(next) => setShop({ ...shop, isVatRegistered: next })}
            />

            {shop.isVatRegistered ? (
              <FieldRow columns={2}>
                <TextField
                  id="shop-taxid"
                  label="เลขประจำตัวผู้เสียภาษี"
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={13}
                  className="ln-num ln-mono"
                  required
                  value={shop.taxId ?? ''}
                  onChange={(event) =>
                    setShop({ ...shop, taxId: event.target.value.replace(/\D/g, '').slice(0, 13) })
                  }
                />
                <TextField
                  id="shop-vatrate"
                  label="อัตรา VAT (%)"
                  autoComplete="off"
                  inputMode="decimal"
                  className="ln-num"
                  value={vatRateDraft}
                  onChange={(event) => setVatRateDraft(event.target.value)}
                />
              </FieldRow>
            ) : null}

            {/*
             * The till's own policy knob. Kept beside the VAT settings because
             * both are "how this shop does money" rather than "how this shop looks".
             */}
            <FieldRow columns={2}>
              <TextField
                id="shop-discount-limit"
                label="วงเงินส่วนลดที่พนักงานให้ได้เอง (บาท)"
                autoComplete="off"
                inputMode="decimal"
                className="ln-num"
                help="เกินวงเงินนี้ เครื่องขายจะขอ PIN ผู้ดูแลก่อนจึงจะให้ส่วนลดได้ (ตั้ง 0 = ให้ส่วนลดทุกบาทต้องมีผู้อนุมัติ)"
                value={discountLimitDraft}
                onChange={(event) => setDiscountLimitDraft(event.target.value)}
              />
            </FieldRow>

            {/*
             * Whether the shop calls its customers by a number, in the same card
             * because it is a decision about the paper they walk away with. Both of
             * the call number and the board that shows it exist for a shop whose
             * customers wait for something they have not paid for yet (ADR 0027);
             * a shop that hands everything over on the spot prints a number nobody
             * reads and opens a board nobody looks at.
             */}
            <ToggleField
              id="shop-calls-numbers"
              label="เรียกลูกด้วยเลขคิว"
              help="ปิดไปแล้วใบเสร็จจะไม่มีเลขคิว และบอร์ดคิวจะไม่ขึ้นในหน้าขาย — เหมาะกับร้านที่ส่งของให้จบในบิลเดียว"
              checked={shop.callsNumbers}
              onChange={(next) => setShop({ ...shop, callsNumbers: next })}
            />

            {/*
             * Whether the shop takes orders before the customer has them, in the
             * same card for the same reason: it is the other half of the question
             * "does this shop hand things over, or does it keep them for a while?"
             * (ADR 0028). Pre-orders exist for a shop that prepares ahead — a member
             * orders on the way there and finds the drink waiting — and a shop that
             * sells only what is on the shelf has nothing to prepare and a board
             * nobody reads. Closing it refuses the order where it is placed, not just
             * here, so a customer who already had the page open is turned away too.
             */}
            <ToggleField
              id="shop-accepts-preorders"
              label="เปิดรับพรีออเดอร์"
              help="ปิดไปแล้ว ลูกค้าจะสั่งพรีออเดอร์ไม่ได้ และบอร์ดพรีออเดอร์จะไม่ขึ้นในหน้าขาย — เหมาะกับร้านที่ขายสินค้าที่พร้อมขายได้เลย"
              checked={shop.acceptsPreorders}
              onChange={(next) => setShop({ ...shop, acceptsPreorders: next })}
            />

            {/*
             * PromptPay: where the shop is paid. Needed before the till can put a
             * QR on the customer's screen, and disabled without it — the customer
             * screen and the till both read this setting.
             */}
            <FieldRow columns={2}>
              <SelectField
                id="shop-promptpay-type"
                label="ประเภทพร้อมเพย์"
                value={shop.promptpayType ?? ''}
                onChange={(event) =>
                  setShop({
                    ...shop,
                    promptpayType: (event.target.value || null) as ShopView['promptpayType'],
                  })
                }
              >
                <option value="">ยังไม่ออก QR พร้อมเพย์</option>
                <option value="mobile">เบอร์มือถือ</option>
                <option value="national_id">เลขบัตรประชาชน / เลขผู้เสียภาษี</option>
                <option value="ewallet">e-Wallet</option>
              </SelectField>
              <TextField
                id="shop-promptpay-id"
                label="เลขพร้อมเพย์ที่รับเงิน"
                autoComplete="off"
                inputMode="numeric"
                className="ln-num ln-mono"
                help="เมื่อเงินเข้าจริง ระบบจะปิดบิลเองได้ต่อเมื่อมีตัวแจ้งเตือน (เว็บฮุกธนาคาร/ผู้ให้บริการ) มิฉะนั้นพนักงานจะกดยืนยันเองโดยต้องมี PIN ผู้ดูแล"
                value={shop.promptpayId ?? ''}
                onChange={(event) =>
                  setShop({ ...shop, promptpayId: event.target.value || null })
                }
              />
            </FieldRow>

            <InlineNotice tone="info">
              ระบบออกใบเสร็จแบบ <strong>ราคารวม VAT แล้ว</strong> — ยอดที่ลูกค้าจ่ายคือยอดที่คิดไว้
              และระบบแยกยอดก่อนภาษีกับภาษีให้บนใบเสร็จ (การคิด VAT เพิ่มจากราคาที่ไม่รวมภาษียังไม่รองรับในเวอร์ชันนี้)
            </InlineNotice>

            <FieldRow columns={2}>
              <TextField
                id="shop-prefix"
                label="คำนำหน้าเลขใบเสร็จ"
                autoComplete="off"
                className="ln-mono"
                value={shop.receiptPrefix}
                onChange={(event) => setShop({ ...shop, receiptPrefix: event.target.value })}
              />
              <TextField
                id="shop-footer"
                label="ข้อความท้ายใบเสร็จ"
                autoComplete="off"
                value={shop.receiptFooter ?? ''}
                onChange={(event) => setShop({ ...shop, receiptFooter: event.target.value })}
              />
            </FieldRow>
          </Stack>
        </Card>

        {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}

        <Toolbar
          actions={
            <Button icon="check" loading={saving} onClick={() => void save()}>
              บันทึกการตั้งค่า
            </Button>
          }
        />
      </Stack>
    </SplitPane>
  );
}
