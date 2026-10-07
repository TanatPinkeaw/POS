'use client';

import { useCallback, useMemo, useState } from 'react';

import {
  Button,
  Card,
  CategoryChip,
  EmptyState,
  InlineNotice,
  LinkButton,
  Money,
  Pill,
  SearchField,
  SplitPane,
  Stack,
  Thumb,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { basketSummary } from '@/lib/basket';
import { categoryColorKey } from '@/lib/palette';
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

  /*
   * One decision with two readers: the basket card below, and the bar that follows
   * the customer down the catalogue. Both render from this object, so the pieces the
   * bar counts and the money it names are the same ones the card lists — a second
   * copy of `price × quantity` beside this one is how a customer reads two totals
   * for one basket (`src/lib/basket.ts` is where that arithmetic lives, and why).
   */
  const basket = basketSummary(quantities, products);

  function setQuantity(productId: string, quantity: number): void {
    setQuantities((current) => ({ ...current, [productId]: Math.max(0, quantity) }));
  }

  const place = async (): Promise<void> => {
    if (basket.lines.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const result = await apiPost<Placed>('/api/v1/orders', {
        type: 'preorder',
        lines: basket.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
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
                      {/*
                       * The photo takes the tile's whole width and the name sits under it —
                       * the till's tile, because this is the same sale seen from the other
                       * side of it. At 48px tucked beside the name the picture told the
                       * customer nothing and left the tile's middle empty; at the tile's own
                       * width it is what makes one product recognisable from the next
                       * without reading Thai names down a list (ADR 0014).
                       */}
                      {/*
                       * A product with no link gets its initial on the aisle colour,
                       * not a grey box: after the tile became a photo, the pictureless
                       * ones are the grid's common case, and a customer picking by
                       * colour still needs one tile to differ from the next.
                       */}
                      <Thumb url={product.imageUrl} size="fill" categoryKey={categoryColorKey(product.categoryId)} name={product.name} />

                      <span className={styles.name}>{product.name}</span>

                      {/* The till's price weight: between two tiles this figure is what is
                       * actually being compared. */}
                      <Money amount={product.salePrice} size="lg" />

                      {/*
                       * The chip is wrapped rather than a direct child: the column stretches
                       * its children to the tile's width, and a chip stretched that far is a
                       * full-width bar wearing a chip's radius. This is the row that has to
                       * stay a chip, because it is where the shop says "หมด".
                       */}
                      <div className={styles.stock}>
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
                      </div>

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
          panelId="basket"
          panel={
            <Card title="รายการจอง">
              <Stack gap="md">
                {basket.lines.length === 0 ? (
                  <p className="ln-muted">ยังไม่ได้เลือกสินค้า</p>
                ) : (
                  <>
                    <ul className={styles.lines}>
                      {basket.lines.map((line) => (
                        <li key={line.productId} className={styles.line}>
                          <span className="ln-break">
                            {line.name} × {line.quantity}
                          </span>
                          <Money amount={line.amountThb} />
                        </li>
                      ))}
                    </ul>
                    <div className={styles.total}>
                      <span>รวม</span>
                      <Money amount={basket.totalThb} size="lg" />
                    </div>
                  </>
                )}

                <Button
                  size="lg"
                  block
                  icon="cart"
                  loading={busy}
                  disabled={basket.lines.length === 0}
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

      {/*
       * The way to the basket on a phone.
       *
       * Below `SplitPane`'s breakpoint the two panes become one column and the
       * basket — the only control that actually places the order — lands *after* every
       * product, so a shop with thirty items puts its own checkout thirty screens of
       * scrolling away from the first tile. This is that distance in one tap, and it is
       * also the only place a customer can see what they have spent while they keep
       * shopping: the till gives an operator a bill beside the grid, and this is that
       * same promise for a phone.
       *
       * Only when there is something to jump to. A shop that takes no pre-orders has no
       * basket at all (ADR 0028), and a bar pointing at a pane that is not on the page
       * would be a control that scrolls nowhere.
       *
       * It carries no `aria-live`: the stepper's own count is already announced, and two
       * polite regions counting the same pieces would say every number twice.
       */}
      {acceptsPreorders && basket.units > 0 ? (
        <div className={styles.bar}>
          <span className={styles.barReadout}>
            <span className={styles.barCount}>{basket.units} ชิ้น</span>
            <Money amount={basket.totalThb} />
          </span>
          <LinkButton href="#basket" icon="cart" size="lg">
            ดูรายการจอง
          </LinkButton>
        </div>
      ) : null}
    </Stack>
  );
}
