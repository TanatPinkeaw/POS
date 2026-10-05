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
 * anything twice. The step chips are the most navigation this screen will ever
 * need, and they carry their state in a word (`1. ข้อมูลร้าน`) as well as in a
 * colour, because this is the first screen a renter ever sees.
 */
import { useState } from 'react';

import {
  Button,
  Card,
  FieldRow,
  InlineNotice,
  LinkButton,
  Pill,
  Stack,
  TextAreaField,
  TextField,
  ToggleField,
  Toolbar,
} from '@/components/ds';
import { apiPost } from '@/lib/client-api';
import { DEFAULT_RECEIPT_PREFIX, DEFAULT_VAT_RATE } from '@/lib/shop-view';

type Step = 'shop' | 'tax' | 'admin' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'shop', label: 'ข้อมูลร้าน' },
  { key: 'tax', label: 'ภาษี & ใบเสร็จ' },
  { key: 'admin', label: 'ผู้ดูแลระบบ' },
];

export function SetupWizard() {
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

  /*
   * The two questions about how this counter works, rather than about money
   * (ADR 0027 and 0028), asked here rather than guessed from anything else. Both are
   * asked on the step that already owns the slip the customer walks away with, and
   * both default to true to match their columns: a shop that hands everything over
   * on the spot turns them off in two taps, and a shop that calls people and takes
   * orders ahead does not have to know either feature exists to get it.
   *
   * They live in `tax` even though neither is a tax question, because that is the
   * step's state and splitting it would put two boxes of answers for one step.
   */
  const [tax, setTax] = useState({
    isVatRegistered: false,
    callsNumbers: true,
    acceptsPreorders: true,
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
          callsNumbers: tax.callsNumbers,
          acceptsPreorders: tax.acceptsPreorders,
        },
        admin: {
          fullName: admin.fullName.trim(),
          phone: admin.phone.trim(),
          email: admin.email.trim() || null,
          password: admin.password,
        },
      });
      /*
       * Deliberately no `router.refresh()` here.
       *
       * The page's own gate redirects to `/login` the moment a shop exists, so
       * refreshing would bounce the renter off this screen before they could read
       * it — and the phone number on it is the answer to the question the sign-in
       * page is about to ask them.
       */
      setStep('done');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ตั้งค่าไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  if (step === 'done') {
    return (
      <Card title="ตั้งค่าระบบเรียบร้อยแล้ว">
        <Stack gap="md">
          <p>
            ร้าน <strong>{shop.name}</strong> พร้อมใช้งานแล้ว
            {tax.isVatRegistered ? ' และออกใบกำกับภาษีได้' : ''}
          </p>
          <p className="ln-muted">
            เข้าสู่ระบบด้วยเบอร์โทร <code className="ln-mono">{admin.phone}</code>{' '}
            และรหัสผ่านที่คุณตั้งไว้
          </p>
          <div className="ln-row">
            <LinkButton href="/login" icon="logOut">
              ไปหน้าเข้าสู่ระบบ
            </LinkButton>
            <LinkButton href="/admin/products" variant="secondary" icon="box">
              เริ่มเพิ่มสินค้า
            </LinkButton>
          </div>
        </Stack>
      </Card>
    );
  }

  return (
    <Stack gap="md">
      <ol className="ln-row">
        {STEPS.map((entry, index) => {
          const state = index === stepIndex ? 'active' : index < stepIndex ? 'done' : 'todo';
          return (
            <li key={entry.key}>
              <Pill
                tone={state === 'active' ? 'brand' : state === 'done' ? 'success' : 'neutral'}
                solid={state === 'active'}
                icon={state === 'done' ? 'check' : undefined}
              >
                {index + 1}. {entry.label}
              </Pill>
            </li>
          );
        })}
      </ol>

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {step === 'shop' ? (
        <Card title="ข้อมูลร้าน" subtitle="ข้อมูลนี้จะพิมพ์อยู่บนหัวใบเสร็จ">
          <Stack gap="md">
            <TextField
              id="setup-name"
              label="ชื่อร้าน"
              autoComplete="organization"
              required
              placeholder="เช่น มินิมาร์ทสุขใจ"
              value={shop.name}
              onChange={(event) => setShop({ ...shop, name: event.target.value })}
            />

            <FieldRow columns={2}>
              <TextField
                id="setup-branch"
                label="สาขา"
                autoComplete="off"
                placeholder="เช่น สาขาตลาดกลาง"
                value={shop.branchLabel}
                onChange={(event) => setShop({ ...shop, branchLabel: event.target.value })}
              />
              <TextField
                id="setup-phone"
                label="เบอร์โทรร้าน"
                autoComplete="tel"
                inputMode="tel"
                className="ln-num"
                value={shop.phone}
                onChange={(event) => setShop({ ...shop, phone: event.target.value })}
              />
            </FieldRow>

            <TextAreaField
              id="setup-address"
              label="ที่อยู่"
              autoComplete="street-address"
              rows={2}
              value={shop.address}
              onChange={(event) => setShop({ ...shop, address: event.target.value })}
            />

            <Toolbar
              actions={
                <Button iconAfter="arrowRight" onClick={continueFromShop}>
                  ถัดไป
                </Button>
              }
            />
          </Stack>
        </Card>
      ) : null}

      {step === 'tax' ? (
        <Card
          title="ภาษีและใบเสร็จ"
          subtitle="ตอบได้แม้ยังไม่แน่ใจ — แก้ไขภายหลังได้ที่หน้าตั้งค่าร้าน"
        >
          <Stack gap="md">
            <ToggleField
              id="setup-vat"
              label="ร้านจดทะเบียน VAT"
              checked={tax.isVatRegistered}
              onChange={(next) => setTax({ ...tax, isVatRegistered: next })}
            />

            <ToggleField
              id="setup-calls-numbers"
              label="เรียกลูกด้วยเลขคิว"
              help="สำหรับร้านที่ลูกค้าต้องยืนรอของอยู่ — ปิดไว้ถ้าร้านส่งของให้จบในบิลเดียว บิลก็จะไม่มีเลขคิว และหน้าขายจะไม่มีบอร์ดคิว"
              checked={tax.callsNumbers}
              onChange={(next) => setTax({ ...tax, callsNumbers: next })}
            />

            <ToggleField
              id="setup-accepts-preorders"
              label="เปิดรับพรีออเดอร์"
              help="สำหรับร้านที่เตรียมของไว้ล่วงหน้า — ปิดไว้ถ้าร้านขายสินค้าที่พร้อมขายได้เลย"
              checked={tax.acceptsPreorders}
              onChange={(next) => setTax({ ...tax, acceptsPreorders: next })}
            />

            {tax.isVatRegistered ? (
              <>
                <FieldRow columns={2}>
                  <TextField
                    id="setup-taxid"
                    label="เลขประจำตัวผู้เสียภาษี"
                    autoComplete="off"
                    inputMode="numeric"
                    maxLength={13}
                    className="ln-num ln-mono"
                    required
                    placeholder="13 หลัก"
                    value={tax.taxId}
                    onChange={(event) =>
                      setTax({ ...tax, taxId: event.target.value.replace(/\D/g, '').slice(0, 13) })
                    }
                  />
                  <TextField
                    id="setup-vatrate"
                    label="อัตรา VAT (%)"
                    autoComplete="off"
                    inputMode="decimal"
                    className="ln-num"
                    value={tax.vatRate}
                    onChange={(event) => setTax({ ...tax, vatRate: event.target.value })}
                  />
                </FieldRow>

                <InlineNotice tone="info">
                  ระบบคิดว่า <strong>ราคาสินค้าที่ตั้งไว้รวม VAT แล้ว</strong>{' '}
                  (วิธีที่ร้านค้าปลีกไทยใช้ทั่วไป) แล้วแยกยอดภาษีให้เองบนใบเสร็จ —
                  เครื่องคิดเลขที่ต้องบวก VAT เพิ่มทีหลังยังไม่รองรับ
                </InlineNotice>
              </>
            ) : null}

            <FieldRow columns={2}>
              <TextField
                id="setup-prefix"
                label="คำนำหน้าเลขใบเสร็จ"
                autoComplete="off"
                className="ln-mono"
                required
                help="เช่น RC จะได้เลข RC-2026-000001"
                value={tax.receiptPrefix}
                onChange={(event) => setTax({ ...tax, receiptPrefix: event.target.value })}
              />
              <TextField
                id="setup-footer"
                label="ข้อความท้ายใบเสร็จ"
                autoComplete="off"
                placeholder="เช่น ขอบคุณที่ใช้บริการ"
                value={tax.receiptFooter}
                onChange={(event) => setTax({ ...tax, receiptFooter: event.target.value })}
              />
            </FieldRow>

            <Toolbar
              actions={
                <Button iconAfter="arrowRight" onClick={continueFromTax}>
                  ถัดไป
                </Button>
              }
            >
              <Button variant="secondary" icon="arrowLeft" onClick={() => goTo('shop')}>
                ย้อนกลับ
              </Button>
            </Toolbar>
          </Stack>
        </Card>
      ) : null}

      {step === 'admin' ? (
        <Card title="บัญชีผู้ดูแลระบบคนแรก" subtitle="บัญชีนี้จัดการสินค้า พนักงาน และรายงานทั้งหมด">
          <Stack gap="md">
            <FieldRow columns={2}>
              <TextField
                id="setup-admin-name"
                label="ชื่อ-นามสกุล"
                autoComplete="name"
                required
                value={admin.fullName}
                onChange={(event) => setAdmin({ ...admin, fullName: event.target.value })}
              />
              <TextField
                id="setup-admin-phone"
                label="เบอร์โทร (ใช้เข้าสู่ระบบ)"
                autoComplete="tel"
                inputMode="tel"
                className="ln-num"
                required
                value={admin.phone}
                onChange={(event) => setAdmin({ ...admin, phone: event.target.value })}
              />
            </FieldRow>

            <TextField
              id="setup-admin-email"
              label="อีเมล"
              type="email"
              autoComplete="email"
              value={admin.email}
              onChange={(event) => setAdmin({ ...admin, email: event.target.value })}
            />

            <FieldRow columns={2}>
              <TextField
                id="setup-admin-password"
                label="รหัสผ่าน"
                type="password"
                autoComplete="new-password"
                required
                help="อย่างน้อย 8 ตัวอักษร"
                value={admin.password}
                onChange={(event) => setAdmin({ ...admin, password: event.target.value })}
              />
              <TextField
                id="setup-admin-confirm"
                label="ยืนยันรหัสผ่าน"
                type="password"
                autoComplete="new-password"
                required
                value={admin.confirm}
                onChange={(event) => setAdmin({ ...admin, confirm: event.target.value })}
              />
            </FieldRow>

            <Toolbar
              actions={
                <Button icon="check" loading={saving} onClick={() => void submit()}>
                  เริ่มใช้งานระบบ
                </Button>
              }
            >
              <Button variant="secondary" icon="arrowLeft" onClick={() => goTo('tax')}>
                ย้อนกลับ
              </Button>
            </Toolbar>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}
