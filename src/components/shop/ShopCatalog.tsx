'use client';

import { useCallback, useMemo, useState } from 'react';

import { Badge, Card, Money } from '@/components/hope/ui';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiPost } from '@/lib/client-api';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

export interface ShopProduct {
  id: string;
  name: string;
  barcode: string | null;
  salePrice: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  categoryName: string | null;
}

interface Placed {
  orderNumber: string;
  confirmDeadline: string;
}

/**
 * The member storefront — SRS §3 Phase 1.
 *
 * Availability shown here is `stock_qty − reserved_qty`, the same figure the
 * server guards on, so a customer cannot add something the shop has already
 * promised to someone else. If two customers race for the last unit, the loser
 * gets the server's 409 and a plain explanation rather than a silent failure.
 */
export function ShopCatalog({
  initialProducts,
  pointsBalance,
}: {
  initialProducts: ShopProduct[];
  pointsBalance: number;
}) {
  const [products, setProducts] = useState(initialProducts);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

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

  const grouped = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const map = new Map<string, ShopProduct[]>();
    for (const product of products) {
      if (term && !product.name.toLowerCase().includes(term)) {
        continue;
      }
      const key = product.categoryName ?? 'อื่น ๆ';
      map.set(key, [...(map.get(key) ?? []), product]);
    }
    return [...map.entries()];
  }, [products, filter]);

  const selected = Object.entries(quantities).filter(([, quantity]) => quantity > 0);
  const total = selected.reduce((sum, [productId, quantity]) => {
    const product = products.find((item) => item.id === productId);
    return sum + (product ? product.salePrice * quantity : 0);
  }, 0);

  const place = async (): Promise<void> => {
    if (selected.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const result = await apiPost<Placed>('/api/v1/orders', {
        type: 'preorder',
        lines: selected.map(([productId, quantity]) => ({ productId, quantity })),
      });
      setPlaced(result);
      setQuantities({});
      // Re-read availability: the reservation just moved these numbers.
      const fresh = await fetch('/api/v1/products', { credentials: 'same-origin' })
        .then((response) => response.json())
        .then((body: { data: ShopProduct[] }) => body.data);
      setProducts(fresh);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'จองสินค้าไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex justify-content-between align-items-end flex-wrap gap-2">
        <div>
          <h4 className="mb-1">สินค้าทั้งหมด</h4>
          <p className="text-muted mb-0 small">
            จำนวนที่แสดงคือจำนวนที่ขายได้จริง หลังหักสินค้าที่ถูกจองไว้แล้ว
          </p>
        </div>
        <Badge tone="warning">{pointsBalance.toLocaleString('en-US')} คะแนน</Badge>
      </div>

      {placed && (
        <div className="alert alert-success">
          <strong>จองสำเร็จ!</strong> เลขที่ออเดอร์ <code>{placed.orderNumber}</code>
          <span className="d-block small">
            ร้านจะยืนยันภายใน 15 นาที มิฉะนั้นออเดอร์จะถูกยกเลิกและคืนสต็อกอัตโนมัติ
          </span>
        </div>
      )}

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="row g-3">
        <div className="col-12 col-xl-8">
          <Card
            title="เลือกสินค้า"
            actions={
              <input
                className="form-control form-control-sm"
                placeholder="ค้นหาสินค้า"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            }
          >
            {grouped.map(([category, items]) => (
              <div className="mb-3" key={category}>
                <h6 className="text-muted small mb-2">{category}</h6>
                <div className="row g-2">
                  {items.map((product) => {
                    const quantity = quantities[product.id] ?? 0;
                    const soldOut = product.availableQty <= 0;

                    return (
                      <div className="col-12 col-md-6" key={product.id}>
                        <div className={`border rounded p-2 h-100 ${soldOut ? 'opacity-50' : ''}`}>
                          <div className="d-flex justify-content-between">
                            <span className="small fw-medium">{product.name}</span>
                            <Money amount={product.salePrice} className="small fw-bold" />
                          </div>
                          <div className="d-flex justify-content-between align-items-center mt-2">
                            <Badge tone={soldOut ? 'danger' : product.availableQty <= 5 ? 'warning' : 'success'}>
                              {soldOut ? 'สินค้าหมด' : `ขายได้ ${product.availableQty}`}
                            </Badge>
                            <div className="input-group input-group-sm" style={{ width: 110 }}>
                              <button
                                type="button"
                                className="btn btn-outline-secondary"
                                disabled={soldOut || quantity <= 0}
                                onClick={() =>
                                  setQuantities((current) => ({
                                    ...current,
                                    [product.id]: Math.max(0, (current[product.id] ?? 0) - 1),
                                  }))
                                }
                              >
                                −
                              </button>
                              <input className="form-control text-center" value={quantity} readOnly aria-label="จำนวน" />
                              <button
                                type="button"
                                className="btn btn-outline-secondary"
                                disabled={soldOut || quantity >= product.availableQty}
                                onClick={() =>
                                  setQuantities((current) => ({
                                    ...current,
                                    [product.id]: Math.min(
                                      product.availableQty,
                                      (current[product.id] ?? 0) + 1,
                                    ),
                                  }))
                                }
                              >
                                +
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </Card>
        </div>

        <div className="col-12 col-xl-4">
          <Card title="รายการจอง">
            {selected.length === 0 ? (
              <p className="text-muted small mb-0">ยังไม่ได้เลือกสินค้า</p>
            ) : (
              <>
                <ul className="list-group list-group-flush mb-3">
                  {selected.map(([productId, quantity]) => {
                    const product = products.find((item) => item.id === productId);
                    if (!product) {
                      return null;
                    }
                    return (
                      <li className="list-group-item d-flex justify-content-between px-0 small" key={productId}>
                        <span>
                          {product.name} × {quantity}
                        </span>
                        <Money amount={product.salePrice * quantity} />
                      </li>
                    );
                  })}
                </ul>
                <div className="d-flex justify-content-between fw-bold mb-3">
                  <span>รวม</span>
                  <Money amount={total} />
                </div>
              </>
            )}

            <button
              type="button"
              className="btn btn-primary w-100"
              disabled={busy || selected.length === 0}
              onClick={() => void place()}
            >
              {busy ? 'กำลังจอง…' : 'จองสินค้า (พรีออเดอร์)'}
            </button>
            <p className="text-muted small mt-2 mb-0">
              ยังไม่ต้องชำระเงิน — ชำระตอนมารับสินค้าที่ร้าน
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
