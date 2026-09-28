'use client';

import { useMemo } from 'react';

import { Button, SearchField, Spinner, Tabs } from '@/components/ds';
import { formatThb } from '@/lib/money';

import type { Till } from './useTill';
import styles from './Till.module.css';

export interface CatalogueCategory {
  id: number;
  name: string;
  productCount: number;
}

/**
 * The catalogue: everything on the right of the till.
 *
 * Three decisions here that the reference design's field notes argue for directly.
 *
 * **The scan field never leaves focus.** Their operators work at speed with a
 * barcode scanner, and a scan field that has lost focus is a scanner that silently
 * does nothing — the loudest possible failure, because the operator does not find
 * out until a customer is waiting. So the field is refocused after every sale,
 * every tile tap, and every search.
 *
 * **The category rail is colour-coded.** A shop with twenty aisles gives a chip and
 * a hue to each, derived from the category rather than typed in, so a glance at the
 * band is enough to know which aisle is open.
 *
 * **The grid says how many are hidden.** "ยังมีอีก N รายการ" is the sentence that
 * turns paging from a defect into a feature: without it, the end of a page reads as
 * the end of the catalogue, which is exactly how a shop with 201 products used to
 * lose the 201st.
 */
export function TillCatalog({
  till,
  categories,
  disabled,
}: {
  till: Till;
  categories: CatalogueCategory[];
  /** True while the drawer is closed — nothing can be sold yet. */
  disabled: boolean;
}) {
  const categoryTabs = useMemo(
    () => [
      { key: 'all', label: 'ทั้งหมด', badge: till.total },
      ...categories.map((category) => ({
        key: String(category.id),
        label: category.name,
        badge: category.productCount,
      })),
    ],
    [categories, till.total],
  );

  const hidden = Math.max(0, till.total - till.products.length);

  return (
    <section className={styles.pane} aria-label="แคตตาล็อกสินค้า">
      <div className={styles.catalogControls}>
        <SearchField
          id="scan"
          label="สแกนบาร์โค้ด หรือค้นหาสินค้า"
          placeholder="ยิงบาร์โค้ดแล้วกด Enter หรือพิมพ์ชื่อสินค้า"
          value={till.search}
          onChange={till.setSearch}
          onSubmit={() => void till.scan(till.search)}
          inputRef={till.scanInput}
          mono
          autoFocus
        />
        <p className={styles.scanHint}>
          สแกนบาร์โค้ดได้เลย · สต็อกอัปเดตทุกหน้าจอทันที
        </p>
      </div>

      <div style={{ padding: 'var(--ln-space-2) var(--ln-space-3)' }}>
        <Tabs
          label="หมวดหมู่สินค้า"
          variant="segmented"
          scroll
          items={categoryTabs}
          value={till.categoryId ? String(till.categoryId) : 'all'}
          onChange={(key) => till.setCategoryId(key === 'all' ? null : Number(key))}
        />
      </div>

      <div className={styles.paneBody}>
        {till.products.length === 0 ? (
          <div className={styles.empty}>
            {till.loadingCatalogue ? <Spinner /> : null}
            <p>{till.search ? 'ไม่พบสินค้าที่ตรงกับคำค้นหา' : 'ยังไม่มีสินค้าในหมวดนี้'}</p>
          </div>
        ) : (
          <div className={styles.grid}>
            {till.products.map((product) => {
              const out = product.availableQty <= 0;
              const low = !out && product.availableQty <= 3;
              return (
                <button
                  key={product.id}
                  type="button"
                  className={styles.tile}
                  data-cat={product.categoryKey}
                  disabled={out || disabled}
                  onClick={() => till.addProduct(product)}
                  title={`${product.name} · ${product.categoryName ?? 'ไม่ระบุหมวดหมู่'}`}
                >
                  <span className={styles.tileName}>{product.name}</span>
                  <span className={styles.tileFoot}>
                    <span className={styles.tilePrice}>{formatThb(product.salePrice)}</span>
                    {/*
                     * The count is a word as well as a colour: "หมด" and "เหลือ 2"
                     * carry the meaning for anyone who cannot separate the red from
                     * the green, and on a washed-out counter screen in daylight.
                     */}
                    <span
                      className={`${styles.tileStock} ${out ? styles.stockOut : low ? styles.stockLow : styles.stockOk}`}
                    >
                      {out ? 'หมด' : `เหลือ ${product.availableQty}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.catalogFooter}>
        <span>
          แสดง {till.products.length.toLocaleString('en-US')} จาก{' '}
          {till.total.toLocaleString('en-US')} รายการ
          {hidden > 0 ? ` · ยังมีอีก ${hidden.toLocaleString('en-US')} รายการ` : ''}
        </span>
        {till.hasMore ? (
          <Button
            variant="secondary"
            size="sm"
            loading={till.loadingCatalogue}
            onClick={() => void till.loadMore()}
          >
            โหลดเพิ่ม
          </Button>
        ) : null}
      </div>
    </section>
  );
}
