'use client';

/**
 * Writing off money that is not a sale of ours.
 *
 * The reason is the point of the screen rather than a formality: whoever explains
 * this to the shop's bank, or to an accountant a year from now, has only what was
 * written here. So it is required, it is capped at something somebody would
 * actually type, and it is sent before anything else is.
 *
 * The amount is shown back in the confirmation, because the one mistake worth
 * preventing here is dismissing the ฿3,000 transfer while reading the ฿30 row.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, InlineNotice, Overlay, Stack, TextField, useToast } from '@/components/ds';
import { ApiError, apiPost } from '@/lib/client-api';
import type { InboundTransferView } from '@/lib/inbound-transfer-view';
import { formatThb } from '@/lib/money';

export function InboundDismissButton({
  transfer,
  label = 'ปิดรายการ',
}: {
  transfer: InboundTransferView;
  /** The row and the dialog want different words for the same action. */
  label?: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountLabel =
    transfer.amountThb === null ? 'ยอดที่อ่านไม่ได้' : formatThb(transfer.amountThb);

  async function submit(): Promise<void> {
    if (reason.trim().length === 0) {
      setError('บอกเหตุผลก่อน — เหตุผลคือสิ่งที่จะอยู่ในบันทึกการใช้งาน');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/v1/payments/inbound/${transfer.id}/dismiss`, {
        reason: reason.trim(),
      });
      toast.show({
        title: 'ปิดรายการแล้ว',
        body: `${amountLabel} — ไม่นับเป็นยอดขาย และบันทึกไว้ในบันทึกการใช้งาน`,
        tone: 'success',
      });
      setOpen(false);
      /*
       * The list behind this is server-rendered and has just lost a row. A refresh
       * is how a server component is told to re-read; reloading the page would
       * take the owner away from whatever else they were looking at.
       */
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ปิดรายการไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>

      <Overlay
        open={open}
        onClose={busy ? () => undefined : () => setOpen(false)}
        title="เงินโอนนี้ไม่ใช่ยอดขายของร้าน?"
        description={amountLabel}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void submit()}>
              ยืนยันปิดรายการ
            </Button>
          </>
        }
      >
        <Stack gap="md">
          <InlineNotice tone="warning" title="ระบบจะจำว่าไม่ต้องถามอีก">
            เงินยังอยู่ที่เดิมในบัญชีธนาคาร — รายการนี้แค่หยุดรอให้ใครมาจับคู่กับบิล
            สิ่งที่บันทึกคือเหตุผลและชื่อผู้ปิด
          </InlineNotice>

          <div>
            <span>ข้อความจากธนาคาร</span>
            <p className="ln-mono">{transfer.rawText.trim() || '—'}</p>
          </div>

          <TextField
            id={`dismiss-reason-${transfer.id}`}
            label="เหตุผล"
            value={reason}
            maxLength={300}
            placeholder="เช่น โอนเข้าผิดบัญชี / เงินกู้ยืม ไม่ใช่ยอดขาย"
            help="บันทึกไว้ในบันทึกการใช้งาน พร้อมชื่อผู้ปิดและเวลาที่ปิด"
            onChange={(event) => setReason(event.target.value)}
          />

          {error ? (
            <InlineNotice tone="danger" title="ปิดรายการไม่สำเร็จ">
              {error}
            </InlineNotice>
          ) : null}
        </Stack>
      </Overlay>
    </>
  );
}
