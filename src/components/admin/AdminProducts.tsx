'use client';

import { useCallback, useMemo, useState } from 'react';

import { Badge, Card, Money } from '@/components/hope/ui';
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

/**
 * Catalogue and stock administration — SRS §4.3.
 *
 * Adjustments are signed (negative for damage, positive for a delivery) and the
 * reason is mandatory, because the audit trail is only useful if every row can
 * answer "who changed this, by how much, and why".
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
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState({ delta: '', reason: 'REASON_RESTOCK', note: '' });

  const [newProduct, setNewProduct] = useState({
    name: '',
    barcode: '',
    categoryId: '',
    costPrice: '',
    salePrice: '',
    stockQty: '',
  });

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

  const submitAdjustment = async (productId: string): Promise<void> => {
    const delta = Number(adjustment.delta);
    if (!Number.isInteger(delta) || delta === 0) {
      setError('จำนวนที่ปรับต้องเป็นจำนวนเต็มและไม่เป็นศูนย์');
      return;
    }

    setError(null);
    try {
      await apiPost('/api/v1/inventory/adjust', {
        productId,
        delta,
        reason: adjustment.reason,
        note: adjustment.note || null,
      });
      setNotice('บันทึกการปรับสต็อกแล้ว (มีบันทึกใน stock_logs)');
      setAdjustingId(null);
      setAdjustment({ delta: '', reason: 'REASON_RESTOCK', note: '' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ปรับสต็อกไม่สำเร็จ');
    }
  };

  const createProduct = async (): Promise<void> => {
    setError(null);
    try {
      await apiPost('/api/v1/products', {
        name: newProduct.name,
        barcode: newProduct.barcode || null,
        categoryId: newProduct.categoryId ? Number(newProduct.categoryId) : null,
        costPrice: Number(newProduct.costPrice || 0),
        salePrice: Number(newProduct.salePrice || 0),
        stockQty: Number(newProduct.stockQty || 0),
      });
      setNotice(`เพิ่มสินค้า "${newProduct.name}" แล้ว`);
      setNewProduct({ name: '', barcode: '', categoryId: '', costPrice: '', salePrice: '', stockQty: '' });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'เพิ่มสินค้าไม่สำเร็จ');
    }
  };

  const toggleActive = async (product: AdminProduct): Promise<void> => {
    setError(null);
    try {
      await apiPatch(`/api/v1/products/${product.id}`, { isActive: !product.isActive });
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'อัปเดตสินค้าไม่สำเร็จ');
    }
  };

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex justify-content-between align-items-end flex-wrap gap-2">
        <div>
          {/* The page's only `<h1>`; `.h4` keeps the original size exactly. */}
          <h1 className="h4 mb-1">สินค้าและสต็อก</h1>
          <p className="text-muted mb-0 small">
            การปรับสต็อกทุกครั้งต้องระบุเหตุผล และจะถูกบันทึกไว้ตรวจสอบย้อนหลังได้
          </p>
        </div>
        <input
          className="form-control form-control-sm"
          style={{ maxWidth: 260 }}
          placeholder="ค้นหาชื่อหรือบาร์โค้ด"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {notice && <div className="alert alert-success py-2 small">{notice}</div>}
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <Card title="เพิ่มสินค้าใหม่">
        <div className="row g-2 align-items-end">
          <div className="col-12 col-md-3">
            <label className="form-label small" htmlFor="np-name">ชื่อสินค้า</label>
            <input id="np-name" className="form-control form-control-sm" value={newProduct.name}
              onChange={(event) => setNewProduct({ ...newProduct, name: event.target.value })} />
          </div>
          <div className="col-6 col-md-2">
            <label className="form-label small" htmlFor="np-barcode">บาร์โค้ด</label>
            <input id="np-barcode" className="form-control form-control-sm" value={newProduct.barcode}
              onChange={(event) => setNewProduct({ ...newProduct, barcode: event.target.value })} />
          </div>
          <div className="col-6 col-md-2">
            <label className="form-label small" htmlFor="np-category">หมวดหมู่</label>
            <select id="np-category" className="form-select form-select-sm" value={newProduct.categoryId}
              onChange={(event) => setNewProduct({ ...newProduct, categoryId: event.target.value })}>
              <option value="">—</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </div>
          <div className="col-4 col-md-1">
            <label className="form-label small" htmlFor="np-cost">ทุน</label>
            <input id="np-cost" className="form-control form-control-sm pos-numeric" inputMode="decimal"
              value={newProduct.costPrice}
              onChange={(event) => setNewProduct({ ...newProduct, costPrice: event.target.value })} />
          </div>
          <div className="col-4 col-md-1">
            <label className="form-label small" htmlFor="np-price">ราคา</label>
            <input id="np-price" className="form-control form-control-sm pos-numeric" inputMode="decimal"
              value={newProduct.salePrice}
              onChange={(event) => setNewProduct({ ...newProduct, salePrice: event.target.value })} />
          </div>
          <div className="col-4 col-md-1">
            <label className="form-label small" htmlFor="np-stock">สต็อก</label>
            <input id="np-stock" className="form-control form-control-sm pos-numeric" inputMode="numeric"
              value={newProduct.stockQty}
              onChange={(event) => setNewProduct({ ...newProduct, stockQty: event.target.value })} />
          </div>
          <div className="col-12 col-md-2">
            <button type="button" className="btn btn-primary btn-sm w-100"
              disabled={!newProduct.name || !newProduct.salePrice}
              onClick={() => void createProduct()}>
              เพิ่มสินค้า
            </button>
          </div>
        </div>
      </Card>

      <Card title={`รายการสินค้า (${filtered.length})`}>
        <div className="table-responsive">
          <table className="table table-hover align-middle mb-0">
            <thead>
              <tr>
                <th>สินค้า</th>
                <th>หมวดหมู่</th>
                <th className="pos-numeric">ทุน</th>
                <th className="pos-numeric">ราคา</th>
                <th className="pos-numeric">คงเหลือ</th>
                <th className="pos-numeric">จองไว้</th>
                <th className="pos-numeric">ขายได้</th>
                <th>สถานะ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((product) => (
                <tr key={product.id} className={product.isActive ? '' : 'opacity-50'}>
                  <td>
                    <span className="d-block small fw-medium">{product.name}</span>
                    {product.barcode && <code className="text-muted small">{product.barcode}</code>}
                  </td>
                  <td className="small text-muted">{product.categoryName ?? '—'}</td>
                  <td className="pos-numeric"><Money amount={product.costPrice} /></td>
                  <td className="pos-numeric"><Money amount={product.salePrice} /></td>
                  <td className="pos-numeric">{product.stockQty}</td>
                  <td className="pos-numeric text-muted">{product.reservedQty}</td>
                  <td className="pos-numeric">
                    <Badge tone={product.availableQty <= 0 ? 'danger' : product.availableQty <= 5 ? 'warning' : 'success'}>
                      {product.availableQty}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={product.isActive ? 'success' : 'secondary'}>
                      {product.isActive ? 'ใช้งาน' : 'ปิด'}
                    </Badge>
                  </td>
                  <td className="text-nowrap">
                    <button type="button" className="btn btn-sm btn-soft-primary"
                      onClick={() => {
                        setAdjustingId(adjustingId === product.id ? null : product.id);
                        setAdjustment({ delta: '', reason: 'REASON_RESTOCK', note: '' });
                      }}>
                      ปรับสต็อก
                    </button>{' '}
                    <button type="button" className="btn btn-sm btn-soft-secondary"
                      onClick={() => void toggleActive(product)}>
                      {product.isActive ? 'ปิด' : 'เปิด'}
                    </button>

                    {adjustingId === product.id && (
                      <div className="mt-2 border rounded p-2" style={{ minWidth: 260 }}>
                        <div className="row g-1">
                          <div className="col-4">
                            <input className="form-control form-control-sm pos-numeric" inputMode="numeric"
                              placeholder="±จำนวน" value={adjustment.delta}
                              onChange={(event) => setAdjustment({ ...adjustment, delta: event.target.value })} />
                          </div>
                          <div className="col-8">
                            <select className="form-select form-select-sm" value={adjustment.reason}
                              onChange={(event) => setAdjustment({ ...adjustment, reason: event.target.value })}>
                              {REASONS.map((reason) => (
                                <option key={reason.value} value={reason.value}>{reason.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="col-12">
                            <input className="form-control form-control-sm" placeholder="หมายเหตุ"
                              value={adjustment.note}
                              onChange={(event) => setAdjustment({ ...adjustment, note: event.target.value })} />
                          </div>
                          <div className="col-12">
                            <button type="button" className="btn btn-sm btn-primary w-100"
                              onClick={() => void submitAdjustment(product.id)}>
                              บันทึก
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
