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
import type { PaymentIntentView } from '@/lib/payment-intents-view';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import type { ProductView } from '@/lib/product-view';
import { APPROVAL_HEADER, discountApprovalTarget } from '@/lib/supervisor-view';
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
  onSold,
  discountLimitThb,
  requestApproval,
}: {
  initialProducts: ProductView[];
  initialTotal: number;
  shift: Shift | null;
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
  }, [attachMember, memberQuery]);

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
          // costs, and the subtotal below is the sum of these.
          totalPrice: round2(line.unitPrice * line.quantity),
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

    /*
     * The discount is judged before the sale is attempted, not after it is
     * refused. The server enforces the same limit — this is the prompt, and the
     * server is the rule — but asking first means the cashier hears "ต้องให้
     * ผู้ดูแลอนุมัติ" instead of pricing a basket, being rejected, and then being
     * asked for a PIN with the customer still waiting.
     */
    let approvalToken: string | null = null;
    if (
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

      const result = await apiFetch<SaleResult>('/api/v1/orders', {
        method: 'POST',
        body: JSON.stringify({
          type: 'pos_walkin',
          shiftId: shift.id,
          lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
          customerId: member?.id ?? null,
          discountThb: discountValue,
          settlement,
          ...(intentRef ? { intentRef } : {}),
        }),
        headers: approvalToken ? { [APPROVAL_HEADER]: approvalToken } : undefined,
      });

      // Stamped once, here: `Receipt` defaults to "now", and a re-render while the
      // modal is open must not move the time printed on the document.
      setReceipt({ ...result, at: new Date().toISOString() });
      clearCart();
      setReceivedCash('');
      setSplitPromptpay('');
      setTenderMode('cash');
      consumedRef.current = null;
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

  // Assigned after the fact for the reason given where the ref is declared.
  checkoutRef.current = checkout;

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
    // PromptPay
    intent,
    intentBusy,
    intentError,
    startIntent,
    dropIntent,
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
