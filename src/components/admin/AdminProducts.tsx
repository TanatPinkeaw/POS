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
  TextAreaField,
  TextField,
  Thumb,
  type Column,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPatch, apiPost } from '@/lib/client-api';
import { probeImageUrl } from '@/lib/image-url';
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
  /** How much of this product the till may not sell offline (ADR 0019). */
  offlineSafetyQty: number;
  /**
   * Free text kept with the product. Nothing on screen forces a shop to write
   * one, so it is the first field to be blank and the last one anybody reads.
   */
  description: string | null;
  /** A link to the picture, wherever the shop keeps it — not a file we hold. */
  imageUrl: string | null;
  isActive: boolean;
  /** The member whose goods these are, or null for the shop's own stock (ADR 0023). */
  consignorUserId: string | null;
  consignorName: string | null;
  /** The agreed share of the net, 0–100. Null whenever `consignorUserId` is. */
  consignorSharePercent: number | null;
}

/** One row of the member search behind the consignment dialog. */
interface ConsignorCandidate {
  id: string;
  fullName: string;
  phone: string;
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
  offlineSafetyQty: '',
  imageUrl: '',
  description: '',
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
 *
 * The same argument is why the offline reserve has a dialog of its own: it is set on a
 * handful of products rather than on all of them, and it is the kind of number a shop
 * arrives at after an outage rather than when it enters a catalogue. `กันสำรองออฟไลน์`
 * is deliberately not part of the stock adjustment — a reserve is a promise about what
 * the till *will not* sell, not a movement of goods, and putting it behind the same
 * button would write it into `stock_logs` as though the shelf had changed (ADR 0019).
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
  const [editing, setEditing] = useState<AdminProduct | null>(null);
  const [editDraft, setEditDraft] = useState(EMPTY_PRODUCT);
  const [editingImage, setEditingImage] = useState<AdminProduct | null>(null);
  const [imageDraft, setImageDraft] = useState('');
  /** True while the browser is trying the link, so the save button can say so. */
  const [imageChecking, setImageChecking] = useState(false);
  /** Why the link will not load, in Thai, shown on the field itself. */
  const [imageError, setImageError] = useState<string | null>(null);
  const [editingReserve, setEditingReserve] = useState<AdminProduct | null>(null);
  const [reserveDraft, setReserveDraft] = useState('');
  const [consigning, setConsigning] = useState<AdminProduct | null>(null);
  const [consignorQuery, setConsignorQuery] = useState('');
  const [consignorResults, setConsignorResults] = useState<ConsignorCandidate[]>([]);
  const [consignorId, setConsignorId] = useState('');
  const [shareDraft, setShareDraft] = useState('');

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

  /*
   * The consignment dialog finds its member by name or number, through the same till
   * lookup a cashier uses — there is one member list and one search over it. Debounced
   * like that search, so a typed name is one request rather than one per keystroke.
   */
  useEffect(() => {
    if (consigning === null) {
      return;
    }
    const term = consignorQuery.trim();
    if (term === '') {
      setConsignorResults([]);
      return;
    }
    const handle = setTimeout(() => {
      void apiFetch<ConsignorCandidate[]>(`/api/v1/members?search=${encodeURIComponent(term)}`)
        .then((found) => {
          setConsignorResults(found);
        })
        .catch(() => {
          setConsignorResults([]);
        });
    }, 250);
    return () => clearTimeout(handle);
  }, [consigning, consignorQuery]);

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

  /**
   * Opening the editor copies the row into a draft rather than editing the table in
   * place. Three reasons, and the last one is the important one.
   *
   * A catalogue is a list of hundreds of rows; a half-typed rename has no business
   * sitting in it while it is being typed. Escape and Backspace both throw the
   * draft away, which an inline edit cannot offer. And the save is a `PATCH` that
   * sends **only the fields this dialog shows**, so a field it does not own — the
   * picture, the offline reserve, the consignment terms — cannot be cleared by a
   * form that never showed it.
   *
   * Stock is the field it deliberately does not own either. Stock changes only
   * through the signed adjustment, so that every movement of goods carries a
   * reason and a `stock_logs` row; a price form that could write `stock_qty` would
   * be a way to change the shelf without saying why.
   */
  function openEdit(product: AdminProduct): void {
    setError(null);
    setEditDraft({
      name: product.name,
      barcode: product.barcode ?? '',
      categoryId: product.categoryId === null ? '' : String(product.categoryId),
      costPrice: String(product.costPrice),
      salePrice: String(product.salePrice),
      stockQty: '',
      offlineSafetyQty: '',
      imageUrl: '',
      description: product.description ?? '',
    });
    setEditing(product);
  }

