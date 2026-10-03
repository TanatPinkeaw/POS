'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiFetch, apiPost } from '@/lib/client-api';

/** Mirrors the server's `ShiftSummary` — SRS §6.2. */
export interface Shift {
  id: number;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  initialCashThb: number;
  cashSalesThb: number;
  cashPayoutsThb: number;
  expectedCashThb: number;
  actualCashThb: number | null;
  discrepancyThb: number | null;
  discrepancyKind: 'balanced' | 'shortage' | 'overage' | null;
  orderCount: number;
}

/** Reads and drives the employee's current cash drawer. */
export function useOpenShift() {
  const [shift, setShift] = useState<Shift | null>(null);
  const [defaultInitialCash, setDefaultInitialCash] = useState(2000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await apiFetch<{ shift: Shift | null; defaultInitialCashThb: number }>(
        '/api/v1/shifts/current',
      );
      setShift(result.shift);
      setDefaultInitialCash(result.defaultInitialCashThb);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'อ่านข้อมูลลิ้นชักไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(
    async (initialCash: number) => {
      const created = await apiPost<Shift>('/api/v1/shifts/current', { initialCash });
      setShift(created);
      return created;
    },
    [],
  );

  const close = useCallback(async (actualCash: number) => {
    if (!shift) {
      throw new Error('ไม่มีลิ้นชักที่เปิดอยู่');
    }
    const closed = await apiPost<Shift>(`/api/v1/shifts/${shift.id}/close`, { actualCash });
    setShift(null);
    return closed;
  }, [shift]);

  return { shift, defaultInitialCash, loading, error, refresh, open, close };
}
