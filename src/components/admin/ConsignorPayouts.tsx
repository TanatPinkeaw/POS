'use client';

/**
 * Paying a consignor, from the admin's screen (ADR 0023 §6).
 *
 * The list is loaded on the server so the screen arrives with the balances rather than
 * a spinner. What this component owns is the one decision that matters at the counter:
 * the amount, and which door the money goes out of. A cash payout has to name an open
 * drawer, so the admin picks from the drawers that are actually open — a drawer the
 * server would refuse is not offered here, because a button that always fails is worse
 * than a button that is not there.
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import {
  Button,
  Card,
  DataTable,
  FieldRow,
  InlineNotice,
  LinkButton,
  Money,
  Overlay,
  SelectField,
  TextField,
  type Column,
} from '@/components/ds';
import { ApiError, apiPost } from '@/lib/client-api';
import { PAYOUT_METHODS, type PayoutMethod } from '@/lib/consignment-payout-view';
import { formatThb } from '@/lib/money';

export interface ConsignorRow {
  id: string;
  fullName: string;
  phone: string;
  balanceThb: number;
  lastPaidOn: string | null;
}

export interface OpenDrawer {
  id: number;
  label: string;
}

interface PayoutResponse {
  payoutId: string;
  amountThb: number;
}

export function ConsignorPayouts({
  rows,
  openDrawers,
}: {
  rows: readonly ConsignorRow[];
  openDrawers: readonly OpenDrawer[];
}) {
  const router = useRouter();
  const [target, setTarget] = useState<ConsignorRow | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PayoutMethod>('promptpay');
  const [shiftId, setShiftId] = useState<number | null>(openDrawers[0]?.id ?? null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    message: string;
    payoutId: string;
    consignorId: string;
  } | null>(null);

  const amountThb = Number(amount);
  const cashNeedsDrawer = method === 'cash' && openDrawers.length === 0;
  const amountValid = Number.isFinite(amountThb) && amountThb > 0 && amountThb <= (target?.balanceThb ?? 0);

  const columns: Column<ConsignorRow>[] = useMemo(
    () => [
      {
        key: 'name',
        header: 'ผู้ฝากขาย',
        render: (row) => (
          <>
            <strong>{row.fullName}</strong>
            <span className="ln-muted">{row.phone}</span>
          </>
        ),
      },
      {
        key: 'balance',
        header: 'ยอดค้างจ่าย',
        align: 'end',
        render: (row) => <Money amount={row.balanceThb} />,
      },
      {
        key: 'lastPaid',
        header: 'จ่ายล่าสุด',
        align: 'end',
        render: (row) => row.lastPaidOn ?? '—',
      },
      {
        key: 'actions',
        header: '',
        align: 'end',
        render: (row) => (
          <div className="ln-row">
            <LinkButton
              href={`/admin/consignors?consignor=${row.id}`}
              size="sm"
              variant="ghost"
              icon="eye"
            >
              ดูบัญชี
            </LinkButton>
            <Button
              size="sm"
              icon="cash"
              disabled={row.balanceThb <= 0}
              onClick={() => {
                setTarget(row);
                setAmount(String(row.balanceThb));
                setMethod('promptpay');
                setShiftId(openDrawers[0]?.id ?? null);
                setNote('');
                setError(null);
              }}
            >
              จ่ายเงิน
            </Button>
          </div>
        ),
      },
    ],
    [openDrawers],
  );

  async function submit(): Promise<void> {
    if (!target) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await apiPost<PayoutResponse>(`/api/v1/consignors/${target.id}/payouts`, {
        amountThb,
        method,
        shiftId: method === 'cash' ? shiftId : null,
        note: note.trim() ? note.trim() : null,
      });
      setReceipt({
        message: `จ่าย ${formatThb(result.amountThb)} ให้ ${target.fullName} เรียบร้อย`,
        payoutId: result.payoutId,
        consignorId: target.id,
      });
      setTarget(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'จ่ายเงินไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="ผู้ฝากขายและยอดค้างจ่าย"
      subtitle="ยอดคือผลรวมบัญชีเจ้าหนี้ฝากขาย — จ่ายออกได้จากลิ้นชักที่เปิดอยู่ หรือโอนผ่านแอปธนาคาร"
      flush
    >
      {receipt ? (
        <InlineNotice
          tone="success"
          title={receipt.message}
          actions={
            <LinkButton
              href={`/admin/consignors?consignor=${receipt.consignorId}&statement=${receipt.payoutId}`}
              size="sm"
            >
              ดูใบสำคัญ
            </LinkButton>
          }
        />
      ) : null}

      <DataTable
        columns={columns}
        rows={[...rows]}
        getRowKey={(row) => row.id}
        caption="ผู้ฝากขายที่มียอดค้างจ่ายหรือเคยจ่ายแล้ว"
        empty={null}
      />

      <Overlay
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? `จ่ายเงินให้ ${target.fullName}` : ''}
        description={
          target ? `ยอดค้างจ่าย ${formatThb(target.balanceThb)} · จ่ายเท่าที่ตกลงกันได้ (ไม่เกินยอดค้าง)` : ''
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setTarget(null)} disabled={saving}>
              ยกเลิก
            </Button>
            <Button
              icon="check"
              loading={saving}
              disabled={!amountValid || cashNeedsDrawer}
              onClick={() => void submit()}
            >
              ยืนยันจ่ายเงิน
            </Button>
          </>
        }
      >
        <FieldRow columns={2}>
          <TextField
            id="payout-amount"
            label="จำนวนเงิน (บาท)"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            error={amount !== '' && !amountValid ? 'ต้องมากกว่าศูนย์และไม่เกินยอดค้างจ่าย' : undefined}
          />
          <SelectField
            id="payout-method"
            label="ช่องทางจ่าย"
            value={method}
            onChange={(event) => setMethod(event.target.value as PayoutMethod)}
          >
            {PAYOUT_METHODS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        </FieldRow>

        {method === 'cash' ? (
          cashNeedsDrawer ? (
            <InlineNotice tone="warning" title="ยังไม่มีลิ้นชักที่เปิดอยู่">
              เปิดกะก่อนจึงจะจ่ายเงินสดได้ หรือเลือกโอนผ่านแอปธนาคาร
            </InlineNotice>
          ) : (
            <SelectField
              id="payout-shift"
              label="ลิ้นชักที่จ่ายออก"
              value={shiftId ?? ''}
              onChange={(event) => setShiftId(Number(event.target.value))}
              help="เงินสดต้องออกจากลิ้นชักที่เปิดอยู่ เพื่อให้ปิดกะแล้วกระทบพอดี"
            >
              {openDrawers.map((drawer) => (
                <option key={drawer.id} value={drawer.id}>
                  {drawer.label}
                </option>
              ))}
            </SelectField>
          )
        ) : null}

        <TextField
          id="payout-note"
          label="บันทึก (ไม่บังคับ)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          help="เช่น เลขอ้างอิงการโอน หรือรอบที่จ่าย"
        />

        {error ? <InlineNotice tone="danger" title={error} /> : null}
      </Overlay>
    </Card>
  );
}
