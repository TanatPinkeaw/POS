'use client';

/**
 * The first-run wizard.
 *
 * Three steps, in the order a shop actually knows the answers: what the shop is
 * called, whether it is VAT-registered, and who will be the administrator. The
 * last step cannot exist before the others, because the admin account needs a
 * shop to belong to — which is also why the API writes both in one transaction.
 *
 * Deliberately no progress bar machinery and no state library: this runs exactly
 * once per deployment, and a renter should be able to finish it without reading
 * anything twice.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Card } from '@/components/hope/ui';
import { apiPost } from '@/lib/client-api';
import { DEFAULT_RECEIPT_PREFIX, DEFAULT_VAT_RATE } from '@/lib/shop-view';

type Step = 'shop' | 'tax' | 'admin' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'shop', label: 'ข้อมูลร้าน' },
  { key: 'tax', label: 'ภาษี & ใบเสร็จ' },
  { key: 'admin', label: 'ผู้ดูแลระบบ' },
];

export function SetupWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('shop');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [shop, setShop] = useState({
    name: '',
    branchLabel: '',
    legalName: '',
    phone: '',
    address: '',
  });

  const [tax, setTax] = useState({
    isVatRegistered: false,
    vatRate: String(DEFAULT_VAT_RATE),
    taxId: '',
    receiptPrefix: DEFAULT_RECEIPT_PREFIX,
    receiptFooter: '',
  });

  const [admin, setAdmin] = useState({
    fullName: '',
    phone: '',
    email: '',
    password: '',
    confirm: '',
  });

  const stepIndex = STEPS.findIndex((entry) => entry.key === step);

  function goTo(next: Step): void {
    setError(null);
    setStep(next);
  }

  function continueFromShop(): void {
    if (shop.name.trim() === '') {
      setError('กรุณากรอกชื่อร้าน');
      return;
    }
    goTo('tax');
  }

  function continueFromTax(): void {
    if (tax.isVatRegistered) {
      if (!/^\d{13}$/.test(tax.taxId.trim())) {
        setError('ร้านที่จดทะเบียน VAT ต้องกรอกเลขประจำตัวผู้เสียภาษี 13 หลัก');
        return;
      }
      const rate = Number(tax.vatRate);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
        setError('อัตรา VAT ต้องอยู่ระหว่าง 0 ถึง 100');
        return;
      }
    }
    if (tax.receiptPrefix.trim() === '') {
      setError('กรุณากรอกคำนำหน้าเลขใบเสร็จ');
      return;
    }
    goTo('admin');
  }

  async function submit(): Promise<void> {
    setError(null);

    if (admin.fullName.trim() === '' || admin.phone.trim() === '') {
      setError('กรุณากรอกชื่อและเบอร์โทรของผู้ดูแลระบบ');
      return;
    }
    if (admin.password.length < 8) {
      setError('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
      return;
    }
    if (admin.password !== admin.confirm) {
      setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
      return;
    }

    setSaving(true);
    try {
      await apiPost('/api/v1/setup', {
        shop: {
          name: shop.name.trim(),
          legalName: shop.legalName.trim() || null,
          branchLabel: shop.branchLabel.trim() || null,
          phone: shop.phone.trim() || null,
          address: shop.address.trim() || null,
          isVatRegistered: tax.isVatRegistered,
          vatRate: tax.isVatRegistered ? Number(tax.vatRate) : 0,
          taxId: tax.taxId.trim() || null,
          receiptPrefix: tax.receiptPrefix.trim(),
          receiptFooter: tax.receiptFooter.trim() || null,
        },
        admin: {
          fullName: admin.fullName.trim(),
          phone: admin.phone.trim(),
          email: admin.email.trim() || null,
          password: admin.password,
        },
      });
      setStep('done');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ตั้งค่าไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  if (step === 'done') {
    return (
      <Card title="ตั้งค่าระบบเรียบร้อยแล้ว">
        <p className="mb-3">
          ร้าน <strong>{shop.name}</strong> พร้อมใช้งานแล้ว
          {tax.isVatRegistered ? ' และออกใบกำกับภาษีได้' : ''}
        </p>
        <p className="text-muted small mb-4">
          เข้าสู่ระบบด้วยเบอร์โทร <code>{admin.phone}</code> และรหัสผ่านที่คุณตั้งไว้
        </p>
        <div className="d-flex flex-wrap gap-2">
          <a className="btn btn-primary" href="/login">
            ไปหน้าเข้าสู่ระบบ
          </a>
          <a className="btn btn-soft-secondary" href="/admin/products">
            เริ่มเพิ่มสินค้า
          </a>
        </div>
      </Card>
    );
  }

  return (
    <>
      <ol className="list-unstyled d-flex flex-wrap gap-2 mb-4">
        {STEPS.map((entry, index) => {
          const state = index === stepIndex ? 'active' : index < stepIndex ? 'done' : 'todo';
          return (
            <li key={entry.key} className="d-flex align-items-center gap-2">
              <span
                className={`badge ${
                  state === 'active'
                    ? 'bg-primary'
                    : state === 'done'
                      ? 'bg-soft-success text-success'
                      : 'bg-soft-secondary text-secondary'
                }`}
              >
                {index + 1}. {entry.label}
              </span>
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="alert alert-danger" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {step === 'shop' && (
        <Card title="ข้อมูลร้าน" subtitle="ข้อมูลนี้จะพิมพ์อยู่บนหัวใบเสร็จ">
          <div className="row g-3">
            <div className="col-12">
              <label className="form-label" htmlFor="setup-name">
                ชื่อร้าน <span className="text-danger">*</span>
              </label>
              <input
                id="setup-name"
                name="shopName"
                autoComplete="organization"
                className="form-control"
                value={shop.name}
                onChange={(event) => setShop({ ...shop, name: event.target.value })}
                placeholder="เช่น มินิมาร์ทสุขใจ"
              />
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="setup-branch">
                สาขา
              </label>
              <input
                id="setup-branch"
                name="branchLabel"
                autoComplete="off"
                className="form-control"
                value={shop.branchLabel}
                onChange={(event) => setShop({ ...shop, branchLabel: event.target.value })}
                placeholder="เช่น สาขาตลาดกลาง"
              />
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="setup-phone">
                เบอร์โทรร้าน
              </label>
              <input
                id="setup-phone"
                name="shopPhone"
                autoComplete="tel"
                className="form-control"
                value={shop.phone}
                onChange={(event) => setShop({ ...shop, phone: event.target.value })}
              />
            </div>
            <div className="col-12">
              <label className="form-label" htmlFor="setup-address">
                ที่อยู่
              </label>
              <textarea
                id="setup-address"
                name="shopAddress"
                autoComplete="street-address"
                className="form-control"
                rows={2}
                value={shop.address}
                onChange={(event) => setShop({ ...shop, address: event.target.value })}
              />
            </div>
          </div>

          <div className="d-flex justify-content-end mt-4">
            <button type="button" className="btn btn-primary" onClick={continueFromShop}>
              ถัดไป
            </button>
          </div>
        </Card>
      )}

      {step === 'tax' && (
        <Card title="ภาษีและใบเสร็จ" subtitle="ตอบได้แม้ยังไม่แน่ใจ — แก้ไขภายหลังได้ที่หน้าตั้งค่าร้าน">
          <div className="form-check form-switch mb-3">
            <input
              className="form-check-input"
              type="checkbox"
              role="switch"
              id="setup-vat"
              name="isVatRegistered"
              checked={tax.isVatRegistered}
              onChange={(event) => setTax({ ...tax, isVatRegistered: event.target.checked })}
            />
            <label className="form-check-label" htmlFor="setup-vat">
              ร้านจดทะเบียน VAT
            </label>
          </div>

          {tax.isVatRegistered && (
            <div className="row g-3">
              <div className="col-12 col-md-4">
                <label className="form-label" htmlFor="setup-taxid">
                  เลขประจำตัวผู้เสียภาษี <span className="text-danger">*</span>
                </label>
                <input
                  id="setup-taxid"
                  name="taxId"
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={13}
                  className="form-control"
                  value={tax.taxId}
                  onChange={(event) =>
                    setTax({ ...tax, taxId: event.target.value.replace(/\D/g, '').slice(0, 13) })
                  }
                  placeholder="13 หลัก"
                />
              </div>
              <div className="col-12 col-md-4">
                <label className="form-label" htmlFor="setup-vatrate">
                  อัตรา VAT (%)
                </label>
                <input
                  id="setup-vatrate"
                  name="vatRate"
                  autoComplete="off"
                  inputMode="decimal"
                  className="form-control"
                  value={tax.vatRate}
                  onChange={(event) => setTax({ ...tax, vatRate: event.target.value })}
                />
              </div>
            </div>
          )}

          {tax.isVatRegistered && (
            <div className="alert alert-info mt-3 mb-0 small" role="status" aria-live="polite">
              ระบบคิดว่า <strong>ราคาสินค้าที่ตั้งไว้รวม VAT แล้ว</strong> (วิธีที่ร้านค้าปลีกไทยใช้ทั่วไป)
              แล้วแยกยอดภาษีให้เองบนใบเสร็จ — เครื่องคิดเลขที่ต้องบวก VAT เพิ่มทีหลังยังไม่รองรับ
            </div>
          )}

          <div className="row g-3 mt-3">
            <div className="col-12 col-md-4">
              <label className="form-label" htmlFor="setup-prefix">
                คำนำหน้าเลขใบเสร็จ <span className="text-danger">*</span>
              </label>
              <input
                id="setup-prefix"
                name="receiptPrefix"
                autoComplete="off"
                className="form-control"
                value={tax.receiptPrefix}
                onChange={(event) => setTax({ ...tax, receiptPrefix: event.target.value })}
              />
              <div className="form-text">เช่น RC จะได้เลข RC-2026-000001</div>
            </div>
            <div className="col-12 col-md-8">
              <label className="form-label" htmlFor="setup-footer">
                ข้อความท้ายใบเสร็จ
              </label>
              <input
                id="setup-footer"
                name="receiptFooter"
                autoComplete="off"
                className="form-control"
                value={tax.receiptFooter}
                onChange={(event) => setTax({ ...tax, receiptFooter: event.target.value })}
                placeholder="เช่น ขอบคุณที่ใช้บริการ"
              />
            </div>
          </div>

          <div className="d-flex justify-content-between mt-4">
            <button type="button" className="btn btn-soft-secondary" onClick={() => goTo('shop')}>
              ย้อนกลับ
            </button>
            <button type="button" className="btn btn-primary" onClick={continueFromTax}>
              ถัดไป
            </button>
          </div>
        </Card>
      )}

      {step === 'admin' && (
        <Card title="บัญชีผู้ดูแลระบบคนแรก" subtitle="บัญชีนี้จัดการสินค้า พนักงาน และรายงานทั้งหมด">
          <div className="row g-3">
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="setup-admin-name">
                ชื่อ-นามสกุล <span className="text-danger">*</span>
              </label>
              <input
                id="setup-admin-name"
                name="adminName"
                autoComplete="name"
                className="form-control"
                value={admin.fullName}
                onChange={(event) => setAdmin({ ...admin, fullName: event.target.value })}
              />
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="setup-admin-phone">
                เบอร์โทร (ใช้เข้าสู่ระบบ) <span className="text-danger">*</span>
              </label>
              <input
                id="setup-admin-phone"
                name="adminPhone"
                autoComplete="tel"
                className="form-control"
                value={admin.phone}
                onChange={(event) => setAdmin({ ...admin, phone: event.target.value })}
              />
            </div>
            <div className="col-12">
              <label className="form-label" htmlFor="setup-admin-email">
                อีเมล
              </label>
              <input
                id="setup-admin-email"
                name="adminEmail"
                type="email"
                autoComplete="email"
                className="form-control"
                value={admin.email}
                onChange={(event) => setAdmin({ ...admin, email: event.target.value })}
              />
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="setup-admin-password">
                รหัสผ่าน <span className="text-danger">*</span>
              </label>
              <input
                id="setup-admin-password"
                name="adminPassword"
                type="password"
                autoComplete="new-password"
                className="form-control"
                value={admin.password}
                onChange={(event) => setAdmin({ ...admin, password: event.target.value })}
              />
              <div className="form-text">อย่างน้อย 8 ตัวอักษร</div>
            </div>
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="setup-admin-confirm">
                ยืนยันรหัสผ่าน <span className="text-danger">*</span>
              </label>
              <input
                id="setup-admin-confirm"
                name="adminPasswordConfirm"
                type="password"
                autoComplete="new-password"
                className="form-control"
                value={admin.confirm}
                onChange={(event) => setAdmin({ ...admin, confirm: event.target.value })}
              />
            </div>
          </div>

          <div className="d-flex justify-content-between mt-4">
            <button type="button" className="btn btn-soft-secondary" onClick={() => goTo('tax')}>
              ย้อนกลับ
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={saving}
            >
              {saving ? 'กำลังบันทึก…' : 'เริ่มใช้งานระบบ'}
            </button>
          </div>
        </Card>
      )}
    </>
  );
}
