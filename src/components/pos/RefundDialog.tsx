'use client';

/**
 * Refunding a bill, and the credit note that comes out of it.
 *
 * Three things this screen has to get right, and each one is a decision rather
 * than a layout:
 *
 *   * **The supervisor approves, not the cashier.** A refund always asks for a
 *     PIN, whatever the operator's role, and the approval is bound to this order
 *     id — which is what stops an approved refund of a ฿30 bill being spent on a
 *     ฿3,000 one, because the amount comes from the order rather than from the
 *     request.
 *   * **Where the money comes from is chosen, not inferred.** Cash out of the
 *     open drawer is the default and the only option that changes what the
 *     drawer should hold at close; returning a transfer by hand in the shop's
 *     banking app touches no drawer at all. The drawer is read on open so the
 *     operator sees which of the two is actually available rather than finding
 *     out from a refusal.
 *   * **The document is shown, not just announced.** A refund that ends with a
 *     toast leaves the cashier with nothing to hand the customer. The credit note
 *     is fetched and rendered here, printable, immediately after it is issued.
 *   * **The amount is previewed with the server's own arithmetic.** A customer
 *     returning one item out of three has to be told what they get back *before*
 *     the cashier hands it over, and the figure depends on the line's share of the
 *     order-level discount. So the preview calls the same pure function the
 *     transaction calls (`refund-plan.ts`) rather than a second implementation
 *     that could disagree with it at the counter.
 *
 * The whole reversal — stock, points, drawer, audit — happens server-side in one
 * transaction. This component sends one request and believes nothing until it
 * answers.
 */
import { useEffect, useMemo, useState } from 'react';

import {
  Button,
  InlineNotice,
  Money,
  Overlay,
  Pill,
  SelectField,
  Stack,
  TextField,
  useToast,
} from '@/components/ds';
import { APPROVAL_HEADER } from '@/lib/supervisor-view';
import { ApiError, apiFetch } from '@/lib/client-api';
import type { CreditNoteDocument, RefundMethod, RefundSummary } from '@/lib/credit-note-view';
import { REFUND_METHODS } from '@/lib/credit-note-view';
import { formatThb } from '@/lib/money';
import { planRefund, type RefundableLine } from '@/lib/refund-plan';
import type { ShopView } from '@/lib/shop-view';

import styles from './RefundDialog.module.css';

import { CreditNote } from './CreditNote';
import { SupervisorApprovalDialog } from './SupervisorApprovalDialog';
import { useSupervisorApproval } from './useSupervisorApproval';

export interface RefundTarget {
  orderId: string;
  orderNumber: string;
  /** What will be handed back if nothing is deselected. A starting figure only. */
  amountThb: number;
  /** How many lines go back on the shelf, so the operator knows what to expect. */
  lineCount: number;
}

/**
 * The sale, as the refund sheet needs it.
 *
 * Fetched here rather than passed in because every caller already has an order id
 * and only the refund dialog needs the line-level detail — including how much of
 * each line has already gone back, which is what makes a second visit to the same
 * bill safe.
 */
interface RefundableOrder {
  orderNumber: string;
  subtotalThb: number;
  discountThb: number;
  finalAmountThb: number;
  refundedThb: number;
  items: {
    id: string;
    name: string;
    quantity: number;
    refundedQuantity: number;
    totalPrice: number;
  }[];
}

interface CreditNotePayload {
  shop: ShopView;
  creditNote: CreditNoteDocument;
}

