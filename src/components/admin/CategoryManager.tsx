'use client';

/**
 * Category management (ADR 0002).
 *
 * Categories used to be readable but not creatable, so a renter's only choices
 * were the four the seed happened to insert. Deleting is refused while products
 * still point at a category — the database refuses it too, but the useful answer
 * is "this still has 14 products", which is why the count is loaded up front.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Alert, Badge, Card, EmptyState } from '@/components/hope/ui';
import { apiFetch, apiPatch, apiPost } from '@/lib/client-api';

export interface CategoryRow {
  id: number;
  name: string;
  productCount: number;
}

export function CategoryManager({ initialCategories }: { initialCategories: CategoryRow[] }) {
  const router = useRouter();
  const [categories, setCategories] = useState(initialCategories);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      await action();
      router.refresh();
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : 'ดำเนินการไม่สำเร็จ' });
    } finally {
      setBusy(false);
    }
  }

  function create(): Promise<void> {
    return run(async () => {
      const created = await apiPost<{ id: number; name: string }>('/api/v1/categories', {
        name: newName,
      });
      setCategories((current) =>
        [...current, { id: created.id, name: created.name, productCount: 0 }].sort((left, right) =>
          left.name.localeCompare(right.name, 'th'),
        ),
      );
      setNewName('');
      setNotice({ tone: 'success', text: `เพิ่มหมวด "${created.name}" แล้ว` });
    });
  }

  function rename(row: CategoryRow): Promise<void> {
    return run(async () => {
      const updated = await apiPatch<{ id: number; name: string }>(`/api/v1/categories/${row.id}`, {
        name: editingName,
      });
      setCategories((current) =>
        current.map((entry) => (entry.id === row.id ? { ...entry, name: updated.name } : entry)),
      );
      setEditingId(null);
      setNotice({ tone: 'success', text: 'เปลี่ยนชื่อหมวดแล้ว' });
    });
  }

  function remove(row: CategoryRow): Promise<void> {
    return run(async () => {
      if (!window.confirm(`ลบหมวด "${row.name}"?`)) {
        return;
      }
      await apiFetch(`/api/v1/categories/${row.id}`, { method: 'DELETE' });
      setCategories((current) => current.filter((entry) => entry.id !== row.id));
      setNotice({ tone: 'success', text: `ลบหมวด "${row.name}" แล้ว` });
    });
  }

  return (
    <Card title="หมวดหมู่สินค้า" subtitle={`${categories.length} หมวด`}>
      <div className="d-flex gap-2 mb-3">
        <div className="flex-grow-1">
          <label className="visually-hidden" htmlFor="new-category">
            ชื่อหมวดใหม่
          </label>
          <input
            id="new-category"
            name="categoryName"
            autoComplete="off"
            className="form-control form-control-sm"
            placeholder="ชื่อหมวดใหม่"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && newName.trim() !== '') {
                event.preventDefault();
                void create();
              }
            }}
          />
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || newName.trim() === ''}
          onClick={() => void create()}
        >
          เพิ่มหมวด
        </button>
      </div>

      {notice && (
        <Alert tone={notice.tone} className="mb-3">
          {notice.text}
        </Alert>
      )}

      {categories.length === 0 ? (
        <EmptyState title="ยังไม่มีหมวดหมู่" description="เพิ่มหมวดแรกเพื่อจัดกลุ่มสินค้า" />
      ) : (
        <ul className="list-group list-group-flush">
          {categories.map((row) => (
            <li
              key={row.id}
              className="list-group-item d-flex justify-content-between align-items-center px-0"
            >
              {editingId === row.id ? (
                <div className="d-flex gap-2 flex-grow-1 me-2">
                  <label className="visually-hidden" htmlFor={`rename-${row.id}`}>
                    ชื่อหมวดใหม่สำหรับ {row.name}
                  </label>
                  <input
                    id={`rename-${row.id}`}
                    name={`rename-${row.id}`}
                    autoComplete="off"
                    className="form-control form-control-sm"
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy || editingName.trim() === ''}
                    onClick={() => void rename(row)}
                  >
                    บันทึก
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-soft-secondary"
                    onClick={() => setEditingId(null)}
                  >
                    ยกเลิก
                  </button>
                </div>
              ) : (
                <>
                  <span>
                    {row.name}{' '}
                    <Badge tone={row.productCount > 0 ? 'primary' : 'secondary'}>
                      {row.productCount} สินค้า
                    </Badge>
                  </span>
                  <span className="d-flex gap-2">
                    <button
                      type="button"
                      className="btn btn-sm btn-soft-secondary"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(row.id);
                        setEditingName(row.name);
                      }}
                    >
                      เปลี่ยนชื่อ
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-soft-danger"
                      disabled={busy || row.productCount > 0}
                      title={
                        row.productCount > 0
                          ? 'ย้ายสินค้าออกจากหมวดนี้ก่อนลบ'
                          : 'ลบหมวดนี้'
                      }
                      onClick={() => void remove(row)}
                    >
                      ลบ
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
