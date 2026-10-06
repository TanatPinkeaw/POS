'use client';

/**
 * The owner's consignment inbox (ADR 0025).
 *
 * A member filled in the shop's form and the answer is now waiting. This component
 * owns the one decision that belongs to a person — *do we take these goods on, and at
 * what share* — and it is the only place in the system where a member's typed words
 * become a product, a shelf and a liability.
 *
 * Three things are deliberate about what it asks and what it will not do:
 *
 *   * **The share is required and typed here.** A form cannot supply a percentage,
 *     because nobody has agreed one yet; the member asked for goods, not for a deal.
 *   * **"จำนวนที่รับจริง" defaults to what the form said but is not forced to be.** Goods
 *     counted at home and goods counted on the counter disagree, and the difference
 *     has to be recordable without rewriting the member's own words — which stay in the
 *     submission, untouched, as the record of what they claimed.
 *   * **A refusal needs a reason and deletes nothing.** The member reads that reason on
 *     their own account, so a refusal with no stated cause is one they answer by
 *     filling the form in again.
 *
 * Photographs are drawn, because deciding whether to take goods on is partly a question
 * of what they look like. Each is a link on somebody else's file host and may fail, so
 * every one is also a link that opens it — the same trade ADR 0014 makes for a pasted
 * product photo.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  Button,
  Card,
  EmptyState,
  FieldRow,
  InlineNotice,
  Money,
  Overlay,
  Stack,
  TextAreaField,
  TextField,
} from '@/components/ds';
import { ApiError, apiPost } from '@/lib/client-api';
import { formatThb } from '@/lib/money';

import styles from './ConsignmentIntake.module.css';

/** One offer, as the server read it. Mirrors `SubmissionView`. */
export interface IntakeRow {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  productName: string;
  offeredPriceThb: number;
  quantity: number;
  notes: string | null;
  consignorUserId: string | null;
  consignorName: string | null;
  consignorPhone: string;
  submittedAt: string;
  decidedSharePercent: number | null;
  decisionNote: string | null;
  decidedAt: string | null;
  productId: string | null;
  documents: {
    id: string;
    kind: 'photo' | 'document';
    label: string;
    url: string;
    imageSrc: string | null;
  }[];
}

