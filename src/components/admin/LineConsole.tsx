'use client';

/**
 * The shop's LINE console (ADR 0032 §8): compose, review, send, and repair.
 *
 * Three panels of one question — what may this shop send, what does it cost, and what did it
 * actually send — and they are on one screen deliberately. The consent that decides who is
 * reachable, the month's allowance that decides what can be paid for, and the record of what
 * went out are the same decision seen three ways; a shop reading them on three screens would
 * be able to answer each and none of them together.
 *
 * The component holds no rules. The audience, its exclusions, the batch count, the cost and
 * affordability all arrive from the server (`line-campaign-rules.ts`, `line-campaigns.ts`) or
 * are re-derived from the same pure functions, so the number under the compose box and the
 * number the route refuses on cannot disagree. What lives here is the form, the confirmation,
 * and the two repairs a person performs: requeue an abandoned message, and write a failed
 * campaign again.
 *
 * **Nothing is sent optimistically**, and the confirmation is not decoration: a campaign goes
 * to every reachable customer at once, spends one message per recipient of a 300-a-month
 * allowance, and cannot be taken back. The dialog states both numbers before the button.
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FieldRow,
  InlineNotice,
  Money,
  Pill,
  Stack,
  TextAreaField,
  TextField,
  Thumb,
  type Column,
} from '@/components/ds';
import { apiPost } from '@/lib/client-api';
import { probeImageUrl } from '@/lib/image-url';
import { campaignAffordable, planCampaignBatches } from '@/lib/line-campaign-rules';
import { linePromoBlockSentence, type LinePromoBlock } from '@/lib/line-promo-consent';
import type { LineQuota } from '@/lib/line-quota';

/** One campaign as the history table reads it — timestamps already in Bangkok time. */
export interface LineCampaignRow {
  id: string;
  body: string;
  imageUrl: string | null;
  status: 'pending' | 'sent' | 'partial' | 'failed';
  recipientCount: number;
  quotaRemainingAtSend: number | null;
  failureReason: string | null;
  sentAt: string;
  sentByName: string | null;
}

/** One message the shop's own outbox gave up on. */
export interface LineOutboxRow {
  id: string;
  kind: string;
  recipient: string;
  lastError: string | null;
  attempts: number;
}

/** What the send route answers, refusal included — a 200 either way, by design. */
interface CampaignResponse {
  ok: boolean;
  reason?: string;
  message?: string;
  cost?: number;
  remaining?: number | null;
  batches?: number;
}

/** What each campaign status is called, since a shop reads Thai and `partial` is the point. */
const STATUS_LABEL: Record<LineCampaignRow['status'], string> = {
  pending: 'รอส่ง',
  sent: 'ส่งแล้ว',
  partial: 'ส่งไม่ครบ',
  failed: 'ส่งไม่สำเร็จ',
};

const STATUS_TONE: Record<LineCampaignRow['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  pending: 'neutral',
  sent: 'success',
  // The one state a shop must be able to see: some customers got it and some did not.
  partial: 'warning',
  failed: 'danger',
};

/** The reasons the audience excludes somebody, in the order the audience lists them. */
const BLOCK_ORDER: LinePromoBlock[] = [
  'never_asked',
  'withdrawn',
  'not_a_friend',
  'not_bound',
  'channel_not_line',
];

