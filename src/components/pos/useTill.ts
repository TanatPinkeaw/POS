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
import { firstName } from '@/lib/display-view';
import { formatThb } from '@/lib/money';
import { acquireTillWriter, createDeviceStorage } from '@/lib/offline-db';
import { offlineSellableQty, tallyOfflineSales, type OfflineBasket, type OfflineCatalogueEntry } from '@/lib/offline-sale-rules';
import type { PaymentIntentView } from '@/lib/payment-intents-view';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import type { ProductView } from '@/lib/product-view';
import type { ShopView } from '@/lib/shop-view';
import { APPROVAL_HEADER, discountApprovalTarget } from '@/lib/supervisor-view';
import {
  createTillStore,
  type TillSnapshot,
  type TillStore,
  type TillStoreState,
} from '@/lib/till-store';
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
  /**
   * Carried so the customer display can show the same picture the cashier is
   * bagging (ADR 0014). Null when the shop has not set one; nothing downstream
   * requires it, which is why it is not part of what is sent to the server.
   */
  imageUrl: string | null;
}

export interface TillMember {
  id: string;
  fullName: string;
  phone: string;
  pointsBalance: number;
}

export interface SaleResult {
  /**
   * Null for a bill the device closed with no connection: the server has never seen it, so
   * there is no order to open, refund or reprint from the back office yet (phase 4 mints
   * one when the queue is sent). The slip prints the device's own `OFF-…` reference.
   */
  orderId: string | null;
  orderNumber: string;
  receiptNumber: string | null;
  /** The number the customer is called by, printed as it is called (ADR 0017). */
  queueNumber: string | null;
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

/** Money to two decimal places, the same rounding the settlement layer uses. */
function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

const PAGE_SIZE = 60;

/**
 * What the shop calls this device.
 *
 * Phase 4 asks the shop to name a device when it borrows numbers — the name is written on
 * the loan, so an operator can see *which* till is holding a series. Until then the
 * browser's own word for itself is the best identity available, and it is only ever shown
 * to a person looking at the shop's own screens.
 */
const DEVICE_LABEL =
  typeof navigator === 'undefined' ? 'เครื่องหน้าร้าน' : navigator.platform || 'เครื่องหน้าร้าน';

/**
 * What the till asks for when an action is not the cashier's to take alone.
 *
 * Resolves to the approval token, or null when the supervisor walked away — in
 * which case the action is abandoned rather than attempted, because a refused
 * request that still goes through is worse than no gate at all.
 */
export type RequestTillApproval = (request: {
  action: 'over_discount' | 'manual_payment_confirm';
  targetId: string;
  summary?: string;
}) => Promise<string | null>;

export function useTill({
  initialProducts,
  initialTotal,
  shift,
  shiftLoaded,
  cashierId,
  shop,
  onSold,
  discountLimitThb,
  requestApproval,
}: {
  initialProducts: ProductView[];
  initialTotal: number;
  shift: Shift | null;
  shiftLoaded: boolean;
  cashierId: string;
  /**
   * The shop as the server rendered it, which is what the device keeps for offline use.
   *
   * Passed in rather than fetched: this page is already server-rendered with the shop's own
   * settings, and a second read in the browser is a second answer to the same question.
   */
  shop: ShopView;
  /** Lets the drawer's totals refresh after a sale. */
  onSold: () => Promise<void> | void;
  /** Past this discount the cashier needs a supervisor's PIN. */
  discountLimitThb?: number;
  requestApproval?: RequestTillApproval;
}) {
  const [products, setProducts] = useState<ProductView[]>(initialProducts);
  const [total, setTotal] = useState(initialTotal);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [loadingCatalogue, setLoadingCatalogue] = useState(false);

  /*
   * The live PromptPay QR, if one is on screen.
   *
   * `consumedRef` guards the one dangerous case in this file: a payment can be
   * reported twice — once by the socket and once by the poll — and two calls to
   * `checkout` would be two sales for one transfer. The intent's own state
   * machine refuses the second consumption too, but refusing here means the
   * customer never sees a spurious error for money they did pay.
   */
  const [intent, setIntent] = useState<PaymentIntentView | null>(null);
  const [intentBusy, setIntentBusy] = useState(false);
  const [intentError, setIntentError] = useState<string | null>(null);
  const consumedRef = useRef<string | null>(null);

  /*
   * A ref to `checkout`, because `settlePaidIntent` above it has to call it and a
   * `useCallback` cannot reference a function declared later without becoming a
   * dependency of itself. The ref is assigned immediately after `checkout` is
   * built, so the only window in which it is null is before the first render
   * finishes — during which no payment can have arrived.
   */
  const checkoutRef = useRef<((intentRef?: string) => Promise<SaleResult | null>) | null>(null);

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
  const [receipt, setReceipt] = useState<
    (SaleResult & { at: string; offline?: boolean }) | null
  >(null);

  const scanInput = useRef<HTMLInputElement | null>(null);

  /**
   * The device's own store: the one place that answers "server or device?" (ADR 0019).
   *
   * Built once and lazily, because it holds the snapshot and the queue in memory as well as
   * on the device — a new one per render would forget both between keystrokes.
   */
  const storeRef = useRef<TillStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createTillStore({
      storage: createDeviceStorage(),
      deviceLabel: DEVICE_LABEL,
      cashierId,
      transport: {
        borrow: (body) => apiPost('/api/v1/pos/number-blocks', body),
        sync: (body) => apiPost('/api/v1/pos/sync', body),
      },
    });
  }
  const store = storeRef.current;