export function RefundDialog({
  target,
  onClose,
  onRefunded,
}: {
  target: RefundTarget;
  onClose: () => void;
  /** Called after the refund commits, so a list behind this can reload. */
  onRefunded?: (summary: RefundSummary) => void;
}) {
  const toast = useToast();
  const approval = useSupervisorApproval();

  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<RefundMethod>('cash');
  const [shiftId, setShiftId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [document, setDocument] = useState<CreditNotePayload | null>(null);
  const [order, setOrder] = useState<RefundableOrder | null>(null);
  /** How many units of each line the cashier is taking back, by order item id. */
  const [taking, setTaking] = useState<Record<string, number>>({});

  /*
   * The sale itself, and the default answer: everything that is left. A full refund
   * is still one button — the per-line steppers only matter to the cashier whose
   * customer is standing there with two of the three items.
   */
  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const loaded = await apiFetch<RefundableOrder>(`/api/v1/orders/${target.orderId}`);
        if (!live) {
          return;
        }
        setOrder(loaded);
        setTaking(
          Object.fromEntries(
            loaded.items
              .map((item) => [item.id, item.quantity - item.refundedQuantity] as const)
              .filter(([, remaining]) => remaining > 0),
          ),
        );
      } catch (caught) {
        if (live) {
          setError(
            caught instanceof ApiError ? caught.message : 'โหลดรายการของบิลนี้ไม่สำเร็จ',
          );
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [target.orderId]);

  /*
   * The preview, computed by the function the server will use. `null` when the
   * arithmetic refuses the selection — which is the same refusal the transaction
   * would raise, so the button can be disabled for the same reason.
   */
  const preview = useMemo(() => {
    if (!order) {
      return null;
    }

    const lines: RefundableLine[] = order.items.map((item) => ({
      orderItemId: item.id,
      name: item.name,
      quantity: item.quantity,
      returnedQuantity: item.refundedQuantity,
      totalPrice: item.totalPrice,
    }));
    const requested = Object.entries(taking)
      .filter(([, quantity]) => quantity > 0)
      .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));

    try {
      return planRefund({
        lines,
        requested: requested.length === 0 ? null : requested,
        subtotalThb: order.subtotalThb,
        discountThb: order.discountThb,
        finalAmountThb: order.finalAmountThb,
        alreadyRefundedThb: order.refundedThb,
      });
    } catch {
      return null;
    }
  }, [order, taking]);

  /*
   * The drawer decides which method is even possible, and asking is cheaper than
   * letting the operator pick cash and be told no by the server. A failure here
   * leaves the form as it was rather than blocking the refund: the server checks
   * the same thing again and its refusal is the authoritative one.
   */
  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const current = await apiFetch<{ shift: { id: number } | null }>('/api/v1/shifts/current');
        if (!live) {
          return;
        }
        setShiftId(current.shift?.id ?? null);
        if (!current.shift) {
          setMethod('promptpay');
        }
      } catch {
        // Left as-is: cash with no shift id, which the server refuses with a
        // message written for a human rather than for a log.
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  async function submit(): Promise<void> {
    if (reason.trim().length === 0) {
      setError('บอกเหตุผลการคืนเงินก่อน — เหตุผลคือสิ่งที่จะอยู่ในบันทึกการใช้งาน');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const token = await approval.request({
        action: 'refund_order',
        targetId: target.orderId,
        summary: `คืนเงินบิล ${target.orderNumber} · ${formatThb(refundAmountThb)}`,
      });
      if (token === null) {
        // The supervisor walked away, which is a refusal rather than a failure.
        setBusy(false);
        return;
      }

      const summary = await apiFetch<RefundSummary>(`/api/v1/orders/${target.orderId}/refund`, {
        method: 'POST',
        headers: { [APPROVAL_HEADER]: token },
        body: JSON.stringify({
          reason: reason.trim(),
          refundMethod: method,
          shiftId,
          /*
           * Every line, including the ones at zero, because "take back none of
           * this" is a statement the server can check against what is left while
           * an omission is not.
           */
          lines: takingLines,
        }),
      });

      const issued = await apiFetch<CreditNotePayload>(
        `/api/v1/orders/${target.orderId}/credit-note`,
      );
      setDocument(issued);

      toast.show({
        title: `คืนเงินแล้ว · ${summary.documentNumber}`,
        body:
          summary.pointsForgiven > 0
            ? `คืนสินค้า ${summary.returnedUnits} ชิ้น · ยึดคืนคะแนนไม่ได้ ${summary.pointsForgiven} แต้ม`
            : `คืนสินค้า ${summary.returnedUnits} ชิ้น`,
        tone: 'success',
      });
      onRefunded?.(summary);
    } catch (caught) {
      /*
       * `NO_OPEN_SHIFT` and a locked PIN are the two refusals an operator can act
       * on, and both arrive with their own Thai message — so the message is shown
       * as written rather than replaced with a generic one.
       */
      const message =
        caught instanceof ApiError ? caught.message : 'คืนเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
      setError(message);
      toast.show({ title: 'คืนเงินไม่สำเร็จ', body: message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const noDrawer = shiftId === null;

  /** What the selected lines come to, or the sale's whole remaining total. */
  const refundAmountThb = preview?.refundThb ?? target.amountThb;
  const takingLines = Object.entries(taking).map(([orderItemId, quantity]) => ({
    orderItemId,
    quantity,
  }));
  const returnedUnits = preview?.returnedUnits ?? 0;
  const isPartial = preview !== null && !preview.closes;

  return (
    <>
      <Overlay
        open={document === null}
        onClose={busy ? () => undefined : onClose}
        title="คืนเงินและออกใบลดหนี้"
        description={`บิล ${target.orderNumber}`}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              ยกเลิก
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={preview === null}
              onClick={() => void submit()}
            >
              ยืนยันคืนเงิน {formatThb(refundAmountThb)}
              {returnedUnits > 0 ? ` · ${returnedUnits} ชิ้น` : ''}
            </Button>
          </>
        }
      >
        <Stack gap="md">
          {order && order.refundedThb > 0 ? (
            <InlineNotice tone="info" title="บิลนี้เคยคืนเงินไปแล้วบางส่วน">
              คืนไปแล้ว {formatThb(order.refundedThb)} — เลือกได้เฉพาะส่วนที่เหลือ
            </InlineNotice>
          ) : null}

          {/*
            The lines, with what is left of each. Steppers rather than checkboxes
            because a line can come back in part: three sold, one returned, two to
            go. The defaults are everything outstanding, so a full refund — the
            common case — is still a single button.
          */}
          {order ? (
            <ul className={styles.lines}>
              {order.items.map((item) => {
                const remaining = item.quantity - item.refundedQuantity;
                const chosen = taking[item.id] ?? 0;

                return (
                  <li className={styles.line} key={item.id} data-exhausted={remaining === 0}>
                    <span className="ln-break">
                      {item.name}
                      {item.refundedQuantity > 0 ? (
                        <span className={styles.meta}>
                          {' '}
                          · คืนไปแล้ว {item.refundedQuantity}/{item.quantity}
                        </span>
                      ) : null}
                    </span>

                    {remaining === 0 ? (
                      <Pill tone="neutral">คืนครบแล้ว</Pill>
                    ) : (
                      <span className={styles.stepper}>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`ลดจำนวน ${item.name}`}
                          disabled={chosen <= 0}
                          onClick={() =>
                            setTaking((current) => ({ ...current, [item.id]: chosen - 1 }))
                          }
                        >
                          −
                        </Button>
                        <span className={styles.count}>
                          {chosen}/{remaining}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`เพิ่มจำนวน ${item.name}`}
                          disabled={chosen >= remaining}
                          onClick={() =>
                            setTaking((current) => ({ ...current, [item.id]: chosen + 1 }))
                          }
                        >
                          +
                        </Button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}

          <div className={styles.total}>
            <span>{isPartial ? 'คืนเงินเฉพาะรายการที่เลือก' : 'คืนเงินทั้งบิล'}</span>
            <strong>
              <Money amount={refundAmountThb} size="lg" />
            </strong>
          </div>

          {preview === null ? (
            <InlineNotice tone="warning">
              เลือกอย่างน้อยหนึ่งรายการก่อน — ยอดที่คืนต้องมากกว่าศูนย์
            </InlineNotice>
          ) : null}

          <SelectField
            id="refund-method"
            label="วิธีคืนเงิน"
            value={method}
            help={
              noDrawer
                ? 'ตอนนี้ไม่มีลิ้นชักเปิดอยู่ จึงคืนเป็นเงินสดไม่ได้'
                : 'เงินสดจะหักจากลิ้นชักที่เปิดอยู่ตอนปิดกะ'
            }
            onChange={(event) => setMethod(event.target.value as RefundMethod)}
          >
            {REFUND_METHODS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.value === 'cash' && noDrawer}
              >
                {option.label} — {option.help}
              </option>
            ))}
          </SelectField>

          <TextField
            id="refund-reason"
            label="เหตุผลการคืนเงิน"
            value={reason}
            maxLength={500}
            placeholder="เช่น ลูกค้าแจ้งว่าสินค้าชำรุด / คิดเงินผิด"
            help="บันทึกไว้ในใบลดหนี้และในบันทึกการใช้งาน"
            onChange={(event) => setReason(event.target.value)}
          />

          {error ? <InlineNotice tone="danger" title="คืนเงินไม่สำเร็จ">{error}</InlineNotice> : null}
        </Stack>
      </Overlay>

      {/* Rendered after the form so the PIN question is the thing seen next. */}
      {approval.pending ? (
        <SupervisorApprovalDialog
          open
          action={approval.pending.action}
          targetId={approval.pending.targetId}
          {...(approval.pending.summary === undefined
            ? {}
            : { summary: approval.pending.summary })}
          onCancel={() => approval.pending?.settle(null)}
          onApproved={(grant) => approval.pending?.settle(grant)}
        />
      ) : null}

      <Overlay
        open={document !== null}
        onClose={onClose}
        title={document ? `ใบลดหนี้ ${document.creditNote.documentNumber}` : ''}
        footer={
          <div className="ln-no-print">
            <Button variant="secondary" icon="print" onClick={() => window.print()}>
              พิมพ์ใบลดหนี้
            </Button>
            <Button variant="primary" onClick={onClose}>
              ปิด
            </Button>
          </div>
        }
      >
        {document ? <CreditNote shop={document.shop} data={document.creditNote} /> : null}
      </Overlay>
    </>
  );
}