export function LineConsole({
  lineConfigured,
  liffConfigured,
  recipients,
  excluded,
  friendCount,
  quota,
  quotaError,
  initialCampaigns,
  initialOutbox,
}: {
  lineConfigured: boolean;
  liffConfigured: boolean;
  recipients: number;
  excluded: Record<string, number>;
  friendCount: number;
  quota: LineQuota | null;
  quotaError: string | null;
  initialCampaigns: LineCampaignRow[];
  initialOutbox: LineOutboxRow[];
}) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [imageError, setImageError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(
    null,
  );

  const cost = recipients;
  const batches = useMemo(() => planCampaignBatches(Array.from({ length: cost })).length, [cost]);
  const affordable = campaignAffordable(quota?.remaining ?? null, cost);
  const canSend = lineConfigured && cost > 0 && body.trim().length > 0 && affordable;

  /** Why the send button is disabled, said rather than left to be inferred (rule 3). */
  const blockedReason = !lineConfigured
    ? 'ร้านนี้ยังไม่ได้ตั้งค่าช่องทาง LINE — ตั้งค่า NOTIFY_CHANNEL=line พร้อมโทเคนของช่องทางก่อน'
    : cost === 0
      ? 'ยังไม่มีลูกค้าที่รับโปรโมชันได้ — ต้องผูกบัญชี LINE เพิ่มเพื่อนร้าน และกดยินยอมรับโปรโมชัน'
      : !affordable
        ? `โควตาข้อความเดือนนี้เหลือ ${quota?.remaining ?? 0} ข้อความ ไม่พอสำหรับ ${cost} รายชื่อ`
        : body.trim().length === 0
          ? 'เขียนข้อความก่อนส่ง'
          : null;

  async function send(): Promise<void> {
    setSending(true);
    setNotice(null);
    try {
      const result = await apiPost<CampaignResponse>('/api/v1/admin/line/campaigns', {
        body,
        imageUrl: imageUrl.trim() || null,
      });
      if (!result.ok) {
        setNotice({ tone: 'warning', text: result.message ?? 'ส่งไม่สำเร็จ' });
        return;
      }
      setNotice({
        tone: 'success',
        text: `บันทึกแคมเปญแล้ว — รอรอบถัดไปของตัวส่งส่งข้อความ (${result.batches ?? batches} ชุด สูงสุด ${cost} คน)`,
      });
      setBody('');
      setImageUrl('');
      setImageError(null);
      router.refresh();
    } catch (error) {
      setNotice({
        tone: 'danger',
        text: error instanceof Error ? error.message : 'ส่งไม่สำเร็จ',
      });
    } finally {
      setSending(false);
      setConfirming(false);
    }
  }

  /** Checks the link with the same reader a product photo goes through (ADR 0014). */
  async function checkImage(): Promise<boolean> {
    const candidate = imageUrl.trim();
    if (candidate === '') {
      setImageError(null);
      return true;
    }
    setChecking(true);
    const probe = await probeImageUrl(candidate);
    setChecking(false);
    if (!probe.ok) {
      setImageError(probe.message ?? 'เปิดลิงก์รูปนี้ไม่ได้');
      return false;
    }
    setImageError(null);
    return true;
  }

  async function requeue(row: LineOutboxRow): Promise<void> {
    setBusyId(row.id);
    setNotice(null);
    try {
      await apiPost(`/api/v1/admin/line/notifications/${row.id}/requeue`, {});
      setNotice({ tone: 'success', text: 'ตั้งให้ส่งข้อความนี้อีกครั้งแล้ว' });
      router.refresh();
    } catch (error) {
      setNotice({
        tone: 'warning',
        text: error instanceof Error ? error.message : 'ส่งซ้ำไม่สำเร็จ',
      });
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<LineCampaignRow>[] = [
    {
      key: 'sentAt',
      header: 'เมื่อ',
      cardLabel: 'เมื่อ',
      render: (row) => <span className="ln-num ln-muted">{row.sentAt}</span>,
    },
    {
      key: 'body',
      header: 'ข้อความ',
      cardLabel: 'ข้อความ',
      render: (row) => (
        <span className="ln-row">
          <Thumb url={row.imageUrl} size="sm" />
          <span>{row.body}</span>
        </span>
      ),
    },
    {
      key: 'recipients',
      header: 'ผู้รับ',
      cardLabel: 'ผู้รับ',
      align: 'end',
      render: (row) => <span className="ln-num ln-mono">{row.recipientCount}</span>,
    },
    {
      key: 'status',
      header: 'สถานะ',
      cardLabel: 'สถานะ',
      render: (row) => (
        <Pill tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Pill>
      ),
    },
    {
      key: 'by',
      header: 'ผู้ส่ง',
      cardLabel: 'ผู้ส่ง',
      render: (row) => (
        <span className="ln-muted">
          {row.sentByName ?? 'ไม่ทราบ'}
          {row.quotaRemainingAtSend !== null ? (
            <span className="ln-num"> · โควตาตอนส่งเหลือ {row.quotaRemainingAtSend}</span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <Stack gap="lg">
      {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}

      <Card
        title="ตั้งค่าที่เกี่ยวข้อง"
        subtitle="สองอย่างนี้ต้องเปิดไว้ก่อน ส่งแล้วจึงจะถึงลูกค้า"
      >
        <Stack gap="sm">
          <p>
            ช่องทาง LINE:{' '}
            {lineConfigured ? (
              <Pill tone="success">ตั้งค่าแล้ว</Pill>
            ) : (
              <Pill tone="danger">ยังไม่ได้ตั้งค่า</Pill>
            )}
          </p>
          <p>
            ลิงก์เปิดร้านใน LINE (LIFF):{' '}
            {liffConfigured ? (
              <Pill tone="success">ตั้งค่าแล้ว</Pill>
            ) : (
              <Pill tone="neutral">ยังไม่ได้ตั้งค่า</Pill>
            )}
            {liffConfigured ? null : (
              <span className="ln-muted">
                {' '}
                — ข้อความ &quot;พร้อมรับ&quot; จะยังไม่มีลิงก์เปิดในแอป (ไม่มีก็ยังส่งข้อความได้)
              </span>
            )}
          </p>
          <p className="ln-muted">
            เพื่อนของร้านใน LINE ทั้งหมด {friendCount} คน — แต่ส่งโปรโมชันได้เฉพาะคนที่ยินยอมแล้ว
          </p>
        </Stack>
      </Card>

      <Card
        title="ส่งโปรโมชัน"
        subtitle="ข้อความจะถูกส่งโดยตัวส่งข้อความของร้าน (npm run notify:worker) ไม่ได้ส่งทันทีที่กด"
      >
        <Stack gap="md">
          <TextAreaField
            id="campaign-body"
            label="ข้อความ"
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            help="เขียนสั้น ๆ ตรงประเด็น เพราะการส่งหนึ่งครั้งกินโควตาข้อความ 1 ข้อความต่อลูกค้าหนึ่งคน"
          />

          <FieldRow columns={2}>
            <TextField
              id="campaign-image"
              label="ลิงก์รูป (ไม่บังคับ)"
              inputMode="url"
              value={imageUrl}
              onChange={(event) => {
                setImageUrl(event.target.value);
                setImageError(null);
              }}
              onBlur={() => void checkImage()}
              error={imageError ?? undefined}
              help="ใส่ลิงก์รูป หรือลิงก์แชร์ของ Nextcloud — ระบบจะเปิดลิงก์ให้ดูก่อนส่ง"
            />
            <div>
              <Thumb url={imageUrl.trim() || null} size="lg" />
            </div>
          </FieldRow>

          <Stack gap="sm">
            <p>
              ผู้รับที่จะได้รับจริง{' '}
              <strong className="ln-num ln-mono">{cost.toLocaleString('en-US')}</strong> คน ·
              คิดเป็น <Money amount={cost} /> ของโควตาข้อความ · จะส่งเป็น{' '}
              <strong className="ln-num ln-mono">{batches}</strong> ชุด (ไม่เกิน 500 คนต่อชุด)
            </p>
            {quota === null ? (
              <InlineNotice tone="warning">
                {quotaError ?? 'ยังอ่านโควตาจาก LINE ไม่ได้'}
              </InlineNotice>
            ) : quota.limited ? (
              <InlineNotice tone={affordable ? 'info' : 'danger'}>
                โควตาข้อความเดือนนี้เหลือ {quota.remaining ?? 0} จาก {quota.limit ?? 0} ข้อความ
                (ใช้ไปแล้ว {quota.consumed}) — LINE เป็นผู้อนุมัติจริงอีกชั้น
                หากยอดในคอนโซลไม่ตรงกัน
              </InlineNotice>
            ) : (
              <InlineNotice tone="info">
                ช่องทางนี้ไม่มีเพดานจำนวนข้อความต่อเดือน — LINE เป็นผู้อนุมัติจริงอีกชั้น
              </InlineNotice>
            )}
            {blockedReason ? <InlineNotice tone="warning">{blockedReason}</InlineNotice> : null}
          </Stack>

          <div>
            <Button
              icon="chat"
              disabled={!canSend || checking}
              loading={checking}
              onClick={() => setConfirming(true)}
            >
              ตรวจรายชื่อและส่ง
            </Button>
          </div>
        </Stack>
      </Card>

      <Card
        title="ทำไมบางคนไม่ได้รับ"
        subtitle="นับตามเหตุผล — ยอดนี้คือจำนวนลูกค้าที่ระบบยังส่งโปรโมชันให้ไม่ได้"
      >
        {Object.keys(excluded).length === 0 ? (
          <p className="ln-muted">ไม่มีลูกค้าที่ถูกตัดออก</p>
        ) : (
          <Stack gap="sm">
            {BLOCK_ORDER.filter((block) => (excluded[block] ?? 0) > 0).map((block) => (
              <p key={block}>
                <strong className="ln-num ln-mono">{excluded[block]}</strong> คน —{' '}
                {linePromoBlockSentence(block)}
              </p>
            ))}
          </Stack>
        )}
      </Card>

      <Card title="ประวัติการส่ง" subtitle="แคมเปญที่ร้านส่งไปแล้ว เรียงจากใหม่ไปเก่า" flush>
        <DataTable
          columns={columns}
          rows={initialCampaigns}
          getRowKey={(row) => row.id}
          caption="ประวัติการส่งโปรโมชันทาง LINE"
          empty={
            <EmptyState
              icon="chat"
              title="ยังไม่เคยส่งโปรโมชัน"
              description="เขียนข้อความด้านบนแล้วกดตรวจรายชื่อ — ระบบจะบอกจำนวนคนและโควตาที่จะใช้ก่อนส่งจริง"
            />
          }
        />
      </Card>

      <Card
        title="ข้อความที่ส่งไม่ออก"
        subtitle="ข้อความที่ระบบลองส่งจนครบจำนวนครั้งแล้วยังไม่สำเร็จ — แก้สาเหตุแล้วกดส่งซ้ำได้"
        flush
      >
        {initialOutbox.length === 0 ? (
          <p className="ln-muted">
            ไม่มีข้อความที่ค้างส่ง
          </p>
        ) : (
          <Stack gap="md">
            {initialOutbox.map((row) => (
              <Stack gap="sm" key={row.id}>
                <p>
                  <Pill tone="danger">{row.kind}</Pill>{' '}
                  <span className="ln-mono">{row.recipient}</span>{' '}
                  <span className="ln-muted">ลองแล้ว {row.attempts} ครั้ง</span>
                </p>
                <p className="ln-muted ln-text-sm">{row.lastError ?? 'ไม่ทราบสาเหตุ'}</p>
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="refresh"
                    loading={busyId === row.id}
                    onClick={() => void requeue(row)}
                  >
                    ส่งซ้ำ
                  </Button>
                </div>
              </Stack>
            ))}
          </Stack>
        )}
      </Card>

      <ConfirmDialog
        open={confirming}
        tone="primary"
        title="ยืนยันส่งโปรโมชัน?"
        confirmLabel="ส่งเลย"
        busy={sending}
        description="ส่งแล้วเรียกคืนไม่ได้ — ตรวจข้อความและจำนวนผู้รับอีกครั้งก่อนกด"
        onConfirm={() => void send()}
        onCancel={() => setConfirming(false)}
      >
        <Stack gap="sm">
          <p>
            จะส่งถึง <strong className="ln-num ln-mono">{cost.toLocaleString('en-US')}</strong>{' '}
            คน · ใช้โควตา <Money amount={cost} /> · แบ่งเป็น {batches} ชุด
          </p>
          <p className="ln-muted">{body.trim() || '(ยังไม่ได้เขียนข้อความ)'}</p>
          {imageUrl.trim() ? <Thumb url={imageUrl.trim()} size="md" /> : null}
        </Stack>
      </ConfirmDialog>
    </Stack>
  );
}
