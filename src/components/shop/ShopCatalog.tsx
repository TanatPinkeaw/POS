'use client';

import { useCallback, useMemo, useState } from 'react';

import {
  Button,
  Card,
  CategoryChip,
  EmptyState,
  InlineNotice,
  Money,
  Pill,
  SearchField,
  SplitPane,
  Stack,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiPost } from '@/lib/client-api';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

import styles from './ShopCatalog.module.css';

export interface ShopProduct {
  id: string;
  name: string;
  barcode: string | null;
  salePrice: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  categoryId: number | null;
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
 *
 * The basket holds its width on the right rather than growing with its contents,
 * for the same reason the till's bill does: the products must not move under the
 * customer's thumb as the list they are building gets longer. Grouped by aisle,
 * with the aisle's own colour, so a market with twenty categories is browsable.
 */
export function ShopCatalog({ initialProducts }: { initialProducts: ShopProduct[] }) {
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

  function setQuantity(productId: string, quantity: number): void {
    setQuantities((current) => ({ ...current, [productId]: Math.max(0, quantity) }));
  }

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
    <Stack gap="md">
      {placed ? (
        <InlineNotice tone="success" title="จองสำเร็จ!">
          เลขที่ออเดอร์ <strong className="ln-mono">{placed.orderNumber}</strong> —{' '}
          ร้านจะยืนยันภายใน 15 นาที มิฉะนั้นออเดอร์จะถูกยกเลิกและคืนสต็อกอัตโนมัติ
        </InlineNotice>
      ) : null}

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <SplitPane
        side="end"
        panelWidth="22rem"
        label="รายการจอง"
        panel={
          <Card title="รายการจอง">
            <Stack gap="md">
              {selected.length === 0 ? (
                <p className="ln-muted">ยังไม่ได้เลือกสินค้า</p>
              ) : (
                <>
                  <ul className={styles.lines}>
                    {selected.map(([productId, quantity]) => {
                      const product = products.find((item) => item.id === productId);
                      if (!product) {
                        return null;
                      }
                      return (
                        <li key={productId} className={styles.line}>
                          <span className="ln-break">
                            {product.name} × {quantity}
                          </span>
                          <Money amount={product.salePrice * quantity} />
                        </li>
                      );
                    })}
                  </ul>
                  <div className={styles.total}>
                    <span>รวม</span>
                    <Money amount={total} size="lg" />
                  </div>
                </>
              )}

              <Button
                size="lg"
                block
                icon="cart"
                loading={busy}
                disabled={selected.length === 0}
                onClick={() => void place()}
              >
                จองสินค้า (พรีออเดอร์)
              </Button>
              <p className="ln-muted">ยังไม่ต้องชำระเงิน — ชำระตอนมารับสินค้าที่ร้าน</p>
            </Stack>
          </Card>
        }
      >
        <Card
          title="เลือกสินค้า"
          toolbar={
            <SearchField
              id="shop-search"
              label="ค้นหาสินค้า"
              placeholder="ค้นหาชื่อสินค้า"
              value={filter}
              onChange={setFilter}
            />
          }
        >
          {grouped.length === 0 ? (
            <EmptyState
              icon="box"
              title={filter ? 'ไม่พบสินค้าที่ค้นหา' : 'ยังไม่มีสินค้าให้จอง'}
              description={filter ? 'ลองคำอื่น หรือล้างคำค้นหา' : 'ร้านยังไม่ได้เพิ่มสินค้าเข้าระบบ'}
            />
          ) : (
            <Stack gap="lg">
              {grouped.map(([category, items]) => (
                <Stack gap="sm" key={category}>
                  <CategoryChip categoryId={items[0]?.categoryId} name={category} />
                  <div className={styles.grid}>
                    {items.map((product) => {
                      const quantity = quantities[product.id] ?? 0;
                      const soldOut = product.availableQty <= 0;

                      return (
                        <div className={styles.tile} key={product.id} data-sold-out={soldOut}>
                          <div className={styles.head}>
                            <span className={styles.name}>{product.name}</span>
                            <Money amount={product.salePrice} />
                          </div>

                          <div className={styles.foot}>
                            <Pill
                              tone={
                                soldOut
                                  ? 'danger'
                                  : product.availableQty <= 5
                                    ? 'warning'
                                    : 'success'
                              }
                            >
                              {soldOut ? 'สินค้าหมด' : `ขายได้ ${product.availableQty}`}
                            </Pill>

                            <span className={styles.stepper}>
                              {/*
                               * `ln-tap` on both: these two are tapped over and
                               * over by a thumb, so they hold the touch minimum
                               * whatever the area's density is.
                               */}
                              <button
                                type="button"
                                className={`${styles.stepperButton} ln-tap`}
                                aria-label={`ลดจำนวน ${product.name}`}
                                disabled={soldOut || quantity <= 0}
                                onClick={() => setQuantity(product.id, quantity - 1)}
                              >
                                −
                              </button>
                              <span className={styles.stepperValue} aria-live="polite">
                                {quantity}
                              </span>
                              <button
                                type="button"
                                className={`${styles.stepperButton} ln-tap`}
                                aria-label={`เพิ่มจำนวน ${product.name}`}
                                disabled={soldOut || quantity >= product.availableQty}
                                onClick={() => setQuantity(product.id, quantity + 1)}
                              >
                                +
                              </button>
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Stack>
              ))}
            </Stack>
          )}
        </Card>
      </SplitPane>
    </Stack>
  );
}
