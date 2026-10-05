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
  Thumb,
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
  imageUrl: string | null;
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
 *
 * The photo is the same one the counter sees, from the same link (ADR 0014): a
 * customer choosing from a picture and a cashier scanning a barcode are looking at
 * the same goods, and the shop should not have to describe them twice.
 */
export function ShopCatalog({
  initialProducts,
  confirmMinutes,
  acceptsPreorders,
}: {
  initialProducts: ShopProduct[];
  /**
   * Whether this shop takes pre-orders at all (ADR 0028).
   *
   * Passed in from the server rather than fetched here: the page already reads the
   * shop row, and a client that asked twice could be answered twice — once on the
   * way in and once on the way out — which is exactly how a member ends up pressing
   * a button the shop has already closed. The server refuses the order either way;
   * this only decides what is offered.
   */
  acceptsPreorders: boolean;
  /**
   * How long the shop has to confirm, in minutes — passed in from the server.
   *
   * This confirmation line used to say "15 นาที" in Thai copy while the deadline it
   * was describing was computed from the shop's setting. It is a promise made to a
   * customer at the moment they press จอง, so it has to be the same number the
   * sweeper will act on, and the client is the wrong place to know it.
   */
  confirmMinutes: number;
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

  /*
   * The catalogue is built once and then placed either inside the split pane or
   * on its own. A shop that takes no pre-orders shows a catalogue, not a basket
   * with nothing to put in it: the pane, the steppers and the button that places
   * the order all feed each other, so removing the button alone would leave a
   * member tapping a quantity counter that goes nowhere (ADR 0028).
   */
  const catalogue = (
    <Card
      title={acceptsPreorders ? 'เลือกสินค้า' : 'สินค้าในร้าน'}
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
          title={
            filter
              ? 'ไม่พบสินค้าที่ค้นหา'
              : acceptsPreorders
                ? 'ยังไม่มีสินค้าให้จอง'
                : 'ยังไม่มีสินค้าให้เลือก'
          }
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
                        <Thumb url={product.imageUrl} size="md" />
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

                        {acceptsPreorders ? (
                          /*
                           * The plus/minus pair is not decoration: it is the only way a
                           * quantity gets into the basket on the right. Without the basket
                           * there is nothing for it to do, and two buttons that do nothing
                           * read as a broken page rather than as a shop that takes no
                           * pre-orders.
                           */
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
                        ) : null}
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
  );

  return (
    <Stack gap="md">
      {placed ? (
        <InlineNotice tone="success" title="จองสำเร็จ!">
          เลขที่ออเดอร์ <strong className="ln-mono">{placed.orderNumber}</strong> —{' '}
          ร้านจะยืนยันภายใน {confirmMinutes} นาที มิฉะนั้นออเดอร์จะถูกยกเลิกและคืนสต็อกอัตโนมัติ
        </InlineNotice>
      ) : null}

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {acceptsPreorders ? null : (
        /*
         * Said out loud rather than leaving a page of prices with no way to act
         * on them. The sentence is the one the server refuses with, so a member
         * who had this page open before the shop closed pre-orders reads the same
         * answer in both places instead of two different ones.
         */
        <InlineNotice tone="info">
          ร้านนี้ยังไม่เปิดรับพรีออเดอร์ — สินค้าในหน้านี้ขายที่หน้าร้านเท่านั้น
        </InlineNotice>
      )}

      {acceptsPreorders ? (
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
          {catalogue}
        </SplitPane>
      ) : (
        catalogue
      )}
    </Stack>
  );
}
