/**
 * Would a customer actually be told? (ADR 0035)
 *
 * Five doors, one row each, and every row says what its state means rather than showing a
 * tick. The screen exists because the failure it reports is silence: the "order ready"
 * planner returns null when a condition is missing, so nothing is queued, nothing fails,
 * and no other screen in this system can tell the difference between "the customer was
 * not told" and "there was nothing to tell".
 *
 * **Read from the process, not from `.env`.** The values arrive from the server component
 * that renders this, which reads `process.env` — so after an edit the panel shows the
 * environment the server is actually using, and `npm run line:wizard` shows the file. When
 * they disagree, the shop has edited `.env` and not restarted, which is exactly the state
 * a second, independent reader is worth having.
 *
 * The component holds no rules: every state and sentence comes from
 * `src/lib/line-readiness.ts`, and every number from `readNoticeAudience` /
 * `outboxHealth`. It renders, and that is all.
 */
import { Card, InlineNotice, Pill, Stack } from '@/components/ds';
import type { NoticeAudience } from '@/lib/line-audience';
import type { LineDoorState, LineDoorStatus } from '@/lib/line-readiness';

import styles from './LineReadinessPanel.module.css';

const STATE_LABEL: Record<LineDoorState, string> = {
  ready: 'พร้อม',
  // "ยังไม่ครบ" rather than "ผิดพลาด": half-configured is usually a missing step, and a
  // word that reads like a fault makes an operator look for a bug instead of a setting.
  blocked: 'ยังไม่ครบ',
  off: 'ยังไม่เปิด',
};

const STATE_TONE: Record<LineDoorState, 'success' | 'danger' | 'neutral'> = {
  ready: 'success',
  blocked: 'danger',
  off: 'neutral',
};

export function LineReadinessPanel({
  doors,
  audience,
  outbox,
  stalled,
}: {
  doors: LineDoorStatus[];
  audience: NoticeAudience;
  outbox: { pending: number; dueNow: number; abandoned: number };
  /** From `outboxStalled` — the dashboard's own rule, so the two cards cannot disagree. */
  stalled: { stalled: boolean; waitingMinutes: number | null };
}) {
  const friendGap = audience.consented - audience.reachable;

  return (
    <Card
      title="ข้อความถึงลูกค้า"
      subtitle="ตรวจจากค่าที่เซิร์ฟเวอร์กำลังใช้อยู่ — ถ้าเพิ่งแก้ .env ต้องรีสตาร์ตก่อน ตัวเลขนี้จึงจะเปลี่ยน"
    >
      <Stack gap="md">
        {/*
          The one alarm on this panel. A worker that never started leaves rows `pending`
          forever, so the dashboard's "ส่งไม่ออก" card never appears — there is no gateway
          left to refuse anything. This is the only place that state is visible.
        */}
        {stalled.stalled ? (
          <InlineNotice tone="danger" title="ข้อความค้างส่ง — ไม่มีใครรับไปส่ง">
            มี {outbox.dueNow} ข้อความถึงกำหนดแล้ว
            {stalled.waitingMinutes === null
              ? ''
              : ` ค้างนานสุด ${stalled.waitingMinutes} นาที`}
            {' '}— ตรวจว่า worker ทำงานอยู่:{' '}
            <code className="ln-mono">sudo systemctl enable --now pos-notify</code>
          </InlineNotice>
        ) : null}

        <ul className={styles.doors}>
          {doors.map((door) => (
            <li className={styles.door} key={door.id}>
              <div className={styles.doorHead}>
                <Pill tone={STATE_TONE[door.state]}>{STATE_LABEL[door.state]}</Pill>
                <span className={styles.doorTitle}>{door.title}</span>
              </div>
              <p className={styles.sentence}>{door.sentence}</p>
            </li>
          ))}
        </ul>

        <dl className={styles.numbers}>
          <div className={styles.number}>
            <dt className={styles.label}>ลูกค้าที่ผูก LINE</dt>
            <dd className={styles.value}>{audience.bound} คน</dd>
          </div>
          <div className={styles.number}>
            <dt className={styles.label}>ยินยอมรับแจ้งเตือน</dt>
            <dd className={styles.value}>{audience.consented} คน</dd>
          </div>
          <div className={styles.number}>
            <dt className={styles.label}>ส่งถึงได้จริง</dt>
            <dd className={styles.value}>{audience.reachable} คน</dd>
          </div>
          <div className={styles.number}>
            <dt className={styles.label}>ในคิว / ถึงกำหนด</dt>
            <dd className={styles.value}>
              {outbox.pending} / {outbox.dueNow}
            </dd>
          </div>
        </dl>

        {/*
          The gap between "agreed" and "reachable" is always the friend step, and it is the
          one thing a shop can act on at the counter: `line_friends` only fills from LINE's
          own follow event, so no setting here can manufacture it.
        */}
        {friendGap > 0 ? (
          <p className={styles.hint}>
            อีก {friendGap} คนยินยอมแล้วแต่ยังไม่ได้เพิ่มเพื่อนร้านใน LINE — ข้อความจะไม่ถึงจนกว่า
            จะกดเพิ่มเพื่อน (LINE ไม่ส่งข้อความถึงคนที่ไม่ได้เป็นเพื่อน)
          </p>
        ) : null}

        {audience.bound === 0 ? (
          <p className={styles.hint}>
            ยังไม่มีลูกค้าผูกบัญชี LINE — ข้อความถึงลูกค้าจะยังไม่ออกจนกว่าจะมีคนผูกบัญชีที่
            หน้าบัญชีของลูกค้า
          </p>
        ) : null}
      </Stack>
    </Card>
  );
}
