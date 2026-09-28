'use client';

/**
 * The till's state, kept out of its markup.
 *
 * `PosTerminal.tsx` was five hundred and fifty lines of one component, and the
 * reason it mattered is that the previous version could only be changed by editing
 * a file that mixed catalogue paging, stock reconciliation, loyalty, discount
 * arithmetic, settlement, and the modal that shows the receipt. Splitting the state
 * out means the four panes that draw it are each small enough to reason about, and
 * that the arithmetic below can be read without scrolling through markup.
 *
 * Two rules are load-bearing:
 *
 *   * **The catalogue is paged by the server.** The old hook fetched every product
 *     once and filtered in the browser, which made product 201 unsellable — see
 *     `src/lib/product-query.ts`.
 *   * **Cash is the last leg of a payment.** The settlement the server is sent has
 *     cash as its final component and the change is computed from it, which is what
 *     keeps `SUM(payments.amount) WHERE method = 'cash'` equal to the notes in the
 *     drawer (SRS §6.2).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import type { ProductView } from '@/lib/product-view';
import type { TenderLine } from '@/lib/tender';

import { useRealtimeEvent } from '../realtime/RealtimeProvider';
import type { Shift } from './useOpenShift';

/** One page of the catalogue, as the products route answers. */
interface CataloguePage {
  items: ProductView[];
  total: number;
}

export interface CartLine {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  availableQty: number;
  categoryKey: string;
}

export interface TillMember {
  id: string;
  fullName: string;
  phone: string;
  pointsBalance: number;
}

export interface SaleResult {
  orderId: string;
  orderNumber: string;
  receiptNumber: string | null;
  isVatInvoice: boolean;
  vatRatePercent: number | null;
  subtotalThb: number;
  netThb: number;
  vatThb: number;
  finalAmountThb: number;
  discountThb: number;
  /**
   * What was handed over, per method — the figures `รับเงิน` prints. Carried
   * straight from the sale response into `Receipt`, so the modal shown at the
   * moment of sale and a reprint read the same tender lines.
   */
  tenders: TenderLine[];
  changeThb: number;
  pointsEarned: number;
  pointsRedeemed: number;
  lines: { name: string; quantity: number; unitPrice: number; totalPrice: number }[];
}

/** How the customer is paying. Cash is always the last leg, whichever this is. */
export type TenderMode = 'cash' | 'promptpay' | 'split';

const PAGE_SIZE = 60;