export function ConsignmentIntake({ rows }: { rows: IntakeRow[] }) {
  const router = useRouter();
  const [approving, setApproving] = useState<IntakeRow | null>(null);
  const [rejecting, setRejecting] = useState<IntakeRow | null>(null);

  return (
    <Card
      title="คำขอฝากขายจากแบบฟอร์ม"
      subtitle={`รอตรวจสอบ ${rows.length} รายการ — อนุมัติแล้วจะได้สินค้าพร้อมเงื่อนไขฝากขายทันที`}
    >
      <Stack gap="sm">
        {rows.length === 0 ? (
          <EmptyState
            title="ยังไม่มีคำขอที่รอตรวจสอบ"
            description="เมื่อสมาชิกส่งแบบฟอร์มฝากขายของร้าน รายการจะมาที่นี่"
          />
        ) : (
          <ul className={styles.list}>
            {rows.map((row) => (
              <li key={row.id} className={styles.item}>
                <div className={styles.head}>
                  <div>
                    <p className={styles.name}>{row.productName}</p>
                    <p className={styles.meta}>
                      {row.consignorName ??
                        `ยังไม่ตรงกับสมาชิก (${row.consignorPhone})`}
                      {' · '}
                      {row.quantity} ชิ้น
                      {' · '}
                      <Money amount={row.offeredPriceThb} size="sm" />
                    </p>
                  </div>
                  <div className={styles.actions}>
                    <Button icon="check" onClick={() => setApproving(row)}>
                      อนุมัติ
                    </Button>
                    <Button variant="secondary" onClick={() => setRejecting(row)}>
                      ตักเติน
                    </Button>
                  </div>
                </div>

                {row.consignorUserId === null ? (
                  <InlineNotice tone="warning">
                    เบอร์โทรในแบบฟอร์มไม่ตรงกับบัญชีใด ต้องเลือกสมาชิกผู้ฝากขายตอนกดอนุมัติ
                  </InlineNotice>
                ) : null}

                {row.notes ? <p className={styles.notes}>{row.notes}</p> : null}

                {row.documents.length > 0 ? (
                  <ul className={styles.documents}>
                    {row.documents.map((document) => (
                      <li key={document.id}>
                        <a
                          className={styles.document}
                          href={document.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {document.imageSrc !== null ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              className={styles.photo}
                              src={document.imageSrc}
                              alt={document.label}
                              loading="lazy"
                              decoding="async"
                              referrerPolicy="no-referrer"
                            />
                          ) : null}
                          <span>{document.label}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Stack>

      <ApprovalDialog
        row={approving}
        onClose={() => setApproving(null)}
        onDone={() => {
          setApproving(null);
          router.refresh();
        }}
      />
      <RejectionDialog
        row={rejecting}
        onClose={() => setRejecting(null)}
        onDone={() => {
          setRejecting(null);
          router.refresh();
        }}
      />
    </Card>
  );
}

/**
 * The approval dialog: take the goods on, at a share, for a quantity actually counted.
 *
 * Everything the server can default is shown pre-filled from the member's own words,
 * and the two fields it cannot default — the share, and the consignor when the phone
 * matched nobody — are the ones that must be typed. That split is the screen's whole
 * argument: the owner is being asked for the decisions only an owner can make, and
 * is not being asked to retype what the member already told them.
 */
function ApprovalDialog({
  row,
  onClose,
  onDone,
}: {
  row: IntakeRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [sharePercent, setSharePercent] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [receivedQty, setReceivedQty] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The drafts are re-seeded from the row on every open, so a dialog left half-filled
  // for one offer cannot be completed against the next one.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (row !== null && seededFor !== row.id) {
    setSeededFor(row.id);
    setSharePercent('');
    setSalePrice(String(row.offeredPriceThb));
    setReceivedQty(String(row.quantity));
    setNote('');
    setError(null);
  }
  if (row === null && seededFor !== null) {
    setSeededFor(null);
  }

  const share = Number(sharePercent);
  const shareValid = sharePercent !== '' && Number.isInteger(share) && share >= 0 && share <= 100;
  const price = Number(salePrice);
  const priceValid = salePrice !== '' && Number.isFinite(price) && price >= 0;
  const qty = Number(receivedQty);
  const qtyValid = receivedQty !== '' && Number.isInteger(qty) && qty > 0;
  // The one case where the server cannot proceed: nobody owns these goods yet.
  const needsConsignor = row !== null && row.consignorUserId === null;

  async function submit(): Promise<void> {
    if (row === null) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/v1/consignment-submissions/${row.id}/approve`, {
        sharePercent: share,
        salePriceThb: price,
        receivedQty: qty,
        note: note.trim() ? note.trim() : null,
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'อนุมัติไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Overlay
      open={row !== null}
      onClose={onClose}
      title={row ? `อนุมัติ ${row.productName}` : ''}
      description={
        row
          ? `ส่งมาโดย ${row.consignorName ?? row.consignorPhone} · ${row.quantity} ชิ้น · ราคาที่เสนอ ${formatThb(row.offeredPriceThb)}`
          : ''
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            ยกเลิก
          </Button>
          <Button
            icon="check"
            loading={saving}
            disabled={!shareValid || !priceValid || !qtyValid || needsConsignor}
            onClick={() => void submit()}
          >
            อนุมัติเป็นสินค้า
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

        {needsConsignor ? (
          <InlineNotice tone="warning">
            เบอร์โทรในแบบฟอร์มไม่ตรงกับบัญชีใด — ให้สมาชิกส่งแบบฟอร์มใหม่ด้วยเบอร์ที่ใช้จริงก่อน
          </InlineNotice>
        ) : null}

        <TextField
          id="intake-share"
          label="ส่วนแบ่งของผู้ฝากขาย (%)"
          help="ส่วนแบ่งคิดจากยอดสุทธิ (ไม่รวม VAT) ของที่ขายได้ — ต้องตกลงกันก่อน"
          inputMode="numeric"
          value={sharePercent}
          onChange={(event) => setSharePercent(event.target.value)}
        />
        <FieldRow columns={2}>
          <TextField
            id="intake-price"
            label="ราคาขาย"
            help="แก้ได้ถ้าตกลงกันคนละราคา"
            inputMode="decimal"
            value={salePrice}
            onChange={(event) => setSalePrice(event.target.value)}
          />
          <TextField
            id="intake-qty"
            label="จำนวนที่รับจริง"
            help="นับที่หน้าร้าน อาจไม่ตรงกับที่ส่งมา"
            inputMode="numeric"
            value={receivedQty}
            onChange={(event) => setReceivedQty(event.target.value)}
          />
        </FieldRow>
        <TextAreaField
          id="intake-note"
          label="หมายเหตุ"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Stack>
    </Overlay>
  );
}

/**
 * The refusal dialog. One field, required.
 *
 * The button stays disabled while it is empty rather than failing on submit: the note
 * is not decoration here, it is the thing the member will read instead of a refusal,
 * and there is no version of this dialog where it is optional.
 */
function RejectionDialog({
  row,
  onClose,
  onDone,
}: {
  row: IntakeRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  if (row !== null && seededFor !== row.id) {
    setSeededFor(row.id);
    setNote('');
    setError(null);
  }
  if (row === null && seededFor !== null) {
    setSeededFor(null);
  }

  async function submit(): Promise<void> {
    if (row === null) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/v1/consignment-submissions/${row.id}/reject`, { note: note.trim() });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ปฏิเสธไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Overlay
      open={row !== null}
      onClose={onClose}
      title={row ? `ตักเติน ${row.productName}` : ''}
      description="สมาชิกจะเห็นเหตุผลนี้ในหน้าบัญชีของตัวเอง และคำขอจะยังอยู่ในประวัติ"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            ยกเลิก
          </Button>
          <Button
            variant="danger"
            loading={saving}
            disabled={note.trim() === ''}
            onClick={() => void submit()}
          >
            ตักเตินคำขอ
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        <TextAreaField
          id="intake-reject-note"
          label="เหตุผลที่ปฏิเสธ"
          help="บอกให้ชัดว่าจะแก้อะไรได้ เช่น ราคาไม่ตรงที่ตกลง หรือยังไม่ได้เปิดรับ"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Stack>
    </Overlay>
  );
}
