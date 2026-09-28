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
 *
 * The whole reversal — stock, points, drawer, audit — happens server-side in one
 * transaction. This component sends one request and believes nothing until it
 * answers.
 */
import { useEffect, useState } from 'react';

import { Button, InlineNotice, Money, Overlay, SelectField, Stack, TextField, useToast } from '@/components/ds';
import { APPROVAL_HEADER } from '@/lib/supervisor-view';
import { ApiError, apiFetch } from '@/lib/client-api';
import type { CreditNoteDocument, RefundMethod, RefundSummary } from '@/lib/credit-note-view';
import { REFUND_METHODS } from '@/lib/credit-note-view';
import { formatThb } from '@/lib/money';
import type { ShopView } from '@/lib/shop-view';

import { CreditNote } from './CreditNote';
import { SupervisorApprovalDialog } from './SupervisorApprovalDialog';
import { useSupervisorApproval } from './useSupervisorApproval';

export interface RefundTarget {
  orderId: string;
  orderNumber: string;
  /** What will be handed back, read off the sale. Not editable: full amount only. */
  amountThb: number;
  /** How many lines go back on the shelf, so the operator knows what to expect. */
  lineCount: number;
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
        summary: `คืนเงินบิล ${target.orderNumber} · ${formatThb(target.amountThb)}`,
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
            <Button variant="danger" loading={busy} onClick={() => void submit()}>
              ยืนยันคืนเงิน {formatThb(target.amountThb)}
            </Button>
          </>
        }
      >
        <Stack gap="md">
          <InlineNotice tone="warning" title="การคืนเงินย้อนกลับทั้งบิล">
            ระบบจะคืนสินค้าทั้ง {target.lineCount} รายการเข้าสต็อก
            และออกใบลดหนี้ให้บิลนี้ทั้งจำนวน — คืนบางรายการยังทำไม่ได้
          </InlineNotice>

          <div>
            <span>ยอดที่คืน</span>
            <strong>
              <Money amount={target.amountThb} />
            </strong>
          </div>

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
