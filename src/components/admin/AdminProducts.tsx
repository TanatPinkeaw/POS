'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Button,
  Card,
  DataTable,
  EmptyState,
  FieldRow,
  InlineNotice,
  Money,
  Overlay,
  Pill,
  SearchField,
  SelectField,
  Stack,
  TextField,
  Thumb,
  type Column,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPatch, apiPost } from '@/lib/client-api';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

export interface AdminProduct {
  id: string;
  name: string;
  barcode: string | null;
  categoryId: number | null;
  categoryName: string | null;
  costPrice: number;
  salePrice: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  /** A link to the picture, wherever the shop keeps it — not a file we hold. */
  imageUrl: string | null;
  isActive: boolean;
}

interface Category {
  id: number;
  name: string;
}

const REASONS = [
  { value: 'REASON_RESTOCK', label: 'รับสินค้าเข้า' },
  { value: 'REASON_DAMAGED', label: 'ชำรุด' },
  { value: 'REASON_EXPIRED', label: 'หมดอายุ' },
  { value: 'REASON_CORRECTION', label: 'ปรับปรุงยอด' },
] as const;

const EMPTY_PRODUCT = {
  name: '',
  barcode: '',
  categoryId: '',
  costPrice: '',
  salePrice: '',
  stockQty: '',
  imageUrl: '',
};

/**
 * Catalogue and stock administration — SRS §4.3.
 *
 * Adjustments are signed (negative for damage, positive for a delivery) and the
 * reason is mandatory, because the audit trail is only useful if every row can
 * answer "who changed this, by how much, and why".
 *
 * The adjustment is a dialog rather than the inline form it used to be. An inline
 * form inside a table cell is the worst of both worlds: it makes the row taller than
 * the table can reflow, it has nowhere to put an error message, and on a narrow
 * screen — where `DataTable` has already turned the row into a card — it lands in
 * the middle of the card's fields. In a dialog the three inputs have room, Escape
 * closes it, and the reason selector cannot be missed.
 *
 * The photo is a **link**, in a dialog of its own, and the wording says so. Nothing
 * here stores a file: a shop pastes the https link of a picture that already lives
 * somewhere it backs up — its own Nextcloud, its hosting, its drive — and this screen
 * keeps the link, previews it, and shows the same picture on the till and the
 * storefront (ADR 0014). That is why the field is editable after the fact rather than
 * only at creation: a catalogue of two hundred products gets its pictures entered
 * long after the products themselves.
 */