  /** The device's own state: what it keeps, what is waiting, and whether it is online. */
  const [offline, setOffline] = useState<TillStoreState | null>(null);
  /** The last offline sale's warnings, in the device's own words — shown, not just logged. */
  const [offlineWarning, setOfflineWarning] = useState<string | null>(null);
  const [writer, setWriter] = useState(false);
  const writerRef = useRef(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const syncBusy = useRef(false);
  const checkoutBusy = useRef(false);

  /**
   * Everything this device has seen of the catalogue, by product.
   *
   * Accumulated rather than replaced by whatever page is on screen: the till pages the
   * catalogue in sixty at a time with the filter applied on the server, so a device that had
   * searched for "กาแฟ" and then lost its connection would otherwise hold nothing but coffee
   * — and could not price the rest of the shelf.
   */
  const catalogueRef = useRef(new Map<string, OfflineCatalogueEntry>());

  const remember = useCallback((items: readonly ProductView[]): void => {
    for (const product of items) {
      catalogueRef.current.set(product.id, {
        productId: product.id,
        name: product.name,
        priceThb: product.salePrice,
        /*
         * `stock_qty − reserved_qty` as of this read — what was sellable then, which is what
         * the shop's reserve is subtracted from. The reserve arrives with the catalogue row
         * (`products.offline_safety_qty`, ADR 0019): a setting the back office made and the till
         * never received would be a reserve that protects nothing.
         */
        available: product.availableQty,
        safetyQty: product.offlineSafetyQty,
        isActive: product.isActive,
        // A consignor's goods cannot be sold with no connection (ADR 0023 §8).
        consigned: product.isConsigned,
        barcode: product.barcode, categoryId: product.categoryId, categoryName: product.categoryName,
        categoryKey: product.categoryKey, imageUrl: product.imageUrl,
      });
    }
  }, []);

  /**
   * Writes the shop as the device just read it.
   *
   * The loans this device holds are carried through untouched: they are the store's own
   * bookkeeping, and a screen that could invent or drop a borrowed range is a screen that can
   * put a hole in a series.
   */
  const persistSnapshot = useCallback(async (force = false): Promise<void> => {
    if (!writerRef.current || !shiftLoaded || store.getState().online === false || (syncBusy.current && !force)) return;
    await store.saveSnapshot({
      capturedAt: new Date().toISOString(),
      deviceLabel: DEVICE_LABEL,
      shop: {
        isVatRegistered: shop.isVatRegistered,
        vatRatePercent: shop.vatRate,
        pricesIncludeVat: shop.pricesIncludeVat,
        receiptPrefix: shop.receiptPrefix,
        supervisorDiscountLimitThb: shop.supervisorDiscountLimitThb,
      },
      catalogue: [...catalogueRef.current.values()],
      /*
       * The drawer is written whole, not as an id: a till opened with no network still has
       * to say which shift it is in and what that shift has taken, or the header would have
       * to blank the one figure a cashier reads between bills (ADR 0024).
       */
      shift: shift
        ? {
            id: shift.id,
            initialCashThb: shift.initialCashThb,
            openedAt: shift.openedAt,
            cashSalesThb: shift.cashSalesThb,
            cashPayoutsThb: shift.cashPayoutsThb,
            expectedCashThb: shift.expectedCashThb,
            orderCount: shift.orderCount,
          }
        : null,
      heldBlocks: store.getState().snapshot?.heldBlocks ?? [],
    });
    setOffline(store.getState());
  }, [shop, shift, shiftLoaded, store]);

  /*
   * Reads what the device kept, then learns about the network from the browser.
   *
   * `navigator.onLine` is a hint and not the truth — it reports the last thing the operating
   * system knew — which is why a request that fails to arrive is what actually decides
   * (see `till-store.ts`). What the events are for is the *good* news: a till that was
   * offline must go back to trying the server, and only the browser can tell it.
   */
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | null = null;
    void (async () => {
      release = await acquireTillWriter();
      if (disposed) { release?.(); return; }
      writerRef.current = Boolean(release);
      setWriter(Boolean(release));
      await store.load();
      for (const entry of store.getState().snapshot?.catalogue ?? []) catalogueRef.current.set(entry.productId, entry);
      remember(initialProducts);
      if (typeof navigator !== 'undefined') {
        store.setOnline(navigator.onLine);
      }
      setOffline(store.getState());
    })();

    const sync = (): void => {
      store.setOnline(navigator.onLine);
      setOffline(store.getState());
    };
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      disposed = true;
      writerRef.current = false;
      release?.();
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, [store]);

