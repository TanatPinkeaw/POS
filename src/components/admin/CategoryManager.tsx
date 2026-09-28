'use client';

/**
 * Category management (ADR 0002).
 *
 * Categories used to be readable but not creatable, so a renter's only choices
 * were the four the seed happened to insert. Deleting is refused while products
 * still point at a category — the database refuses it too, but the useful answer
 * is "this still has 14 products", which is why the count is loaded up front and
 * why the delete button is disabled rather than failing on click.
 *
 * Deleting asks through `ConfirmDialog` rather than `window.confirm`: a browser
 * dialog blocks the whole tab, cannot be styled, and is not translated — and the
 * one thing it must do here is name the category being removed.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  InlineNotice,
  Pill,
  Stack,
  TextField,
  Toolbar,
  type Column,
} from '@/components/ds';
import { apiFetch, apiPatch, apiPost } from '@/lib/client-api';

export interface CategoryRow {
  id: number;
  name: string;
  productCount: number;
}

export function CategoryManager({ initialCategories }: { initialCategories: CategoryRow[] }) {
  const router = useRouter();
  const [categories, setCategories] = useState(initialCategories);

  /*
   * Same contract as the product table next door: the row edits below are local
   * for a moment, and the refreshed props take over afterwards. It matters most
   * after an import, which can create a category the operator never typed in — the
   * count then has to arrive from the server, because nothing here made it.
   */
  useEffect(() => {
    setCategories(initialCategories);
  }, [initialCategories]);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [removing, setRemoving] = useState<CategoryRow | null>(null);
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
      await apiFetch(`/api/v1/categories/${row.id}`, { method: 'DELETE' });
      setCategories((current) => current.filter((entry) => entry.id !== row.id));
      setRemoving(null);
      setNotice({ tone: 'success', text: `ลบหมวด "${row.name}" แล้ว` });
    });
  }

  const columns: Column<CategoryRow>[] = [
    {
      key: 'name',
      header: 'หมวด',
      cardLabel: 'หมวด',
      render: (row) =>
        editingId === row.id ? (
          <span className="ln-row">
            <TextField
              id={`rename-${row.id}`}
              label={`ชื่อหมวดใหม่สำหรับ ${row.name}`}
              hideLabel
              autoComplete="off"
              value={editingName}
              onChange={(event) => setEditingName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && editingName.trim() !== '') {
                  event.preventDefault();
                  void rename(row);
                }
              }}
            />
            <Button
              size="sm"
              disabled={busy || editingName.trim() === ''}
              onClick={() => void rename(row)}
            >
              บันทึก
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
              ยกเลิก
            </Button>
          </span>
        ) : (
          row.name
        ),
    },
    {
      key: 'count',
      header: 'สินค้า',
      align: 'end',
      render: (row) => (
        <Pill tone={row.productCount > 0 ? 'brand' : 'neutral'}>{row.productCount} สินค้า</Pill>
      ),
    },
    {
      key: 'actions',
      header: '',
      cardLabel: 'จัดการ',
      align: 'end',
      render: (row) => (
        <span className="ln-row">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || editingId === row.id}
            onClick={() => {
              setEditingId(row.id);
              setEditingName(row.name);
            }}
          >
            เปลี่ยนชื่อ
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || row.productCount > 0}
            title={row.productCount > 0 ? 'ย้ายสินค้าออกจากหมวดนี้ก่อนลบ' : 'ลบหมวดนี้'}
            onClick={() => setRemoving(row)}
          >
            ลบ
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Stack gap="md">
      {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}

      <Card
        title="หมวดหมู่สินค้า"
        subtitle={`${categories.length} หมวด`}
        toolbar={
          <Toolbar
            actions={
              <Button
                disabled={busy || newName.trim() === ''}
                onClick={() => void create()}
              >
                เพิ่มหมวด
              </Button>
            }
          >
            <TextField
              id="new-category"
              label="ชื่อหมวดใหม่"
              hideLabel
              placeholder="ชื่อหมวดใหม่"
              autoComplete="off"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newName.trim() !== '') {
                  event.preventDefault();
                  void create();
                }
              }}
            />
          </Toolbar>
        }
        flush
      >
        <DataTable
          columns={columns}
          rows={categories}
          getRowKey={(row) => String(row.id)}
          caption="หมวดหมู่สินค้าทั้งหมด"
          empty={
            <EmptyState
              icon="tag"
              title="ยังไม่มีหมวดหมู่"
              description="เพิ่มหมวดแรกเพื่อจัดกลุ่มสินค้า"
            />
          }
        />
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title="ลบหมวดนี้?"
        description={
          removing
            ? `หมวด "${removing.name}" จะหายไปจากตะกร้าและรายงาน — ย้อนกลับไม่ได้`
            : undefined
        }
        confirmLabel="ลบหมวด"
        busy={busy}
        onConfirm={() => {
          if (removing) {
            void remove(removing);
          }
        }}
        onCancel={() => setRemoving(null)}
      />
    </Stack>
  );
}