  /** Validated here as well as by the schema, so a typo reads as a Thai field error. */
  async function saveProduct(): Promise<void> {
    if (!editing) {
      return;
    }
    const name = editDraft.name.trim();
    if (name === '') {
      setError('ชื่อสินค้าต้องไม่ว่าง');
      return;
    }
    const costPrice = Number(editDraft.costPrice === '' ? 0 : editDraft.costPrice);
    const salePrice = Number(editDraft.salePrice === '' ? 0 : editDraft.salePrice);
    if (!Number.isFinite(costPrice) || costPrice < 0) {
      setError('ราคาทุนต้องเป็นตัวเลขที่ไม่ติดลบ');
      return;
    }
    if (!Number.isFinite(salePrice) || salePrice < 0) {
      setError('ราคาขายต้องเป็นตัวเลขที่ไม่ติดลบ');
      return;
    }
    const barcode = editDraft.barcode.trim();

    setError(null);
    setSaving(true);
    try {
      await apiPatch(`/api/v1/products/${editing.id}`, {
        name,
        categoryId: editDraft.categoryId ? Number(editDraft.categoryId) : null,
        barcode: barcode === '' ? null : barcode,
        costPrice,
        salePrice,
        description: editDraft.description.trim() === '' ? null : editDraft.description.trim(),
      });
      setNotice(`บันทึกการแก้ไข "${name}" แล้ว`);
      setEditing(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'บันทึกการแก้ไขไม่สำเร็จ');
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
        offlineSafetyQty: Number(newProduct.offlineSafetyQty || 0),
        description: newProduct.description.trim() || null,
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

    /*
     * Try the link before saving it, and refuse to save a broken one.
     *
     * Every way this went wrong before looked the same from the back office: the
     * save succeeded, the row said `image_url`, and the tiles showed a grey glyph
     * forever. A link to a Nextcloud share that returns a login page, a link to a
     * folder, a link copied out of a browser address bar with the session's query
     * stripped off, and a plain 404 are indistinguishable in the database and
     * indistinguishable on the till.
     *
     * Empty is not a failure — clearing the picture is a thing a shop asks for, and
     * an empty string has nothing to probe.
     */
    const candidate = imageDraft.trim();
    if (candidate !== '') {
      setImageChecking(true);
      const probe = await probeImageUrl(candidate);
      setImageChecking(false);
      if (!probe.ok) {
        setImageError(probe.message ?? 'เปิดลิงก์รูปนี้ไม่ได้');
        return;
      }
      setImageError(null);
    } else {
      setImageError(null);
    }

    setSaving(true);
    try {
      await apiPatch(`/api/v1/products/${editingImage.id}`, {
        imageUrl: candidate || null,
      });
      setNotice(
        candidate
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

  /**
   * Writes only the reserve, like the picture dialog writes only the picture.
   *
   * `PATCH` rather than the adjustment endpoint, and that is the load-bearing part: a
   * reserve is not a movement of stock, so it must not leave a `stock_logs` row that
   * says the shelf changed by a number it never changed by.
   */
  async function saveReserve(): Promise<void> {
    if (!editingReserve) {
      return;
    }
    const value = Number(reserveDraft === '' ? 0 : reserveDraft);
    if (!Number.isInteger(value) || value < 0) {
      setError('จำนวนกันสำรองต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiPatch(`/api/v1/products/${editingReserve.id}`, { offlineSafetyQty: value });
      setNotice(
        value > 0
          ? `ตั้งกันสำรองออฟไลน์ของ \"${editingReserve.name}\" เป็น ${value} ชิ้นแล้ว`
          : `เอาที่กันสำรองออฟไลน์ของ \"${editingReserve.name}\" ออกแล้ว`,
      );
      setEditingReserve(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'บันทึกกันสำรองไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Opens the consignment dialog, seeded with whatever the product already is.
   *
   * Seeding rather than blanking matters for the percent: an admin re-agreeing the
   * share of an existing arrangement should see the current number to change it, not
   * retype it from memory.
   */
  function openConsignment(product: AdminProduct): void {
    setError(null);
    setConsignorQuery(product.consignorName ?? '');
    setConsignorResults([]);
    setConsignorId(product.consignorUserId ?? '');
    setShareDraft(
      product.consignorSharePercent !== null ? String(product.consignorSharePercent) : '',
    );
    setConsigning(product);
  }

  async function saveConsignment(): Promise<void> {
    if (!consigning) {
      return;
    }
    if (!consignorId) {
      setError('เลือกสมาชิกผู้ฝากขายก่อน');
      return;
    }
    const share = Number(shareDraft);
    if (!Number.isInteger(share) || share < 0 || share > 100) {
      setError('ส่วนแบ่งต้องเป็นจำนวนเต็ม 0–100');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiPatch(`/api/v1/products/${consigning.id}/consignment`, {
        consignorUserId: consignorId,
        sharePercent: share,
      });
      setNotice(`ตั้งฝากขายของ "${consigning.name}" แล้ว (แบ่ง ${share}%)`);
      setConsigning(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'บันทึกการฝากขายไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  async function withdrawGoods(): Promise<void> {
    if (!consigning) {
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiPost(`/api/v1/products/${consigning.id}/consignment`, { note: null });
      setNotice(`ถอนสินค้าฝากขาย "${consigning.name}" แล้ว (มีบันทึกใน stock_logs)`);
      setConsigning(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ถอนสินค้าฝากขายไม่สำเร็จ');
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
      key: 'offlineReserve',
      header: 'กันออฟไลน์',
      align: 'end',
      /* A zero is shown as a dash because it is the default: a table of 200 zeroes hides
       * the three products the shop actually reserved. */
      render: (product) =>
        product.offlineSafetyQty > 0 ? (
          <span className="ln-num">{product.offlineSafetyQty}</span>
        ) : (
          <span className="ln-muted">—</span>
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
      key: 'consignment',
      header: 'ฝากขาย',
      /* A dash for the ordinary product: a shop with two hundred of its own items
       * and three consigned ones should see the three, not a column of blanks. */
      render: (product) =>
        product.consignorUserId ? (
          <span className="ln-break">
            {product.consignorName ?? 'สมาชิก'}
            <span className="ln-muted ln-num"> {product.consignorSharePercent}%</span>
          </span>
        ) : (
          <span className="ln-muted">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      cardLabel: 'จัดการ',
      align: 'end',
      render: (product) => (
        <span className="ln-row">
          <Button variant="secondary" size="sm" icon="edit" onClick={() => openEdit(product)}>
            แก้ไข
          </Button>
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
              setImageError(null);
              setEditingImage(product);
            }}
          >
            รูปสินค้า
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              setReserveDraft(product.offlineSafetyQty > 0 ? String(product.offlineSafetyQty) : '');
              setEditingReserve(product);
            }}
          >
            กันออฟไลน์
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              openConsignment(product);
            }}
          >
            ฝากขาย
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
      {error && !adjusting && !editing && !editingImage && !editingReserve && !consigning ? (
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

          <TextAreaField
            id="np-description"
            label="คำอธิบายสินค้า"
            help="เก็บไว้กับสินค้า ถ้าไม่มีให้เว้นว่าง"
            rows={2}
            maxLength={1000}
            value={newProduct.description}
            onChange={(event) => setNewProduct({ ...newProduct, description: event.target.value })}
          />

          <FieldRow columns={2}>
            <TextField
              id="np-image"
              label="ลิงก์รูปสินค้า"
              help="วางลิงก์ https ของรูป (เช่นจาก Nextcloud ของร้าน) — ระบบเก็บลิงก์ ไม่ได้เก็บไฟล์"
              value={newProduct.imageUrl}
              onChange={(event) => setNewProduct({ ...newProduct, imageUrl: event.target.value })}
            />
            <TextField
              id="np-offline-safety"
              label="กันสำรองออฟไลน์"
              help="จำนวนที่ห้ามขายตอนเน็ตหลุด (เว้นว่าง = ไม่กัน)"
              inputMode="numeric"
              className="ln-num"
              value={newProduct.offlineSafetyQty}
              onChange={(event) =>
                setNewProduct({ ...newProduct, offlineSafetyQty: event.target.value })
              }
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
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing ? `แก้ไขสินค้า · ${editing.name}` : ''}
        description="ชื่อ หมวด บาร์โค้ด ราคา และคำอธิบาย — จำนวนสต็อกไม่แก้ที่นี่ ต้องใช้ปุ่มปรับสต็อกเพื่อให้มีเหตุผลกับบันทึก และรูปสินค้าแก้ที่ปุ่มรูปสินค้า"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
              ยกเลิก
            </Button>
            <Button loading={saving} onClick={() => void saveProduct()}>
              บันทึก
            </Button>
          </>
        }
      >
        <Stack gap="md">
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <FieldRow columns={2}>
            <TextField
              id="edit-name"
              label="ชื่อสินค้า"
              value={editDraft.name}
              onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })}
            />
            <TextField
              id="edit-barcode"
              label="บาร์โค้ด"
              help="เว้นว่างเพื่อเอาบาร์โค้ดออก"
              className="ln-mono"
              value={editDraft.barcode}
              onChange={(event) => setEditDraft({ ...editDraft, barcode: event.target.value })}
            />
          </FieldRow>
          <FieldRow columns={3}>
            <SelectField
              id="edit-category"
              label="หมวดหมู่"
              value={editDraft.categoryId}
              onChange={(event) => setEditDraft({ ...editDraft, categoryId: event.target.value })}
            >
              <option value="">— ไม่ระบุ —</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </SelectField>
            <TextField
              id="edit-cost-price"
              label="ราคาทุน"
              inputMode="decimal"
              className="ln-num"
              value={editDraft.costPrice}
              onChange={(event) => setEditDraft({ ...editDraft, costPrice: event.target.value })}
            />
            <TextField
              id="edit-sale-price"
              label="ราคาขาย"
              inputMode="decimal"
              className="ln-num"
              value={editDraft.salePrice}
              onChange={(event) => setEditDraft({ ...editDraft, salePrice: event.target.value })}
            />
          </FieldRow>
          <TextAreaField
            id="edit-description"
            label="คำอธิบายสินค้า"
            help="เก็บไว้กับสินค้า ถ้าไม่มีให้เว้นว่าง"
            rows={2}
            maxLength={1000}
            value={editDraft.description}
            onChange={(event) => setEditDraft({ ...editDraft, description: event.target.value })}
          />
        </Stack>
      </Overlay>

      <Overlay
        open={editingImage !== null}
        onClose={() => setEditingImage(null)}
        title={editingImage ? `รูปสินค้า · ${editingImage.name}` : ''}
        description="วางลิงก์ https ของรูป — ระบบเก็บลิงก์ไว้ ไม่ได้เก็บไฟล์รูป และจะทดลองเปิดให้ดูก่อนบันทึก"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setEditingImage(null)}
              disabled={saving || imageChecking}
            >
              ยกเลิก
            </Button>
            <Button loading={saving || imageChecking} onClick={() => void saveImage()}>
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
            error={imageError ?? undefined}
            onChange={(event) => {
              setImageDraft(event.target.value);
              if (imageError !== null) {
                setImageError(null);
              }
            }}
          />
          {/*
           * The preview is the whole point of the dialog: a link that returns a login
           * page, a link to a folder rather than a file, and a link that is simply
           * wrong all look the same as a good one until something tries to draw it.
           */}
          <Thumb url={imageDraft} size="lg" />
        </Stack>
      </Overlay>

      <Overlay
        open={editingReserve !== null}
        onClose={() => setEditingReserve(null)}
        title={editingReserve ? `กันสำรองออฟไลน์ · ${editingReserve.name}` : ''}
        description={
          editingReserve
            ? `คงเหลือ ${editingReserve.stockQty} · จองไว้ ${editingReserve.reservedQty} · ขายได้ ${editingReserve.availableQty}`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditingReserve(null)} disabled={saving}>
              ยกเลิก
            </Button>
            <Button loading={saving} onClick={() => void saveReserve()}>
              บันทึก
            </Button>
          </>
        }
      >
        <Stack gap="md">
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <TextField
            id="edit-offline-safety"
            label="กันสำรองออฟไลน์"
            help="เว้นว่างหรือใส่ 0 เพื่อไม่กัน — กระทบเฉพาะตอนขายออฟไลน์ ไม่กระทบยอดขายออนไลน์"
            inputMode="numeric"
            className="ln-num"
            value={reserveDraft}
            onChange={(event) => setReserveDraft(event.target.value)}
          />
          {/*
           * What the number does, in the shop's own arithmetic. A shop setting 2 on a
           * product with 5 on the shelf has to be able to read "ขายออฟไลน์ได้อีก 3" back,
           * because that sentence is the whole promise this setting makes (ADR 0019).
           */}
          {editingReserve ? (
            <InlineNotice tone="info">
              {`ตอนเน็ตหลุด เครื่องจะขาย \"${editingReserve.name}\" ได้อีก ${Math.max(
                0,
                editingReserve.availableQty - Number(reserveDraft === '' ? 0 : reserveDraft),
              )} ชิ้น`}
            </InlineNotice>
          ) : null}
        </Stack>
      </Overlay>

      <Overlay
        open={consigning !== null}
        onClose={() => setConsigning(null)}
        title={consigning ? `ฝากขาย · ${consigning.name}` : ''}
        description="สินค้าของสมาชิกที่ร้านขายแทน — ร้านเป็นผู้ขาย และเป็นหนี้ส่วนแบ่งให้สมาชิกเมื่องานขายสำเร็จ"
        footer={
          <>
            {consigning?.consignorUserId ? (
              <Button variant="secondary" onClick={() => void withdrawGoods()} disabled={saving}>
                ถอนสินค้าฝากขาย
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setConsigning(null)} disabled={saving}>
              ยกเลิก
            </Button>
            <Button loading={saving} onClick={() => void saveConsignment()}>
              บันทึก
            </Button>
          </>
        }
      >
        <Stack gap="md">
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <TextField
            id="consign-search"
            label="ค้นหาสมาชิก"
            help="พิมพ์ชื่อหรือเบอร์โทรของสมาชิกผู้ฝากขาย"
            value={consignorQuery}
            onChange={(event) => setConsignorQuery(event.target.value)}
          />
          {consignorResults.length > 0 ? (
            <SelectField
              id="consign-member"
              label="สมาชิกผู้ฝากขาย"
              value={consignorId}
              onChange={(event) => setConsignorId(event.target.value)}
            >
              <option value="">— เลือกสมาชิก —</option>
              {consignorResults.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.fullName} · {member.phone}
                </option>
              ))}
            </SelectField>
          ) : null}
          <TextField
            id="consign-share"
            label="ส่วนแบ่งของสมาชิก (%)"
            help="เปอร์เซ็นต์ของยอดสุทธิ (ไม่รวม VAT) — เศษสตางค์ที่ปัดขึ้นเป็นของร้าน"
            inputMode="numeric"
            className="ln-num"
            value={shareDraft}
            onChange={(event) => setShareDraft(event.target.value)}
          />
          {consigning?.consignorUserId ? (
            <InlineNotice tone="info">
              {`ขณะนี้ฝากขายกับ ${consigning.consignorName ?? 'สมาชิก'} · ${consigning.consignorSharePercent}% — "ถอนสินค้าฝากขาย" จะดึงของที่ยังไม่ขายออกจากสต็อกและปิดสัญญา`}
            </InlineNotice>
          ) : null}
        </Stack>
      </Overlay>
    </Stack>
  );
}