export function AdminProducts({
  initialProducts,
  categories,
}: {
  initialProducts: AdminProduct[];
  categories: Category[];
}) {
  const [products, setProducts] = useState(initialProducts);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [adjusting, setAdjusting] = useState<AdminProduct | null>(null);
  const [saving, setSaving] = useState(false);
  const [adjustment, setAdjustment] = useState({ delta: '', reason: 'REASON_RESTOCK', note: '' });
  const [newProduct, setNewProduct] = useState(EMPTY_PRODUCT);
  const [editingImage, setEditingImage] = useState<AdminProduct | null>(null);
  const [imageDraft, setImageDraft] = useState('');

  /*
   * Server props win on every re-render of the page.
   *
   * Local state exists because this table also changes without a navigation — a
   * realtime stock event, or a write it made itself. But `router.refresh()`, which
   * the import panel calls once a file is committed, produces *new props*, and a
   * `useState` initialiser only reads them on mount. Without this line the table
   * kept rendering the list from the first render, so importing a catalogue of 300
   * products looked like nothing had happened. The refreshed props are the result
   * of the write that just finished, so taking them cannot lose anything.
   */
  useEffect(() => {
    setProducts(initialProducts);
  }, [initialProducts]);

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

  const reload = useCallback(async () => {
    const fresh = await apiFetch<AdminProduct[]>('/api/v1/products?includeInactive=true');
    setProducts(fresh);
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) {
      return products;
    }
    return products.filter(
      (product) =>
        product.name.toLowerCase().includes(term) || (product.barcode ?? '').includes(term),
    );
  }, [products, search]);

  async function submitAdjustment(): Promise<void> {
    if (!adjusting) {
      return;
    }
    const delta = Number(adjustment.delta);
    if (!Number.isInteger(delta) || delta === 0) {
      setError('จำนวนที่ปรับต้องเป็นจำนวนเต็มและไม่เป็นศูนย์');
      return;
    }

    setError(null);
    setSaving(true);
    try {
      await apiPost('/api/v1/inventory/adjust', {
        productId: adjusting.id,
        delta,
        reason: adjustment.reason,
        note: adjustment.note || null,
      });
      setNotice(`บันทึกการปรับสต็อกของ "${adjusting.name}" แล้ว (มีบันทึกใน stock_logs)`);
      setAdjusting(null);
      setAdjustment({ delta: '', reason: 'REASON_RESTOCK', note: '' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ปรับสต็อกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  async function createProduct(): Promise<void> {
    setError(null);
    try {
      await apiPost('/api/v1/products', {
        name: newProduct.name,
        barcode: newProduct.barcode || null,
        categoryId: newProduct.categoryId ? Number(newProduct.categoryId) : null,
        costPrice: Number(newProduct.costPrice || 0),
        salePrice: Number(newProduct.salePrice || 0),
        stockQty: Number(newProduct.stockQty || 0),
        imageUrl: newProduct.imageUrl.trim() || null,
      });
      setNotice(`เพิ่มสินค้า "${newProduct.name}" แล้ว`);
      setNewProduct(EMPTY_PRODUCT);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'เพิ่มสินค้าไม่สำเร็จ');
    }
  }

  /**
   * The one write this screen makes to a single field, and it is `PATCH` on purpose:
   * an empty box clears the picture rather than being refused, because "remove the
   * photo" is a thing a shop asks for and a form that cannot express it sends
   * somebody to the database.
   */
  async function saveImage(): Promise<void> {
    if (!editingImage) {
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiPatch(`/api/v1/products/${editingImage.id}`, {
        imageUrl: imageDraft.trim() || null,
      });
      setNotice(
        imageDraft.trim()
          ? `บันทึกลิงก์รูปของ \"${editingImage.name}\" แล้ว`
          : `เอารูปของ \"${editingImage.name}\" ออกแล้ว`,
      );
      setEditingImage(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'บันทึกรูปไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(product: AdminProduct): Promise<void> {
    setError(null);
    try {
      await apiPatch(`/api/v1/products/${product.id}`, { isActive: !product.isActive });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'อัปเดตสินค้าไม่สำเร็จ');
    }
  }

  const columns: Column<AdminProduct>[] = [
    {
      key: 'name',
      header: 'สินค้า',
      cardLabel: 'สินค้า',
      render: (product) => (
        /*
         * The photo is inside the name cell rather than a column of its own: a
         * table column per picture would give every row the height of the largest
         * one, and the picture is a recognition aid for the name beside it, not a
         * fact to compare down a column.
         */
        <span className="ln-row">
          <Thumb url={product.imageUrl} size="sm" />
          <span className="ln-break">
            {product.name}
            {product.barcode ? (
              <span className="ln-mono ln-muted"> {product.barcode}</span>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      key: 'category',
      header: 'หมวดหมู่',
      render: (product) => product.categoryName ?? '—',
    },
    {
      key: 'cost',
      header: 'ทุน',
      align: 'end',
      render: (product) => <Money amount={product.costPrice} />,
    },
    {
      key: 'price',
      header: 'ราคา',
      align: 'end',
      render: (product) => <Money amount={product.salePrice} />,
    },
    {
      key: 'stock',
      header: 'คงเหลือ',
      align: 'end',
      render: (product) => <span className="ln-num">{product.stockQty}</span>,
    },
    {
      key: 'reserved',
      header: 'จองไว้',
      align: 'end',
      render: (product) => <span className="ln-num">{product.reservedQty}</span>,
    },
    {
      key: 'available',
      header: 'ขายได้',
      align: 'end',
      render: (product) => (
        <Pill
          tone={
            product.availableQty <= 0 ? 'danger' : product.availableQty <= 5 ? 'warning' : 'success'
          }
        >
          {product.availableQty}
        </Pill>
      ),
    },
    {
      key: 'active',
      header: 'สถานะ',
      render: (product) => (
        <Pill tone={product.isActive ? 'success' : 'neutral'}>
          {product.isActive ? 'ใช้งาน' : 'ปิด'}
        </Pill>
      ),
    },
    {
      key: 'actions',
      header: '',
      cardLabel: 'จัดการ',
      align: 'end',
      render: (product) => (
        <span className="ln-row">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              setAdjustment({ delta: '', reason: 'REASON_RESTOCK', note: '' });
              setAdjusting(product);
            }}
          >
            ปรับสต็อก
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              setImageDraft(product.imageUrl ?? '');
              setEditingImage(product);
            }}
          >
            รูปสินค้า
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void toggleActive(product)}>
            {product.isActive ? 'ปิด' : 'เปิด'}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Stack gap="lg">
      {notice ? <InlineNotice tone="success">{notice}</InlineNotice> : null}
      {error && !adjusting && !editingImage ? (
        <InlineNotice tone="danger">{error}</InlineNotice>
      ) : null}

      <Card title="เพิ่มสินค้าใหม่" subtitle="กรอกเท่าที่มี ที่เหลือแก้ทีหลังได้">
        <Stack gap="md">
          <FieldRow columns={3}>
            <TextField
              id="np-name"
              label="ชื่อสินค้า"
              value={newProduct.name}
              onChange={(event) => setNewProduct({ ...newProduct, name: event.target.value })}
            />
            <TextField
              id="np-barcode"
              label="บาร์โค้ด"
              className="ln-mono"
              value={newProduct.barcode}
              onChange={(event) => setNewProduct({ ...newProduct, barcode: event.target.value })}
            />
            <SelectField
              id="np-category"
              label="หมวดหมู่"
              value={newProduct.categoryId}
              onChange={(event) => setNewProduct({ ...newProduct, categoryId: event.target.value })}
            >
              <option value="">— ไม่ระบุ —</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </SelectField>
          </FieldRow>

          <FieldRow columns={3}>
            <TextField
              id="np-cost"
              label="ราคาทุน"
              inputMode="decimal"
              className="ln-num"
              value={newProduct.costPrice}
              onChange={(event) => setNewProduct({ ...newProduct, costPrice: event.target.value })}
            />
            <TextField
              id="np-price"
              label="ราคาขาย"
              inputMode="decimal"
              className="ln-num"
              value={newProduct.salePrice}
              onChange={(event) => setNewProduct({ ...newProduct, salePrice: event.target.value })}
            />
            <TextField
              id="np-stock"
              label="สต็อกเริ่มต้น"
              inputMode="numeric"
              className="ln-num"
              value={newProduct.stockQty}
              onChange={(event) => setNewProduct({ ...newProduct, stockQty: event.target.value })}
            />
          </FieldRow>

          <FieldRow columns={2}>
            <TextField
              id="np-image"
              label="ลิงก์รูปสินค้า"
              help="วางลิงก์ https ของรูป (เช่นจาก Nextcloud ของร้าน) — ระบบเก็บลิงก์ ไม่ได้เก็บไฟล์"
              value={newProduct.imageUrl}
              onChange={(event) => setNewProduct({ ...newProduct, imageUrl: event.target.value })}
            />
          </FieldRow>

          <div>
            <Button
              disabled={!newProduct.name || !newProduct.salePrice}
              onClick={() => void createProduct()}
            >
              เพิ่มสินค้า
            </Button>
          </div>
        </Stack>
      </Card>

      <Card
        title={`รายการสินค้า (${filtered.length})`}
        subtitle="การปรับสต็อกทุกครั้งต้องระบุเหตุผล และถูกบันทึกไว้ตรวจสอบย้อนหลังได้"
        toolbar={
          <SearchField
            id="product-search"
            label="ค้นหาสินค้า"
            placeholder="ค้นหาชื่อหรือบาร์โค้ด"
            value={search}
            onChange={setSearch}
          />
        }
        flush
      >
        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(product) => product.id}
          caption="รายการสินค้าทั้งหมดในร้าน"
          empty={
            <EmptyState
              icon="box"
              title={search ? 'ไม่พบสินค้าที่ค้นหา' : 'ยังไม่มีสินค้า'}
              description={
                search ? 'ลองคำอื่น หรือล้างคำค้นหา' : 'เพิ่มสินค้าทีละรายการ หรือนำเข้าจากไฟล์ด้านล่าง'
              }
            />
          }
        />
      </Card>

      <Overlay
        open={adjusting !== null}
        onClose={() => setAdjusting(null)}
        title={adjusting ? `ปรับสต็อก · ${adjusting.name}` : ''}
        description={
          adjusting ? `คงเหลือ ${adjusting.stockQty} · จองไว้ ${adjusting.reservedQty}` : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdjusting(null)} disabled={saving}>
              ยกเลิก
            </Button>
            <Button loading={saving} onClick={() => void submitAdjustment()}>
              บันทึก
            </Button>
          </>
        }
      >
        <Stack gap="md">
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <FieldRow columns={2}>
            <TextField
              id="adjust-delta"
              label="จำนวนที่ปรับ"
              help="ใส่ค่าลบเมื่อของเสียหายหรือหายไป"
              inputMode="numeric"
              className="ln-num"
              value={adjustment.delta}
              onChange={(event) => setAdjustment({ ...adjustment, delta: event.target.value })}
            />
            <SelectField
              id="adjust-reason"
              label="เหตุผล"
              value={adjustment.reason}
              onChange={(event) => setAdjustment({ ...adjustment, reason: event.target.value })}
            >
              {REASONS.map((reason) => (
                <option key={reason.value} value={reason.value}>
                  {reason.label}
                </option>
              ))}
            </SelectField>
          </FieldRow>
          <TextField
            id="adjust-note"
            label="หมายเหตุ"
            value={adjustment.note}
            onChange={(event) => setAdjustment({ ...adjustment, note: event.target.value })}
          />
        </Stack>
      </Overlay>

      <Overlay
        open={editingImage !== null}
        onClose={() => setEditingImage(null)}
        title={editingImage ? `รูปสินค้า · ${editingImage.name}` : ''}
        description="วางลิงก์ https ของรูป — ระบบเก็บลิงก์ไว้ ไม่ได้เก็บไฟล์รูป"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditingImage(null)} disabled={saving}>
              ยกเลิก
            </Button>
            <Button loading={saving} onClick={() => void saveImage()}>
              บันทึก
            </Button>
          </>
        }
      >
        <Stack gap="md">
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <TextField
            id="edit-image"
            label="ลิงก์รูปสินค้า"
            help="เว้นว่างเพื่อเอารูปออก"
            placeholder="https://drive.example.com/s/xxxx/preview"
            value={imageDraft}
            onChange={(event) => setImageDraft(event.target.value)}
          />
          {/*
           * The preview is the whole point of the dialog: a link that returns a login
           * page, a link to a folder rather than a file, and a link that is simply
           * wrong all look the same as a good one until something tries to draw it.
           */}
          <Thumb url={imageDraft} size="lg" />
        </Stack>
      </Overlay>
    </Stack>
  );
}
