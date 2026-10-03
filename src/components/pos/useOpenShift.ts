'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiFetch, apiPost, isOfflineFailure } from '@/lib/client-api';
import { readDeviceDrawer } from '@/lib/offline-drawer';
import type { DeviceShift } from '@/lib/till-store';

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

/**
 * Where the shift on screen came from.
 *
 * `'device'` is a real state and not an error state: the drawer is the one thing a till
 * may answer from memory (ADR 0024), so the screen says so rather than implying the
 * server was asked. Every figure that arrives this way is as of the snapshot, which is
 * what `deviceNotice` says out loud.
 */
export type ShiftSource = 'server' | 'device';

/** A remembered drawer, as a `Shift`: open, with nothing invented about how it closed. */
function shiftFromDevice(shift: DeviceShift): Shift {
  return {
    ...shift,
    status: 'open',
    closedAt: null,
    actualCashThb: null,
    discrepancyThb: null,
    discrepancyKind: null,
  };
}

/** Reads and drives the employee's current cash drawer. */
export function useOpenShift() {
  const [shift, setShift] = useState<Shift | null>(null);
  const [source, setSource] = useState<ShiftSource | null>(null);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [defaultInitialCash, setDefaultInitialCash] = useState(2000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await apiFetch<{ shift: Shift | null; defaultInitialCashThb: number }>(
        '/api/v1/shifts/current',
      );
      setShift(result.shift);
      setSource(result.shift ? 'server' : null);
      setCapturedAt(null);
      setDefaultInitialCash(result.defaultInitialCashThb);
      setError(null);
    } catch (caught) {
      /*
       * The drawer is the one thing an outage must not take away — see `offline-drawer.ts`
       * for why it is the one exception, and why it needs a request that never reached the
       * server rather than one the server refused. Without this the till opened cold would
       * report "ยังไม่เปิดลิ้นชัก" about a drawer that has been open all afternoon.
       */
      const remembered = isOfflineFailure(caught) ? await readDeviceDrawer() : null;
      if (remembered) {
        setShift(shiftFromDevice(remembered.shift));
        setSource('device');
        setCapturedAt(remembered.capturedAt);
        setError(null);
      } else {
        setError(caught instanceof Error ? caught.message : 'อ่านข้อมูลลิ้นชักไม่สำเร็จ');
      }
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

  /*
   * Said beside the drawer rather than in place of it: the cashier needs to know the shift
   * is real, and also that its takings are this morning's figures. A header showing a
   * remembered total without saying so is the quiet version of the bug this replaced.
   */
  const deviceNotice =
    source === 'device'
      ? `ลิ้นชักนี้มาจากข้อมูลในเครื่อง${capturedAt ? ` · บันทึกเมื่อ ${new Date(capturedAt).toLocaleString('th-TH')}` : ''} — ตัวเลขจะถูกอัปเดตเมื่อกลับมาออนไลน์`
      : null;

  return { shift, source, deviceNotice, defaultInitialCash, loading, error, refresh, open, close };
}