export function useTill({
  initialProducts,
  initialTotal,
  shift,
  onSold,
}: {
  initialProducts: ProductView[];
  initialTotal: number;
  shift: Shift | null;
  /** Lets the drawer's totals refresh after a sale. */
  onSold: () => Promise<void> | void;
}) {
  const [products, setProducts] = useState<ProductView[]>(initialProducts);
  const [total, setTotal] = useState(initialTotal);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [loadingCatalogue, setLoadingCatalogue] = useState(false);

  const [lines, setLines] = useState<CartLine[]>([]);
  const [member, setMember] = useState<TillMember | null>(null);
  const [memberQuery, setMemberQuery] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);
  const [usePoints, setUsePoints] = useState(false);
  const [discount, setDiscount] = useState('');
  const [tenderMode, setTenderMode] = useState<TenderMode>('cash');
  const [splitPromptpay, setSplitPromptpay] = useState('');
  const [receivedCash, setReceivedCash] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<(SaleResult & { at: string }) | null>(null);

  const scanInput = useRef<HTMLInputElement | null>(null);

  /**
   * Live stock, from every other till and every reservation.
   *
   * Patched into the page that is on screen rather than triggering a refetch: a
   * refetch on every stock event would fight the operator's scrolling, and the
   * counts are the only part that went stale.
   */
  useRealtimeEvent<{
    productId: string;
    stockQty: number;
    reservedQty: number;
    availableQty: number;
  }>(
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

  const loadPage = useCallback(
    async (options: {
      search: string;
      categoryId: number | null;
      /** Appends the next page instead of replacing the grid. */
      offset?: number;
    }): Promise<void> => {
      setLoadingCatalogue(true);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (options.search.trim()) {
          params.set('search', options.search.trim());
        }
        if (options.categoryId) {
          params.set('categoryId', String(options.categoryId));
        }
        if (options.offset && options.offset > 0) {
          params.set('offset', String(options.offset));
        }

        const response = await fetch(`/api/v1/products?${params.toString()}`, {
          credentials: 'same-origin',
        });
        if (!response.ok) {
          throw new Error('อ่านรายการสินค้าไม่สำเร็จ');
        }
        const body = (await response.json()) as { data: ProductView[] };

        setProducts((current) =>
          options.offset && options.offset > 0 ? [...current, ...body.data] : body.data,
        );
        // `X-Total-Count` is how many matched the filter, not how many were sent —
        // it is what the grid footer uses to say "ยังมีอีก N รายการ" instead of the
        // list simply looking finished.
        setTotal(Number(response.headers.get('X-Total-Count') ?? body.data.length));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'อ่านรายการสินค้าไม่สำเร็จ');
      } finally {
        setLoadingCatalogue(false);
      }
    },
    [],
  );

  /** Re-reads the current page. Used after a sale, so the counts are authoritative. */
  const reload = useCallback(
    () => loadPage({ search, categoryId }),
    [loadPage, search, categoryId],
  );

  /** The next page of the same filter, appended. */
  const loadMore = useCallback(
    () => loadPage({ search, categoryId, offset: products.length }),
    [categoryId, loadPage, products.length, search],
  );

  // Debounced so typing a product name does not fire a request per keystroke. A
  // barcode scanned with Enter still resolves immediately, because `onScan`
  // bypasses this path entirely.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPage({ search, categoryId });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, categoryId, loadPage]);

  const subtotal = useMemo(
    () => lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0),
    [lines],
  );

  const discountValue = Number(discount || 0);
  const pointsValue =
    usePoints && member
      ? Math.min(Math.floor(member.pointsBalance / 100), Math.floor(subtotal - discountValue))
      : 0;
  const due = Math.max(0, Math.round((subtotal - discountValue - pointsValue) * 100) / 100);

  const promptpayDue =
    tenderMode === 'promptpay'
      ? due
      : tenderMode === 'split'
        ? Math.min(due, Math.max(0, Number(splitPromptpay || 0)))
        : 0;
  // Rounded to satang, because this is what the drawer will hold.
  const cashDue = Math.round((due - promptpayDue) * 100) / 100;
  const received = Number(receivedCash || 0);
  const change = Math.round((received - cashDue) * 100) / 100;
  const canPay =
    Boolean(shift) &&
    lines.length > 0 &&
    !busy &&
    (tenderMode === 'promptpay' ? cashDue === 0 : received >= cashDue);

  const addProduct = useCallback((product: ProductView) => {
    setError(null);
    setLines((current) => {
      const found = current.find((line) => line.productId === product.id);
      if (found) {
        if (found.quantity + 1 > product.availableQty) {
          setError(`"${product.name}" เหลือขายได้ ${product.availableQty} ชิ้น`);
          return current;
        }
        return current.map((line) =>
          line.productId === product.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      if (product.availableQty <= 0) {
        setError(
          `"${product.name}" ขายได้ 0 ชิ้น (คงเหลือ ${product.stockQty} · จองไว้ ${product.reservedQty})`,
        );
        return current;
      }
      return [
        ...current,
        {
          productId: product.id,
          name: product.name,
          unitPrice: product.salePrice,
          quantity: 1,
          availableQty: product.availableQty,
          categoryKey: product.categoryKey,
        },
      ];
    });
  }, []);

  /**
   * A barcode scanner types the code and presses Enter.
   *
   * The match is made against the loaded page first, and against the server when it
   * misses — a scanner is how most items reach a grocery bill, and an item that is
   * on page three must be findable by the one input that never leaves focus.
   */
  const scan = useCallback(
    async (raw: string): Promise<void> => {
      const term = raw.trim();
      if (!term) {
        return;
      }

      const local =
        products.find((product) => product.barcode === term) ??
        products.find((product) => product.name.toLowerCase() === term.toLowerCase());

      if (local) {
        addProduct(local);
        setSearch('');
        scanInput.current?.focus();
        return;
      }

      try {
        const found = await apiFetch<ProductView[]>(
          `/api/v1/products?barcode=${encodeURIComponent(term)}&limit=1`,
        );
        const exact =
          found[0] ??
          (
            await apiFetch<ProductView[]>(
              `/api/v1/products?search=${encodeURIComponent(term)}&limit=1`,
            )
          )[0];

        if (!exact) {
          setError(`ไม่พบสินค้าที่ตรงกับ "${term}"`);
          return;
        }
        addProduct(exact);
        setSearch('');
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'ค้นหาสินค้าไม่สำเร็จ');
      } finally {
        scanInput.current?.focus();
      }
    },
    [addProduct, products],
  );

  const setQuantity = useCallback((productId: string, quantity: number): void => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((line) => line.productId !== productId)
        : current.map((line) =>
            line.productId === productId
              ? { ...line, quantity: Math.min(quantity, line.availableQty) }
              : line,
          ),
    );
  }, []);

  const clearCart = useCallback(() => {
    setLines([]);
    setDiscount('');
    setMember(null);
    setMemberQuery('');
    setUsePoints(false);
  }, []);

  const findMember = useCallback(async (): Promise<void> => {
    setMemberError(null);
    try {
      const found = await apiFetch<TillMember[]>(
        `/api/v1/members?phone=${encodeURIComponent(memberQuery.trim())}`,
      );
      if (found.length === 0) {
        setMemberError('ไม่พบสมาชิกเบอร์นี้');
        return;
      }
      setMember(found[0]!);
      setUsePoints(false);
    } catch (caught) {
      setMemberError(caught instanceof Error ? caught.message : 'ค้นหาสมาชิกไม่สำเร็จ');
    }
  }, [memberQuery]);

  const checkout = useCallback(async (): Promise<SaleResult | null> => {
    if (!shift) {
      setError('ต้องเปิดลิ้นชักก่อนรับชำระเงิน');
      return null;
    }
    if (lines.length === 0) {
      setError('ยังไม่มีสินค้าในตะกร้า');
      return null;
    }

    setBusy(true);
    setError(null);

    try {
      const pointsToRedeem =
        usePoints && member ? Math.floor(member.pointsBalance / 100) * 100 : 0;

      /*
       * The settlement states each leg explicitly. Cash is written last and carries
       * the cash handed over, which is the only figure the change is derived from —
       * so a split payment's change cannot be computed against the wrong share.
       */
      const settlement = {
        ...(cashDue > 0 ? { cash: cashDue } : {}),
        ...(promptpayDue > 0 ? { promptpay: promptpayDue } : {}),
        ...(cashDue > 0 ? { receivedCash: received > 0 ? received : cashDue } : {}),
        points: pointsToRedeem,
      };

      const result = await apiPost<SaleResult>('/api/v1/orders', {
        type: 'pos_walkin',
        shiftId: shift.id,
        lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        customerId: member?.id ?? null,
        discountThb: discountValue,
        settlement,
      });

      // Stamped once, here: `Receipt` defaults to "now", and a re-render while the
      // modal is open must not move the time printed on the document.
      setReceipt({ ...result, at: new Date().toISOString() });
      clearCart();
      setReceivedCash('');
      setSplitPromptpay('');
      setTenderMode('cash');
      await onSold();
      await reload();
      scanInput.current?.focus();
      return result;
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'ชำระเงินไม่สำเร็จ กรุณาลองใหม่',
      );
      return null;
    } finally {
      setBusy(false);
    }
  }, [
    cashDue,
    clearCart,
    discountValue,
    lines,
    member,
    onSold,
    promptpayDue,
    received,
    reload,
    shift,
    usePoints,
  ]);

  return {
    // catalogue
    products,
    total,
    categoryId,
    setCategoryId,
    search,
    setSearch,
    loadingCatalogue,
    loadMore,
    /** True while more pages exist behind the one on screen. */
    hasMore: products.length < total,
    // cart
    lines,
    addProduct,
    scan,
    setQuantity,
    clearCart,
    scanInput,
    // loyalty and discount
    member,
    memberQuery,
    setMemberQuery,
    memberError,
    findMember,
    setMember,
    usePoints,
    setUsePoints,
    discount,
    setDiscount,
    // money
    subtotal,
    discountValue,
    pointsValue,
    due,
    promptpayDue,
    cashDue,
    receivedCash,
    setReceivedCash,
    tenderMode,
    setTenderMode,
    splitPromptpay,
    setSplitPromptpay,
    change,
    canPay,
    // outcome
    busy,
    error,
    setError,
    checkout,
    receipt,
    setReceipt,
  };
}

export type Till = ReturnType<typeof useTill>;
