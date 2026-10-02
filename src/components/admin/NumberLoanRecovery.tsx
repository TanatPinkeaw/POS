'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, InlineNotice, Overlay, Stack, TextField, ToggleField } from '@/components/ds';
import { apiPost } from '@/lib/client-api';

export interface NumberLoanView {
  id: string;
  deviceLabel: string;
  kind: 'receipt' | 'queue';
  day: string | null;
  from: number;
  to: number;
  lastUsed: number | null;
}

/** Never infer the last printed number from the server: unsent paper may exist. */
export function NumberLoanRecovery({ loan }: { loan: NumberLoanView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lastUsed, setLastUsed] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function release(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/v1/pos/number-blocks/${loan.id}`, {
        ...(lastUsed.trim() === '' ? { action: 'cancel' } : { action: 'report', lastUsed: Number(lastUsed) }),
        evidenceConfirmed: confirmed,
      });
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'คืนชุดเลขไม่สำเร็จ');
    } finally { setBusy(false); }
  }

  return <>
    <Button variant="secondary" size="sm" onClick={() => { setConfirmed(false); setError(null); setOpen(true); }}>ตรวจและคืนชุดเลข</Button>
    <Overlay open={open} onClose={() => { if (!busy) setOpen(false); }} title="กู้คืนชุดเลขที่เครื่องถืออยู่"
      description={`${loan.deviceLabel} · ${loan.kind === 'receipt' ? 'ใบกำกับภาษี' : `คิว ${loan.day}`} · ${loan.from}–${loan.to}`}
      footer={<Button variant="danger" loading={busy} disabled={!confirmed} onClick={() => void release()}>ยืนยันคืนชุดเลข</Button>}>
      <Stack gap="md">
        <InlineNotice tone="danger">ใช้เฉพาะเครื่องที่กลับมาส่งบิลไม่ได้ หยุดขายบนเครื่องนั้นก่อน ตรวจใบที่พิมพ์จริงทุกใบ ไม่ใช่ดูเพียงเลขล่าสุดในเซิร์ฟเวอร์ การคืนเลขไม่บันทึกยอดเงินหรือสินค้าของบิลที่หาย ต้องกระทบยอดแยกต่างหาก ห้ามล้างข้อมูลเครื่องที่ยังส่งบิลได้</InlineNotice>
        <p>เซิร์ฟเวอร์บันทึกใช้ถึง {loan.lastUsed ?? 'ยังไม่ใช้'} แต่เครื่องอาจมีบิลค้างที่ร้านยังไม่ทราบ</p>
        <TextField id={`loan-last-${loan.id}`} label="เลขล่าสุดที่พิมพ์จริง" inputMode="numeric" value={lastUsed}
          onChange={(event) => setLastUsed(event.target.value)} help="เว้นว่างเฉพาะเมื่อตรวจแล้วว่าไม่เคยพิมพ์เลขจากชุดนี้" />
        <ToggleField id={`loan-evidence-${loan.id}`} label="ตรวจเอกสารจริงและหยุดขายบนเครื่องเดิมแล้ว" checked={confirmed} onChange={setConfirmed} />
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      </Stack>
    </Overlay>
  </>;
}
