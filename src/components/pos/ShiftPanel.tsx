'use client';

import { useState } from 'react';

import { Badge, Card, Money } from '@/components/hope/ui';

import type { Shift } from './useOpenShift';

/**
 * Cash drawer panel — SRS §6.2.
 *
 * Opening the drawer is a prerequisite for taking payment, so the panel is
 * explicit about that rather than letting the till fail at checkout time.
 */
export function ShiftPanel({
  shift,
  defaultInitialCash,
  loading,
  onOpen,
  onClose,
}: {
  shift: Shift | null;
  defaultInitialCash: number;
  loading: boolean;
  onOpen: (initialCash: number) => Promise<unknown>;
  onClose: (actualCash: number) => Promise<Shift>;
}) {
  const [initialCash, setInitialCash] = useState<string>('');
  const [actualCash, setActualCash] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (loading) {
    return (
      <Card title="ลิ้นชักเงินสด">
        <p className="text-muted mb-0">กำลังโหลด…</p>
      </Card>
    );
  }

  if (!shift) {
    return (
      <Card title="ลิ้นชักเงินสด" subtitle="ต้องเปิดลิ้นชักก่อนรับชำระเงิน">
        {error && <div className="alert alert-danger py-2 small">{error}</div>}
        <label className="form-label small" htmlFor="initial-cash">
          เงินทอนเริ่มต้น (บาท)
        </label>
        <div className="d-flex gap-2">
          <input
            id="initial-cash"
            className="form-control pos-numeric"
            inputMode="decimal"
            placeholder={String(defaultInitialCash)}
            value={initialCash}
            onChange={(event) => setInitialCash(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary text-nowrap"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onOpen(Number(initialCash || defaultInitialCash))
                .catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : 'เปิดลิ้นชักไม่สำเร็จ'),
                )
                .finally(() => {
                  setBusy(false);
                  setInitialCash('');
                });
            }}
          >
            เปิดลิ้นชัก
          </button>
        </div>
      </Card>
    );
  }

  const discrepancyPreview =
    actualCash === ''
      ? null
      : Math.round((Number(actualCash) - shift.expectedCashThb) * 100) / 100;

  return (
    <Card
      title="ลิ้นชักเงินสด"
      subtitle={`เปิดเมื่อ ${new Date(shift.openedAt).toLocaleString('th-TH')}`}
      actions={<Badge tone="success">เปิดอยู่</Badge>}
    >
      {message && <div className="alert alert-success py-2 small">{message}</div>}
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <dl className="row mb-3 small">
        <dt className="col-7 fw-normal text-muted">เงินทอนเริ่มต้น</dt>
        <dd className="col-5 pos-numeric mb-1">
          <Money amount={shift.initialCashThb} />
        </dd>
        <dt className="col-7 fw-normal text-muted">ขายเงินสดสะสม ({shift.orderCount} ออเดอร์)</dt>
        <dd className="col-5 pos-numeric mb-1">
          <Money amount={shift.cashSalesThb} />
        </dd>
        <dt className="col-7 fw-bold">เงินที่ควรมีในลิ้นชัก</dt>
        <dd className="col-5 pos-numeric mb-1 fw-bold">
          <Money amount={shift.expectedCashThb} />
        </dd>
      </dl>

      <label className="form-label small" htmlFor="actual-cash">
        นับเงินจริงได้ (บาท)
      </label>
      <input
        id="actual-cash"
        className="form-control pos-numeric mb-2"
        inputMode="decimal"
        value={actualCash}
        onChange={(event) => setActualCash(event.target.value)}
      />

      {discrepancyPreview !== null && (
        <p className={`small ${discrepancyPreview === 0 ? 'text-success' : 'text-danger'}`}>
          ผลต่าง: <Money amount={discrepancyPreview} />{' '}
          {discrepancyPreview === 0 ? '(ตรงพอดี)' : discrepancyPreview < 0 ? '(ขาด)' : '(เกิน)'}
        </p>
      )}

      <button
        type="button"
        className="btn btn-outline-danger w-100"
        disabled={busy || actualCash === ''}
        onClick={() => {
          setBusy(true);
          setError(null);
          setMessage(null);
          void onClose(Number(actualCash))
            .then((closed) => {
              const kind = closed.discrepancyKind;
              setMessage(
                kind === 'balanced'
                  ? 'ปิดกะเรียบร้อย เงินตรงพอดี'
                  : kind === 'shortage'
                    ? `ปิดกะแล้ว พบเงินขาด ${closed.discrepancyThb?.toFixed(2)} บาท`
                    : `ปิดกะแล้ว พบเงินเกิน ${closed.discrepancyThb?.toFixed(2)} บาท`,
              );
              setActualCash('');
            })
            .catch((caught: unknown) =>
              setError(caught instanceof Error ? caught.message : 'ปิดกะไม่สำเร็จ'),
            )
            .finally(() => setBusy(false));
        }}
      >
        ปิดกะและนับเงิน
      </button>
    </Card>
  );
}
