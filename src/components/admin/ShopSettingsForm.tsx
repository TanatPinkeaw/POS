'use client';

/**
 * Shop settings (ADR 0002).
 *
 * The point of this screen is that a renter never edits code or a seed file to
 * put their own name on a receipt. It also shows the *next* receipt number, so
 * an operator can confirm the series is continuous before a customer is standing
 * at the till rather than discovering a gap on a printed document.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Alert, Card } from '@/components/hope/ui';
import { apiPut } from '@/lib/client-api';
import { formatReceiptNumber, type ShopView } from '@/lib/shop-view';

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

  const nextReceipt = formatReceiptNumber(
    shop.receiptPrefix,
    previewYear,
    shop.receiptRunningNumber + 1,
  );

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
        vatRate: shop.vatRate,
        receiptPrefix: shop.receiptPrefix,
        receiptFooter: shop.receiptFooter,
        logoUrl: shop.logoUrl,
      });
      setShop(updated);
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
    <div className="row g-4">
      <div className="col-12 col-xl-8">
        <Card title="ข้อมูลร้าน" subtitle="พิมพ์อยู่บนหัวใบเสร็จ">
          <div className="row g-3">
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="shop-name">
                ชื่อร้าน <span className="text-danger">*</span>
              </label>
              <input
                id="shop-name"
                name="name"
                autoComplete="organization"
                className="form-control"
                value={shop.name}
                onChange={(event) => setShop({ ...shop, name: event.target.value })}
              />
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="shop-branch">
                สาขา
              </label>
              <input
                id="shop-branch"
                name="branchLabel"
                autoComplete="off"
                className="form-control"
                value={shop.branchLabel ?? ''}
                onChange={(event) => setShop({ ...shop, branchLabel: event.target.value })}
              />
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="shop-legal">
                ชื่อนิติบุคคล
              </label>
              <input
                id="shop-legal"
                name="legalName"
                autoComplete="off"
                className="form-control"
                value={shop.legalName ?? ''}
                onChange={(event) => setShop({ ...shop, legalName: event.target.value })}
              />
              <div className="form-text">ใช้เมื่อชื่อบริษัทต่างจากชื่อร้าน</div>
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="shop-phone">
                เบอร์โทร
              </label>
              <input
                id="shop-phone"
                name="phone"
                autoComplete="tel"
                className="form-control"
                value={shop.phone ?? ''}
                onChange={(event) => setShop({ ...shop, phone: event.target.value })}
              />
            </div>
            <div className="col-12">
              <label className="form-label" htmlFor="shop-address">
                ที่อยู่
              </label>
              <textarea
                id="shop-address"
                name="address"
                autoComplete="street-address"
                className="form-control"
                rows={2}
                value={shop.address ?? ''}
                onChange={(event) => setShop({ ...shop, address: event.target.value })}
              />
            </div>
          </div>
        </Card>

        <div className="mt-4">
          <Card title="ภาษีและการออกใบเสร็จ">
            <div className="form-check form-switch mb-3">
              <input
                className="form-check-input"
                type="checkbox"
                role="switch"
                id="shop-vat"
                name="isVatRegistered"
                checked={shop.isVatRegistered}
                onChange={(event) => setShop({ ...shop, isVatRegistered: event.target.checked })}
              />
              <label className="form-check-label" htmlFor="shop-vat">
                ร้านจดทะเบียน VAT
              </label>
            </div>

            {shop.isVatRegistered && (
              <div className="row g-3">
                <div className="col-12 col-md-6">
                  <label className="form-label" htmlFor="shop-taxid">
                    เลขประจำตัวผู้เสียภาษี <span className="text-danger">*</span>
                  </label>
                  <input
                    id="shop-taxid"
                    name="taxId"
                    autoComplete="off"
                    inputMode="numeric"
                    maxLength={13}
                    className="form-control"
                    value={shop.taxId ?? ''}
                    onChange={(event) =>
                      setShop({ ...shop, taxId: event.target.value.replace(/\D/g, '').slice(0, 13) })
                    }
                  />
                </div>
                <div className="col-12 col-md-6">
                  <label className="form-label" htmlFor="shop-vatrate">
                    อัตรา VAT (%)
                  </label>
                  <input
                    id="shop-vatrate"
                    name="vatRate"
                    autoComplete="off"
                    inputMode="decimal"
                    className="form-control"
                    value={String(shop.vatRate)}
                    onChange={(event) =>
                      setShop({ ...shop, vatRate: Number(event.target.value) || 0 })
                    }
                  />
                </div>
              </div>
            )}

            <Alert tone="info" className="mt-3 mb-4">
              <span className="small">
                ระบบออกใบเสร็จแบบ <strong>ราคารวม VAT แล้ว</strong> — ยอดที่ลูกค้าจ่ายคือยอดที่คิดไว้
                และระบบแยกยอดก่อนภาษีกับภาษีให้บนใบเสร็จ
                (การคิด VAT เพิ่มจากราคาที่ไม่รวมภาษียังไม่รองรับในเวอร์ชันนี้)
              </span>
            </Alert>

            <div className="row g-3">
              <div className="col-12 col-md-4">
                <label className="form-label" htmlFor="shop-prefix">
                  คำนำหน้าเลขใบเสร็จ
                </label>
                <input
                  id="shop-prefix"
                  name="receiptPrefix"
                  autoComplete="off"
                  className="form-control"
                  value={shop.receiptPrefix}
                  onChange={(event) => setShop({ ...shop, receiptPrefix: event.target.value })}
                />
              </div>
              <div className="col-12 col-md-8">
                <label className="form-label" htmlFor="shop-footer">
                  ข้อความท้ายใบเสร็จ
                </label>
                <input
                  id="shop-footer"
                  name="receiptFooter"
                  autoComplete="off"
                  className="form-control"
                  value={shop.receiptFooter ?? ''}
                  onChange={(event) => setShop({ ...shop, receiptFooter: event.target.value })}
                />
              </div>
            </div>
          </Card>
        </div>

        {notice && (
          <Alert tone={notice.tone} className="mt-4 mb-0">
            {notice.text}
          </Alert>
        )}

        <div className="d-flex justify-content-end mt-4">
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่า'}
          </button>
        </div>
      </div>

      <div className="col-12 col-xl-4">
        <Card title="เลขใบเสร็จถัดไป">
          <p className="pos-numeric h4 mb-1">{nextReceipt}</p>
          <p className="text-muted small mb-3">
            ออกแล้ว {shop.receiptRunningNumber.toLocaleString('en-US')} ใบ
          </p>
          <p className="text-muted small mb-0">
            เลขจะเดินต่อเนื่องไม่ข้าม และไม่ซ้ำ แม้รายการที่บันทึกไม่สำเร็จจะถูกยกเลิกทั้งรายการ
          </p>
        </Card>
      </div>
    </div>
  );
}