  // Written after every catalogue read and whenever the drawer or the shop changes, so the
  // device is never more than one page-load out of date about what it can sell.
  useEffect(() => {
    if (!offline?.loaded) {
      return;
    }
    void persistSnapshot().catch(() => { setOffline(store.getState()); setOfflineWarning('เก็บข้อมูลในเครื่องไม่ได้ — ห้ามรับเงินออฟไลน์'); });
  }, [offline?.loaded, products, persistSnapshot]);

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
    useCallback(
      (payload) => {
        let changed: ProductView | null = null;
        setProducts((current) =>
          current.map((product) => {
            if (product.id !== payload.productId) {
              return product;
            }
            changed = {
              ...product,
              stockQty: payload.stockQty,
              reservedQty: payload.reservedQty,
              availableQty: payload.availableQty,
            };
            return changed;
          }),
        );
        // And the device's copy moves with it: a page that went stale offline is a page that
        // prices a shelf the shop has already sold.
        if (changed && store.getState().queue.length === 0 && !syncBusy.current) {
          remember([changed]);
        }
      },
      [remember],
    ),
  );

  const localProducts = useCallback((query: string, category: number | null): ProductView[] => {
    const state = store.getState();
    const sold = tallyOfflineSales(state.queue);
    return (state.snapshot?.catalogue ?? []).filter((entry) => entry.isActive && (!category || entry.categoryId === category) &&
      (!query.trim() || entry.name.toLowerCase().includes(query.trim().toLowerCase()) || entry.barcode?.includes(query.trim())))
      .map((entry) => ({ id: entry.productId, name: entry.name, barcode: entry.barcode ?? null, categoryId: entry.categoryId ?? null,
        categoryName: entry.categoryName ?? null, categoryKey: entry.categoryKey ?? 'default', salePrice: entry.priceThb,
        stockQty: entry.available, reservedQty: 0, availableQty: Math.max(0, offlineSellableQty(entry, sold)),
        offlineSafetyQty: entry.safetyQty, isConsigned: entry.consigned, imageUrl: entry.imageUrl ?? null, isActive: entry.isActive }));
  }, [store]);

  const loadPage = useCallback(
    async (options: {
      search: string;
      categoryId: number | null;
      /** Appends the next page instead of replacing the grid. */
      offset?: number;
    }): Promise<void> => {
      if (store.getState().online === false || store.getState().queue.length > 0) {
        const cached = localProducts(options.search, options.categoryId);
        setProducts(cached); setTotal(cached.length); return;
      }
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
          throw new ApiError('อ่านรายการสินค้าไม่สำเร็จ — ตรวจสิทธิ์หรือรอเซิร์ฟเวอร์ก่อน', response.status, 'CATALOGUE_UNAVAILABLE');
        }
        const body = (await response.json()) as { data: ProductView[] };
        store.setOnline(true);
        setOffline(store.getState());

        setProducts((current) =>
          options.offset && options.offset > 0 ? [...current, ...body.data] : body.data,
        );
        remember(body.data);
        // `X-Total-Count` is how many matched the filter, not how many were sent —
        // it is what the grid footer uses to say "ยังมีอีก N รายการ" instead of the
        // list simply looking finished.
        setTotal(Number(response.headers.get('X-Total-Count') ?? body.data.length));
      } catch (caught) {
        if (!(caught instanceof ApiError)) {
          store.setOnline(false); setOffline(store.getState());
          const cached = localProducts(options.search, options.categoryId);
          setProducts(cached); setTotal(cached.length);
        }
        setError(caught instanceof Error ? caught.message : 'อ่านรายการสินค้าไม่สำเร็จ');
      } finally {
        setLoadingCatalogue(false);
      }
    },
    [store, localProducts, remember],
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
    !busy && offline?.loaded === true && writer && !deviceBusy &&
    (tenderMode === 'promptpay' ? cashDue === 0 : received >= cashDue);

  /*
   * Why the bill cannot be taken yet, in the cashier's own words — null when it can.
   *
   * The pay sheet disables its confirm button rather than hiding it, which is the right
   * choice, but a disabled button that does not say why is one the cashier taps, and taps
   * again, while the customer waits. Two of the reasons are invisible from inside the sheet
   * — the drawer being shut and *this tab* not holding the till lock — because the notices
   * for them sit on the page the sheet is covering. Ordered by what the cashier can act on:
   * the drawer and the lock are theirs; the busy flags belong to the device. A short cash
   * tender is deliberately left out, because the change row already says "ยังไม่พอ".
   */
  const payBlockedReason = canPay
    ? null
    : !shift
      ? 'ยังไม่เปิดลิ้นชัก — เปิดก่อนจึงจะรับชำระเงินได้'
      : !writer
        ? 'เครื่องนี้ไม่ได้สิทธิ์เขียนบิล — ปิดแท็บขายอื่นแล้วเปิดหน้านี้ใหม่'
        : offline?.loaded !== true
          ? 'กำลังเตรียมข้อมูลในเครื่อง — รอสักครู่'
          : deviceBusy || busy
            ? 'กำลังบันทึกบิล — รอสักครู่'
            : null;

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
          imageUrl: product.imageUrl ?? null,
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
        products.find((product) => product.name.toLowerCase() === term.toLowerCase()) ??
        localProducts(term, null).find((product) => product.barcode === term || product.name.toLowerCase() === term.toLowerCase());

      if (local) {
        addProduct(local);
        setSearch('');
        scanInput.current?.focus();
        return;
      }

      if (store.getState().online === false) { setError('ไม่พบสินค้านี้ในแคช — ต่อเน็ตเพื่อโหลดก่อนขาย'); return; }
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
        // A scanned item is a sale the device may have to price with no connection, so it
        // goes into the device's catalogue even if no page ever showed it.
        remember([exact]);
        addProduct(exact);
        setSearch('');
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'ค้นหาสินค้าไม่สำเร็จ');
      } finally {
        scanInput.current?.focus();
      }
    },
    [addProduct, products, remember, store, localProducts],
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

  /**
   * Puts a customer on the open bill.
   *
   * Shared by the phone lookup and the counter enrolment (ADR 0011), because both
   * end in the same state and a second copy of it is where "enrolled somebody and
   * then rang up a sale for nobody" would come from. The search box is emptied
   * because its job is done — the attached customer is shown on their own row
   * above it, and leaving the digits there invites a second search for the person
   * who is already on the bill.
   */
  const attachMember = useCallback((found: TillMember): void => {
    setMember(found);
    setMemberQuery('');
    setMemberError(null);
    setUsePoints(false);
  }, []);

  const findMember = useCallback(async (): Promise<void> => {
    if (store.getState().online === false || store.getState().snapshot?.heldBlocks.length || store.getState().queue.length) {
      setMemberError('ใช้สมาชิกไม่ได้ในโหมดนี้ — ส่งบิลและคืนชุดเลขก่อน'); return;
    }
    setMemberError(null);
    try {
      const found = await apiFetch<TillMember[]>(
        `/api/v1/members?phone=${encodeURIComponent(memberQuery.trim())}`,
      );
      if (found.length === 0) {
        setMemberError('ไม่พบสมาชิกเบอร์นี้');
        return;
      }
      attachMember(found[0]!);
    } catch (caught) {
      setMemberError(caught instanceof Error ? caught.message : 'ค้นหาสมาชิกไม่สำเร็จ');
    }
  }, [attachMember, memberQuery, store]);

  /**
   * Issues a QR for the amount that will be transferred.
   *
   * Called when the cashier chooses พร้อมเพย์, not when they confirm: the customer
   * needs the code on their own screen while the cashier is still finishing the
   * basket, and the intent is what the eventual sale is settled against.
   */
  const startIntent = useCallback(async (): Promise<void> => {
    if (!shift) {
      setIntentError('ต้องเปิดลิ้นชักก่อนออก QR');
      return;
    }

    setIntentBusy(true);
    setIntentError(null);
    try {
      const amountThb = round2(promptpayDue > 0 ? promptpayDue : due);
      const created = await apiPost<PaymentIntentView>('/api/v1/payments/intents', {
        shiftId: shift.id,
        amountThb,
      });
      consumedRef.current = null;
      setIntent(created);
    } catch (caught) {
      setIntentError(
        caught instanceof ApiError ? caught.message : 'ออก QR พร้อมเพย์ไม่สำเร็จ',
      );
    } finally {
      setIntentBusy(false);
    }
  }, [due, promptpayDue, shift]);

  /** Drops the QR: the cashier is taking cash after all. */
  const dropIntent = useCallback(async (): Promise<void> => {
    const current = intent;
    setIntent(null);
    consumedRef.current = null;
    if (!current || current.status !== 'pending') {
      return;
    }
    // Best-effort: a QR that cannot be cancelled still expires on its own, and the
    // customer must not be kept waiting while the till retries a housekeeping call.
    try {
      await apiPost(`/api/v1/payments/intents/${current.ref}/cancel`, {});
    } catch {
      // Ignored on purpose. See above.
    }
  }, [intent]);

  /**
   * A fresh QR for the same amount, replacing the one on screen.
   *
   * A new *intent* rather than a re-render of the old payload, and that choice is the
   * whole reason this button is worth having. The three things that go wrong with a
   * PromptPay code are all about the passage of time: it expires on its own TTL, the
   * customer's banking app refuses a code that is more than a few minutes old, and a
   * customer who closed the sheet and came back finds a dead code and a cashier who
   * has no way to move them forward. Re-drawing the same payload would fix the look of
   * the problem and none of its causes — the countdown would still read zero, because
   * it is derived from the intent's own `expiresAt`.
   *
   * The old reference is cancelled first, deliberately: a live QR for a bill being
   * paid is a QR the next customer can pay, and a replacement that left the first one
   * live would be two payable codes for one basket.
   */
  const refreshIntent = useCallback(async (): Promise<void> => {
    const amountThb = round2(promptpayDue > 0 ? promptpayDue : due);
    setIntentBusy(true);
    setIntentError(null);
    try {
      const current = intent;
      if (current && current.status === 'pending') {
        try {
          await apiPost(`/api/v1/payments/intents/${current.ref}/cancel`, {});
        } catch {
          // Ignored: an old code that refuses to cancel will expire on its own, and
          // holding the cashier up to make sure of it is the worse trade.
        }
      }
      setIntent(null);
      consumedRef.current = null;
      const created = await apiPost<PaymentIntentView>('/api/v1/payments/intents', {
        shiftId: shift?.id ?? 0,
        amountThb,
      });
      setIntent(created);
    } catch (caught) {
      setIntentError(
        caught instanceof ApiError ? caught.message : 'ออก QR ใหม่ไม่สำเร็จ',
      );
    } finally {
      setIntentBusy(false);
    }
  }, [intent, promptpayDue, due, shift]);

  /**
   * Settles the sale against a paid intent, once.
   *
   * The reference is what makes this safe: the server re-reads the intent's own
   * amount rather than trusting anything the client says about the payment, so a
   * tampered request cannot claim a small transfer paid a large bill.
   */
  const settlePaidIntent = useCallback(
    async (paidRef: string): Promise<SaleResult | null> => {
      if (consumedRef.current === paidRef) {
        return null;
      }
      consumedRef.current = paidRef;
      setIntent(null);
      return checkoutRef.current?.(paidRef) ?? null;
    },
    [],
  );

  /**
   * The cashier says the money arrived, and a supervisor agrees.
   *
   * This is the path a shop without a bank bridge has, and until now the till had no
   * way to take it: `waitingForTransfer` removed "ยืนยันรับเงิน" from the sheet and
   * replaced it with a disabled "รอเงินเข้า…", so a cashier who had watched the money
   * land in the banking app had nothing left to press and the bill could not be
   * closed at all. The server already had the endpoint, the audit action and the PIN
   * gate — `POST /api/v1/payments/intents/{ref}/confirm` — so nothing new is trusted
   * here; the till is given a button that reaches work it already had.
   *
   * The approval is bound to the intent's reference, so a supervisor who approved one
   * transfer cannot have that approval spent on a different bill.
   */
  const confirmTransferManually = useCallback(async (): Promise<SaleResult | null> => {
    const current = intent;
    if (!current || current.status !== 'pending' || !requestApproval) {
      return null;
    }

    const token = await requestApproval({
      action: 'manual_payment_confirm',
      targetId: current.ref,
      summary: `ยืนยันว่าโอนแล้ว ${formatThb(current.amountThb)} · รหัสอ้างอิง ${current.ref}`,
    });
    if (!token) {
      return null;
    }

    setIntentBusy(true);
    setIntentError(null);
    try {
      /*
       * `/confirm`, and the suffix is load-bearing. `intents/{ref}` is the read the
       * poll below uses; it exports no POST, so a confirmation posted there is a 405
       * raised by Next before this code runs — a button that looks alive, charges a
       * supervisor's PIN, and does nothing. A shop found that the only way.
       */
      const confirmed = await apiFetch<PaymentIntentView>(
        `/api/v1/payments/intents/${current.ref}/confirm`,
        { method: 'POST', headers: { [APPROVAL_HEADER]: token } },
      );
      if (confirmed.status !== 'paid' && confirmed.status !== 'consumed') {
        setIntentError('ยังยืนยันไม่ได้ — รหัสอ้างอิงนี้อาจหมดอายุแล้ว ลองออก QR ใหม่');
        return null;
      }
      return await settlePaidIntent(confirmed.ref);
    } catch (caught) {
      setIntentError(
        caught instanceof ApiError ? caught.message : 'ยืนยันการโอนไม่สำเร็จ',
      );
      return null;
    } finally {
      setIntentBusy(false);
    }
  }, [intent, requestApproval, settlePaidIntent]);

  /**
   * The money arrived — from the socket, or from the poll.
   *
   * Both paths end here rather than one closing the bill and the other noticing:
   * the socket is fast and the poll is reliable, and a till that trusted only the
   * socket would stop selling the moment the shop's wifi blinked.
   */
  const onIntentPaid = useCallback(
    (paid: PaymentIntentView): void => {
      if (intent === null || paid.ref !== intent.ref || paid.status !== 'paid') {
        return;
      }
      void settlePaidIntent(paid.ref);
    },
    [intent, settlePaidIntent],
  );

  useRealtimeEvent(REALTIME_EVENTS.paymentPaid, onIntentPaid);

  /*
   * The safety net under the socket. Three seconds is a compromise: often enough
   * that a customer does not stand waiting after paying, rare enough that a shop
   * with no bridge and a sleeping tablet is not making a request a second all day.
   */
  useEffect(() => {
    if (!intent || intent.status !== 'pending') {
      return;
    }
    const timer = window.setInterval(() => {
      void apiFetch<PaymentIntentView>(`/api/v1/payments/intents/${intent.ref}`)
        .then((latest) => {
          if (latest.status === 'paid') {
            void settlePaidIntent(latest.ref);
          } else if (latest.status === 'expired') {
            setIntent(latest);
          }
        })
        .catch(() => {
          // A failed poll is not worth reporting: the QR is still on screen, and
          // the next tick tries again.
        });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [intent, settlePaidIntent]);

  /*
   * Every basket change is pushed to the customer display, debounced.
   *
   * Fire-and-forget: a display that misses a snapshot gets the next one, and the
   * till must never refuse a sale because a screen in the corner is unplugged.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void apiPost('/api/v1/pos/display/cart', {
        lines: lines.map((line) => ({
          name: line.name,
          quantity: line.quantity,
          // The line total, not the unit price: the customer reads what the line
          // costs, and the subtotal below is the sum of these. The unit price
          // rides along as well, so the customer can check the multiplication
          // when there is more than one of something.
          totalPrice: round2(line.unitPrice * line.quantity),
          unitPrice: round2(line.unitPrice),
          // The picture on the shelf: what the customer is being charged for has
          // to be the thing the cashier is bagging (ADR 0014).
          imageUrl: line.imageUrl,
        })),
        subtotalThb: subtotal,
        discountThb: round2(discountValue + pointsValue),
        totalThb: due,
        receivedThb: intent ? null : received > 0 ? received : null,
        changeThb: intent ? null : change > 0 ? change : null,
        memberFirstName: member ? firstName(member.fullName) : null,
      }).catch(() => {
        // Ignored: see above.
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [lines, subtotal, discountValue, pointsValue, due, received, change, member, intent]);

  const checkout = useCallback(async (intentRef?: string): Promise<SaleResult | null> => {
    if (!writerRef.current || !store.getState().loaded || syncBusy.current || checkoutBusy.current) { setError('เครื่องนี้ยังไม่พร้อมหรือมีแท็บอื่นเปิดขายอยู่ — ปิดแท็บอื่นแล้วเปิดใหม่'); return null; }
    if (!shift) {
      setError('ต้องเปิดลิ้นชักก่อนรับชำระเงิน');
      return null;
    }
    const deviceState = store.getState();
    if ((deviceState.snapshot?.heldBlocks.length || deviceState.queue.length) && deviceState.snapshot?.shift?.id !== shift.id) {
      setError('ข้อมูลในเครื่องเป็นของกะเดิม — เข้าระบบด้วยบัญชีเดิม ส่งบิลและคืนชุดเลขก่อนขาย');
      return null;
    }
    if (lines.length === 0) {
      setError('ยังไม่มีสินค้าในตะกร้า');
      return null;
    }

    checkoutBusy.current = true;
    setBusy(true);
    setError(null);

    try {
    /*
     * The discount is judged before the sale is attempted, not after it is
     * refused. The server enforces the same limit — this is the prompt, and the
     * server is the rule — but asking first means the cashier hears "ต้องให้
     * ผู้ดูแลอนุมัติ" instead of pricing a basket, being rejected, and then being
     * asked for a PIN with the customer still waiting.
     */
    let approvalToken: string | null = null;
    if (
      deviceState.online !== false && deviceState.queue.length === 0 && (deviceState.snapshot?.heldBlocks.length ?? 0) === 0 &&
      requestApproval &&
      discountLimitThb !== undefined &&
      discountValue > discountLimitThb
    ) {
      approvalToken = await requestApproval({
        action: 'over_discount',
        targetId: discountApprovalTarget(discountValue),
        summary: `ส่วนลด ${formatThb(discountValue)} (เกินวงเงิน ${formatThb(discountLimitThb)})`,
      });
      if (approvalToken === null) {
        setBusy(false);
        return null;
      }
    }

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

      /*
       * The basket as the device judges it, which is a different question from what is
       * sent: the device decides whether it may sell at all with no connection, while the
       * body below is what the server is asked to record. `decideOfflineSale` answers the
       * first, exhaustively and before anything is spent.
       */
      const basket: OfflineBasket = {
        lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        tender: tenderMode === 'cash' ? 'cash' : tenderMode === 'split' ? 'mixed' : 'promptpay',
        memberAttached: member !== null,
        pointsRedeemed: pointsValue,
        discountThb: discountValue,
      };

      if (deviceState.online !== false && deviceState.snapshot?.heldBlocks.length && deviceState.queue.length === 0) {
        // Reads are safe to retry; never translate a server's refusal into a local sale.
        // A changed price needs a new cashier confirmation before money is taken.
        let fresh: ProductView[] = [];
        try { fresh = await Promise.all(lines.map((line) => apiFetch<ProductView>(`/api/v1/products/${line.productId}`))); }
        catch (caught) {
          if (caught instanceof ApiError) throw caught;
          // No write was attempted: safely switch to the already prepared promise.
          store.setOnline(false);
          setOffline(store.getState());
        }
        if (fresh.some((product) => !product.isActive || product.availableQty < (lines.find((line) => line.productId === product.id)?.quantity ?? 0))) throw new Error('สินค้าปิดขายหรือสต็อกไม่พอ — ตรวจตะกร้าก่อนรับเงิน');
        remember(fresh);
        await persistSnapshot();
        const changedPrice = fresh.some((product) => lines.some((line) => line.productId === product.id && line.unitPrice !== product.salePrice));
        if (changedPrice) {
          setLines((current) => current.map((line) => ({ ...line, unitPrice: fresh.find((product) => product.id === line.productId)?.salePrice ?? line.unitPrice })));
          throw new Error('ราคาสินค้าเปลี่ยนแล้ว — ตรวจยอดใหม่และยืนยันรับเงินอีกครั้ง');
        }
      }
      const outcome = await store.sell({
        basket,
        // The cash the cashier entered, or exactly the bill when they entered nothing — the
        // device prices a cash sale and cannot draw a negative change.
        receivedCash: received > 0 ? received : cashDue,
        serverSale: (deviceNumbers) =>
          apiFetch<SaleResult>('/api/v1/orders', {
            method: 'POST',
            body: JSON.stringify({
              type: 'pos_walkin',
              shiftId: shift.id,
              lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
              customerId: member?.id ?? null,
              discountThb: discountValue,
              settlement,
              ...(intentRef ? { intentRef } : {}),
              // The numbers this device printed, when it is holding a borrowed range. Absent
              // on a device that holds nothing, which is the server-allocates path.
              ...(deviceNumbers ? { deviceNumbers } : {}),
            }),
            headers: approvalToken ? { [APPROVAL_HEADER]: approvalToken } : undefined,
          }),
      });

      if (!outcome.ok) {
        // Every reason at once, in the words the rules module wrote: a cashier at a counter
        // fixes a basket rather than reading a stack trace.
        setError(outcome.refusals.map((refusal) => refusal.message).join(' · '));
        return null;
      }

      /*
       * Stamped once, here: `Receipt` defaults to "now", and a re-render while the modal is
       * open must not move the time printed on the document.
       */
      setReceipt({
        ...outcome.receipt,
        orderId: outcome.receipt.orderId ?? null,
        at: new Date().toISOString(),
        offline: outcome.where === 'device',
      });
      setOfflineWarning(
        outcome.warnings.length > 0
          ? outcome.warnings.map((warning) => warning.message).join(' · ')
          : null,
      );
      clearCart();
      setReceivedCash('');
      setSplitPromptpay('');
      setTenderMode('cash');
      consumedRef.current = null;

      setOffline(store.getState());
      if (outcome.where === 'server') {
        await onSold();
        await reload();
      } else {
        /*
         * A device sale changed nothing the server knows about, so there is nothing to
         * reload — and the drawer's figure on screen is the server's, which is now short by
         * the cash in the drawer. The pending notice is the other half of that sum until the
         * queue is sent (phase 4).
         */
        setOffline(store.getState());
        const cached = localProducts(search, categoryId);
        setProducts(cached); setTotal(cached.length);
      }
      scanInput.current?.focus();
      return outcome.receipt as SaleResult;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'ชำระเงินไม่สำเร็จ — ตรวจบิลก่อนรับเงินอีกครั้ง',
      );
      return null;
    } finally {
      checkoutBusy.current = false;
      setBusy(false);
    }
  }, [
    cashDue,
    clearCart,
    categoryId,
    localProducts,
    search,
    requestApproval,
    discountLimitThb,
    remember,
    persistSnapshot,
    discountValue,
    lines,
    member,
    onSold,
    pointsValue,
    promptpayDue,
    received,
    reload,
    shift,
    store,
    tenderMode,
    usePoints,
  ]);

  // Assigned after the fact for the reason given where the ref is declared.
  checkoutRef.current = checkout;

  const sendPending = useCallback(async (manual = true, release = false): Promise<void> => {
    if (!writerRef.current || syncBusy.current || checkoutBusy.current || busy) throw new Error('เครื่องยังไม่พร้อมหรือกำลังรับเงิน — รอก่อนส่งบิลหรือปิดกะ');
    syncBusy.current = true; setDeviceBusy(true);
    try {
      await store.sync(manual, release);
      setOffline(store.getState());
      if (store.getState().queue.length === 0) {
        store.setOnline(true);
        // Seed from the acknowledged conservative stock before refreshing visible rows;
        // otherwise the hook's pre-replay map could add the sold units back on disk.
        catalogueRef.current.clear();
        for (const product of store.getState().snapshot?.catalogue ?? []) catalogueRef.current.set(product.productId, product);
        await onSold(); await reload();
        await persistSnapshot(true);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'ส่งบิลไม่สำเร็จ';
      setOfflineWarning(message); throw caught;
    } finally { setOffline(store.getState()); syncBusy.current = false; setDeviceBusy(false); }
  }, [store, onSold, reload, busy, persistSnapshot]);

  // Keep the device mutex through the server close, not just through replay.
  const closePreparedShift = useCallback(async (close: () => Promise<unknown>): Promise<void> => {
    if (!writerRef.current || syncBusy.current || checkoutBusy.current || busy) throw new Error('หยุดรับเงินและรอเครื่องพร้อมก่อนปิดกะ');
    syncBusy.current = true;
    setDeviceBusy(true);
    try {
      await store.sync(true, true);
      const state = store.getState();
      if (state.queue.length || state.snapshot?.heldBlocks.length) throw new Error('ส่งบิลและคืนชุดเลขให้ครบก่อนปิดกะ');
      await close();
    } finally {
      setOffline(store.getState());
      syncBusy.current = false;
      setDeviceBusy(false);
    }
  }, [store, busy]);

  const prepareOffline = useCallback(async (label: string): Promise<void> => {
    if (!writerRef.current || busy || checkoutBusy.current || syncBusy.current) throw new Error('มีแท็บอื่นเปิดขายอยู่ หรือกำลังรับเงิน');
    syncBusy.current = true;
    setDeviceBusy(true);
    try {
      if (!navigator.onLine || !shiftLoaded || !shift) throw new Error('ต่อเน็ตและเปิดลิ้นชักก่อนเตรียมเครื่อง');
      // Refresh every cached SKU, not only the visible page, before making a stock promise.
      const refreshed: ProductView[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const response = await fetch(`/api/v1/products?limit=${PAGE_SIZE}&offset=${offset}`, { credentials: 'same-origin' });
        if (!response.ok) throw new ApiError('เตรียมรายการสินค้าไม่สำเร็จ — ลองใหม่เมื่อเซิร์ฟเวอร์พร้อม', response.status, 'CATALOGUE_UNAVAILABLE');
        const body = await response.json() as { data: ProductView[] };
        refreshed.push(...body.data);
        const count = Number(response.headers.get('X-Total-Count') ?? body.data.length);
        if (offset + body.data.length >= count || body.data.length === 0) break;
      }
      catalogueRef.current.clear();
      remember(refreshed);
      store.setOnline(true);
      await persistSnapshot(true); await store.prepare(label); setOffline(store.getState());
    } finally { setOffline(store.getState()); syncBusy.current = false; setDeviceBusy(false); }
  }, [store, busy, persistSnapshot, remember, shift, shiftLoaded]);

  useEffect(() => {
    const send = (): void => {
      if (navigator.onLine && writerRef.current && !busy && store.getState().queue.length) void sendPending(false).catch(() => undefined);
    };
    const timer = window.setInterval(send, 10_000);
    window.addEventListener('online', send);
    send();
    return () => { clearInterval(timer); window.removeEventListener('online', send); };
  }, [busy, sendPending, store]);

  return {
    writer, deviceBusy, sendPending, prepareOffline, closePreparedShift,
    markLocalTicket: async (ref: string, state: 'ready' | 'collected') => { await store.markTicket(ref, state); setOffline(store.getState()); },
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
    // PromptPay
    intent,
    intentBusy,
    intentError,
    startIntent,
    dropIntent,
    refreshIntent,
    confirmTransferManually,
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
    attachMember,
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
    /** Set when ยืนยันรับเงิน is disabled for a reason the sheet should say out loud. */
    payBlockedReason,
    // outcome
    busy,
    error,
    setError,
    checkout,
    receipt,
    setReceipt,
    // the device's own state (ADR 0019)
    /** Null until the device has been read. `offlineNotice` turns it into words. */
    offline,
    /** The last sale's warnings — a call number that ran out, numbers that are nearly gone. */
    offlineWarning,
    setOfflineWarning,
  };
}

export type Till = ReturnType<typeof useTill>;
