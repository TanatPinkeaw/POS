'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import { Money } from '@/components/hope/ui';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';

import type { Shift } from './useOpenShift';

export interface PosProduct {
  id: string;
  name: string;
  barcode: string | null;
  salePrice: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  categoryName: string | null;
}

interface CartLine {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  availableQty: number;
}

interface Member {
  id: string;
  fullName: string;
  phone: string;
  pointsBalance: number;
}

interface SaleResult {
  orderId: string;
  orderNumber: string;
  finalAmountThb: number;
  discountThb: number;
  paidThb: number;
  changeThb: number;
  pointsEarned: number;
  pointsRedeemed: number;
  lines: { name: string; quantity: number; unitPrice: number; totalPrice: number }[];
}

/**
 * The POS terminal.
 *
 * Checkout is the one screen where the SRS's concurrency rules become visible
 * to a human: when two tills sell the last unit, the loser sees "สต็อกไม่พอ"
 * and the till states stay consistent, because the server enforces the guard in
 * a single conditional UPDATE rather than trusting the client's cached counts.
 */
export function PosTerminal({
  initialProducts,
  shift,
  onShiftRefresh,
}: {
  initialProducts: PosProduct[];
  /** Null until a drawer is open; checkout is disabled while it is. */
  shift: Shift | null;
  onShiftRefresh: () => Promise<void> | void;
}) {
  const [products, setProducts] = useState(initialProducts);
  const [scan, setScan] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState('');
  const [member, setMember] = useState<Member | null>(null);
  const [memberQuery, setMemberQuery] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);
  const [usePoints, setUsePoints] = useState(false);
  const [cashReceived, setCashReceived] = useState('');
  const [promptpay, setPromptpay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SaleResult | null>(null);
  const scanInput = useRef<HTMLInputElement | null>(null);

  // Live stock: any other till, any other reservation, updates this screen.
  useRealtimeEvent<{ productId: string; stockQty: number; reservedQty: number; availableQty: number }>(
    REALTIME_EVENTS.stockUpdated,
    useCallback((payload) => {
      setProducts((current) =>
        current.map((product) =>
          product.id === payload.productId
            ? {
                ...product,
                stockQty: payload.stockQty,
                reservedQty: payload.reservedQty,
                availableQty: payload.availableQty,
              }
            : product,
        ),
      );
    }, []),
  );

  const subtotal = useMemo(
    () => lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0),
    [lines],
  );
  const discountValue = Number(discount || 0);
  const pointsValue = usePoints && member ? Math.min(Math.floor(member.pointsBalance / 100), Math.floor(subtotal - discountValue)) : 0;
  const due = Math.max(0, Math.round((subtotal - discountValue - pointsValue) * 100) / 100);
  const cash = Number(cashReceived || 0);
  const change = Math.max(0, Math.round((cash - (promptpay ? due : 0)) * 100) / 100);

  const addLine = (product: PosProduct): void => {
    if (product.availableQty <= 0) {
      setError(`"${product.name}" ขายได้ 0 ชิ้น (คงเหลือ ${product.stockQty} · จองไว้ ${product.reservedQty})`);
      return;
    }
    setError(null);
    setLines((current) => {
      const found = current.find((line) => line.productId === product.id);
      if (found) {
        if (found.quantity + 1 > product.availableQty) {
          setError(`"${product.name}" เหลือขายได้ ${product.availableQty} ชิ้น`);
          return current;
        }
        return current.map((line) =>
          line.productId === product.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...current,
        {
          productId: product.id,
          name: product.name,
          unitPrice: product.salePrice,
          quantity: 1,
          availableQty: product.availableQty,
        },
      ];
    });
  };

  const setQuantity = (productId: string, quantity: number): void => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((line) => line.productId !== productId)
        : current.map((line) =>
            line.productId === productId
              ? { ...line, quantity: Math.min(quantity, line.availableQty) }
              : line,
          ),
    );
  };

  const searchTerm = scan.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!searchTerm) {
      return products.slice(0, 24);
    }
    return products
      .filter(
        (product) =>
          product.name.toLowerCase().includes(searchTerm) ||
          (product.barcode ?? '').includes(searchTerm),
      )
      .slice(0, 24);
  }, [products, searchTerm]);

  /**
   * A USB barcode scanner types the code and presses Enter, so an exact barcode
   * match on submit adds the line and clears the field — no mouse needed.
   */
  const submitScan = (): void => {
    const term = scan.trim();
    if (!term) {
      return;
    }
    const exact = products.find((product) => product.barcode === term);
    const target = exact ?? (matches.length === 1 ? matches[0] : undefined);

    if (!target) {
      setError(`ไม่พบสินค้าที่ตรงกับ "${term}"`);
      return;
    }

    addLine(target);
    setScan('');
    scanInput.current?.focus();
  };

  const findMember = async (): Promise<void> => {
    setMemberError(null);
    try {
      const found = await apiFetch<Member[]>(
        `/api/v1/members?phone=${encodeURIComponent(memberQuery.trim())}`,
      );
      if (found.length === 0) {
        setMemberError('ไม่พบสมาชิกเบอร์นี้');
        return;
      }
      setMember(found[0]!);
      setUsePoints(false);
    } catch (caught) {
      setMemberError(caught instanceof Error ? caught.message : 'ค้นหาสมาชิกไม่สำเร็จ');
    }
  };

  const checkout = async (): Promise<void> => {
    if (!shift) {
      setError('ต้องเปิดลิ้นชักก่อนรับชำระเงิน');
      return;
    }
    if (lines.length === 0) {
      setError('ยังไม่มีสินค้าในตะกร้า');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const pointsToRedeem = usePoints && member ? Math.floor(member.pointsBalance / 100) * 100 : 0;
      const result = await apiPost<SaleResult>('/api/v1/orders', {
        type: 'pos_walkin',
        shiftId: shift.id,
        lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        customerId: member?.id ?? null,
        discountThb: discountValue,
        settlement: promptpay
          ? { promptpay: due, points: pointsToRedeem }
          : { cash: due, receivedCash: cash || due, points: pointsToRedeem },
      });

      setReceipt(result);
      setLines([]);
      setDiscount('');
      setCashReceived('');
      setUsePoints(false);
      setMember(null);
      setMemberQuery('');
      await onShiftRefresh();
      // Pull the authoritative stock counts rather than guessing locally.
      const fresh = await apiFetch<PosProduct[]>('/api/v1/products');
      setProducts(fresh);
      scanInput.current?.focus();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'ชำระเงินไม่สำเร็จ กรุณาลองใหม่',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row g-3">
      <div className="col-12 col-xl-7">
        <div className="card">
          <div className="card-body">
            <label className="form-label" htmlFor="scan">
              สแกนบาร์โค้ด หรือค้นหาสินค้า
            </label>
            <input
              id="scan"
              ref={scanInput}
              className="form-control pos-scan-input mb-3"
              placeholder="ยิงบาร์โค้ดแล้วกด Enter หรือพิมพ์ชื่อสินค้า"
              value={scan}
              autoComplete="off"
              onChange={(event) => setScan(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitScan();
                }
              }}
            />

            <div className="row g-2">
              {matches.map((product) => (
                <div className="col-6 col-md-4" key={product.id}>
                  <button
                    type="button"
                    className="btn btn-soft-primary text-start w-100 h-100 p-2"
                    onClick={() => addLine(product)}
                    disabled={product.availableQty <= 0 || !shift}
                  >
                    <span className="d-block small fw-medium text-truncate">{product.name}</span>
                    <span className="d-block small text-muted">
                      {product.categoryName ?? '—'}
                    </span>
                    <span className="d-flex justify-content-between align-items-center mt-1">
                      <Money amount={product.salePrice} className="fw-bold" />
                      <span className={`small ${product.availableQty <= 0 ? 'text-danger' : 'text-muted'}`}>
                        เหลือ {product.availableQty}
                      </span>
                    </span>
                  </button>
                </div>
              ))}
              {matches.length === 0 && (
                <div className="col-12">
                  <p className="text-muted mb-0">ไม่พบสินค้า</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="col-12 col-xl-5">
        <div className="card">
          <div className="card-header d-flex justify-content-between align-items-center">
            <h5 className="card-title mb-0">ตะกร้า</h5>
            {lines.length > 0 && (
              <button type="button" className="btn btn-sm btn-soft-danger" onClick={() => setLines([])}>
                ล้าง
              </button>
            )}
          </div>
          <div className="card-body">
            {lines.length === 0 ? (
              <p className="text-muted mb-0">สแกนหรือเลือกสินค้าเพื่อเริ่มขาย</p>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm align-middle mb-3">
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.productId}>
                        <td>
                          <span className="d-block small">{line.name}</span>
                          <span className="text-muted small">
                            <Money amount={line.unitPrice} /> / ชิ้น
                          </span>
                        </td>
                        <td style={{ width: 120 }}>
                          <div className="input-group input-group-sm">
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              onClick={() => setQuantity(line.productId, line.quantity - 1)}
                            >
                              −
                            </button>
                            <input
                              className="form-control text-center"
                              value={line.quantity}
                              readOnly
                              aria-label="จำนวน"
                            />
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              onClick={() => setQuantity(line.productId, line.quantity + 1)}
                            >
                              +
                            </button>
                          </div>
                        </td>
                        <td className="pos-numeric">
                          <Money amount={line.unitPrice * line.quantity} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mb-3">
              <label className="form-label small" htmlFor="member">
                สมาชิก (ไม่บังคับ)
              </label>
              <div className="input-group input-group-sm">
                <input
                  id="member"
                  className="form-control"
                  placeholder="เบอร์โทรสมาชิก"
                  value={memberQuery}
                  onChange={(event) => setMemberQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void findMember();
                    }
                  }}
                />
                <button type="button" className="btn btn-outline-primary" onClick={() => void findMember()}>
                  ค้นหา
                </button>
              </div>
              {memberError && <span className="text-danger small">{memberError}</span>}
              {member && (
                <div className="d-flex justify-content-between align-items-center mt-2 small">
                  <span>
                    {member.fullName} · {member.pointsBalance} คะแนน
                  </span>
                  <button
                    type="button"
                    className="btn btn-link btn-sm p-0"
                    onClick={() => {
                      setMember(null);
                      setUsePoints(false);
                    }}
                  >
                    เอาออก
                  </button>
                </div>
              )}
            </div>

            <div className="row g-2 mb-3">
              {member && member.pointsBalance >= 100 && (
                <div className="col-12">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="use-points"
                      checked={usePoints}
                      onChange={(event) => setUsePoints(event.target.checked)}
                    />
                    <label className="form-check-label small" htmlFor="use-points">
                      ใช้คะแนน (100 คะแนน = 1 บาท)
                    </label>
                  </div>
                </div>
              )}
              <div className="col-6">
                <label className="form-label small" htmlFor="discount">
                  ส่วนลด (บาท)
                </label>
                <input
                  id="discount"
                  className="form-control form-control-sm pos-numeric"
                  inputMode="decimal"
                  value={discount}
                  onChange={(event) => setDiscount(event.target.value)}
                />
              </div>
              <div className="col-6">
                <label className="form-label small" htmlFor="cash">
                  รับเงินสด (บาท)
                </label>
                <input
                  id="cash"
                  className="form-control form-control-sm pos-numeric"
                  inputMode="decimal"
                  value={cashReceived}
                  onChange={(event) => setCashReceived(event.target.value)}
                  disabled={promptpay}
                />
              </div>
              <div className="col-12">
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="promptpay"
                    checked={promptpay}
                    onChange={(event) => setPromptpay(event.target.checked)}
                  />
                  <label className="form-check-label small" htmlFor="promptpay">
                    ชำระด้วยพร้อมเพย์
                  </label>
                </div>
              </div>
            </div>

            <dl className="row mb-3 small">
              <dt className="col-6 fw-normal text-muted">ยอดรวม</dt>
              <dd className="col-6 pos-numeric mb-1">
                <Money amount={subtotal} />
              </dd>
              <dt className="col-6 fw-normal text-muted">ส่วนลด</dt>
              <dd className="col-6 pos-numeric mb-1">
                <Money amount={discountValue + pointsValue} />
              </dd>
              <dt className="col-6 fw-bold">ยอดชำระ</dt>
              <dd className="col-6 pos-numeric mb-1 fw-bold">
                <Money amount={due} />
              </dd>
              {!promptpay && (
                <>
                  <dt className="col-6 fw-normal text-muted">เงินทอน</dt>
                  <dd className="col-6 pos-numeric mb-0">
                    <Money amount={change} />
                  </dd>
                </>
              )}
            </dl>

            {error && <div className="alert alert-danger py-2 small">{error}</div>}

            <button
              type="button"
              className="btn btn-primary w-100"
              disabled={busy || lines.length === 0 || !shift}
              onClick={() => void checkout()}
            >
              {busy ? 'กำลังบันทึก…' : !shift ? 'ต้องเปิดลิ้นชักก่อน' : 'รับชำระเงิน'}
            </button>
          </div>
        </div>
      </div>

      {receipt && (
        <div className="modal fade show d-block" role="dialog" aria-modal="true">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">ชำระเงินสำเร็จ</h5>
                <button type="button" className="btn-close" onClick={() => setReceipt(null)} />
              </div>
              <div className="modal-body pos-receipt">
                <p className="text-center mb-1 fw-bold">ใบเสร็จรับเงิน</p>
                <p className="text-center small text-muted mb-3">{receipt.orderNumber}</p>
                {receipt.lines.map((line) => (
                  <div key={`${line.name}-${line.quantity}`} className="d-flex justify-content-between">
                    <span>
                      {line.name} × {line.quantity}
                    </span>
                    <span>{line.totalPrice.toFixed(2)}</span>
                  </div>
                ))}
                <hr />
                <div className="d-flex justify-content-between">
                  <span>ส่วนลด</span>
                  <span>{receipt.discountThb.toFixed(2)}</span>
                </div>
                <div className="d-flex justify-content-between fw-bold">
                  <span>ยอดชำระ</span>
                  <span>{receipt.finalAmountThb.toFixed(2)}</span>
                </div>
                <div className="d-flex justify-content-between">
                  <span>เงินทอน</span>
                  <span>{receipt.changeThb.toFixed(2)}</span>
                </div>
                {receipt.pointsEarned > 0 && (
                  <p className="text-center small mt-3 mb-0">
                    ได้รับ {receipt.pointsEarned} คะแนน
                  </p>
                )}
              </div>
              <div className="modal-footer no-print">
                <button type="button" className="btn btn-soft-secondary" onClick={() => window.print()}>
                  พิมพ์
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setReceipt(null)}>
                  ปิด
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
