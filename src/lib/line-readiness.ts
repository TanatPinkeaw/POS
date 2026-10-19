/**
 * Which LINE doors this deployment has, and what each one is missing (ADR 0035).
 *
 * The shop's "order ready" message has five conditions, and four of them are
 * configuration. Nothing throws when one is absent — the planner returns null and the
 * outbox never hears about the order — so the failure is *silence*, and a screen that
 * only shows what was sent cannot show it. This module is the answer to "would a
 * customer be told today", computed from the environment alone.
 *
 * Two readers share it, and that is the point: `npm run line:wizard` prints it on the
 * box from `.env`, and `/admin/line` renders it from the running process's environment.
 * A second copy of the rule is how the wizard came to say "push ลูกค้า: พร้อม" from a
 * token and a secret while the message itself was gated on `NOTIFY_CHANNEL=line`
 * ([orders.ts](../../src/lib/orders.ts) — `notifyConfig.channel === 'line'`). The two
 * now disagree only when the environment genuinely differs, and that disagreement is
 * itself the finding: the wizard reads the file, the process holds what it read at
 * boot.
 *
 * **Why three states rather than a boolean.** "Not configured" and "half configured"
 * are different facts about a shop. A shop that never set LINE up is fine — the code
 * stays on the customer's order screen. A shop that set the token but not the channel
 * believes it is sending, and is not: that is the state worth a red mark, and calling
 * both of them "off" is how it stayed invisible.
 *
 * Pure: no I/O, no clock of its own, no Prisma. The caller reads `.env` or `process.env`
 * and passes it in.
 */
import { readNotifyConfig } from './notify-message';

/** The doors LINE opens for this system, named as the code names them. */
export type LineDoorId = 'customer_push' | 'webhook' | 'sign_in' | 'liff_entry' | 'campaigns';

/**
 * `ready` every value present; `blocked` some present and at least one missing — the
 * dangerous state; `off` none present, a door this shop has not opened.
 *
 * Deliberately not `optional`: "optional" says something about policy, and this module
 * only knows what is configured. The screen decides how loudly to say `off`.
 */
export type LineDoorState = 'ready' | 'blocked' | 'off';

export interface LineDoorStatus {
  id: LineDoorId;
  /** The door's name in the words a shop uses, since both readers print it. */
  title: string;
  state: LineDoorState;
  /**
   * The environment keys that are absent, in the order they should be set. `NOTIFY_CHANNEL`
   * carries its required value (`NOTIFY_CHANNEL=line`) because "set it" is not the
   * instruction and "set it to line" is.
   */
  missing: string[];
  /** One sentence: what the current state means for the shop, never a bare status. */
  sentence: string;
}

/** One required value, and how to tell whether the environment has it. */
interface Requirement {
  /** What a screen prints when it is absent — the exact thing to set. */
  label: string;
  present: (env: Record<string, string | undefined>) => boolean;
}

interface DoorDefinition {
  id: LineDoorId;
  title: string;
  requires: readonly Requirement[];
  /** Said when every value is present. */
  ready: string;
  /** Said when some are present; receives what is missing. */
  blocked: (missing: string[]) => string;
  /** Said when none are present. */
  off: string;
}

/** A value is present when it has non-space content; a blank line in `.env` is unset. */
function has(env: Record<string, string | undefined>, key: string): boolean {
  const value = env[key]?.trim();
  return value !== undefined && value.length > 0;
}

/*
 * The order is the answer to the question a shop actually asks — "will my customer be
 * told?" — so the customer's door comes first, then the two it depends on, and the
 * optional ones after them.
 */
const DOORS: readonly DoorDefinition[] = [
  {
    id: 'customer_push',
    title: 'แจ้งเตือนลูกค้า “พร้อมรับ”',
    requires: [
      /*
       * The value, not the key: `NOTIFY_CHANNEL` decides where the shop's *own* alerts
       * go, and `webhook` is a perfectly good answer for that question — which is what
       * makes this the one requirement people get wrong. `orders.ts` reads the same
       * value before it plans the customer's message.
       */
      { label: 'NOTIFY_CHANNEL=line', present: (env) => readNotifyConfig(env).channel === 'line' },
      { label: 'NOTIFY_LINE_TOKEN', present: (env) => has(env, 'NOTIFY_LINE_TOKEN') },
      /*
       * Not because the push needs it — the token is enough to send — but because the
       * friend list does. `line_friends` is written by the webhook, so without the
       * channel secret no customer is ever a friend, and `lineCustomerNotifyBlock`
       * refuses every message at the last condition. A shop with one but not the other
       * sends nothing and cannot see why.
       */
      {
        label: 'LINE_MESSAGING_CHANNEL_SECRET',
        present: (env) => has(env, 'LINE_MESSAGING_CHANNEL_SECRET'),
      },
    ],
    ready: 'ลูกค้าที่ผูกบัญชี ยินยอม และเพิ่มเพื่อนร้าน จะได้ข้อความพร้อมรับพร้อมรหัสรับของทาง LINE ของตัวเอง',
    blocked: (missing) =>
      `ข้อความ “พร้อมรับ” จะไม่ออกทาง LINE จนกว่าจะตั้ง ${missing.join(' และ ')} — ลูกค้าเห็นรหัสที่หน้าออเดอร์ของตัวเองเท่านั้น`,
    off: 'ยังไม่ได้ตั้งค่าข้อความถึงลูกค้า — ลูกค้าเห็นรหัสรับของที่หน้าออเดอร์ของตัวเองเท่านั้น',
  },
  {
    id: 'webhook',
    title: 'รับข้อความและเหตุการณ์จาก LINE',
    requires: [
      {
        label: 'LINE_MESSAGING_CHANNEL_SECRET',
        present: (env) => has(env, 'LINE_MESSAGING_CHANNEL_SECRET'),
      },
      { label: 'NOTIFY_LINE_TOKEN', present: (env) => has(env, 'NOTIFY_LINE_TOKEN') },
    ],
    ready: 'LINE ส่งข้อความของลูกค้าเข้ามาได้ — และการเพิ่ม/ลบเพื่อนร้านถูกบันทึกไว้',
    blocked: (missing) =>
      `LINE จะส่งเหตุการณ์เข้ามาไม่ได้จนกว่าจะตั้ง ${missing.join(' และ ')} — ข้อความของลูกค้าและการเป็นเพื่อนจะไม่ถูกบันทึก`,
    off: 'ยังไม่ได้เชื่อม webhook — ข้อความที่ลูกค้าส่งใน LINE จะไม่เข้าระบบ',
  },
  {
    id: 'sign_in',
    title: 'เข้าสู่ระบบ / ผูกบัญชีด้วย LINE',
    requires: [
      { label: 'LINE_LOGIN_CHANNEL_ID', present: (env) => has(env, 'LINE_LOGIN_CHANNEL_ID') },
      { label: 'LINE_LOGIN_CHANNEL_SECRET', present: (env) => has(env, 'LINE_LOGIN_CHANNEL_SECRET') },
    ],
    ready: 'ลูกค้าเข้าสู่ระบบและผูกบัญชีด้วย LINE ได้ — และรับแจ้งเตือนที่บัญชีของตัวเอง',
    blocked: (missing) =>
      `ปุ่ม LINE ที่หน้าแรกจะยังไม่ทำงานจนกว่าจะตั้ง ${missing.join(' และ ')}`,
    off: 'ยังไม่ได้เปิดประตู LINE Login — ลูกค้ายังใช้เบอร์โทรหรือ Google เข้าได้ตามปกติ',
  },
  {
    id: 'liff_entry',
    title: 'ทางเข้าในแอป LINE (/line)',
    requires: [{ label: 'LINE_LIFF_ID', present: (env) => has(env, 'LINE_LIFF_ID') }],
    ready: 'ลิงก์ในข้อความเปิดร้านในแอป LINE ได้ — ลูกค้าไม่ต้องหาเพจร้านเอง',
    blocked: () => 'ลิงก์ในแอปยังใช้ไม่ได้',
    off: 'ยังไม่ได้ตั้ง LINE_LIFF_ID — ข้อความยังส่งได้ แต่จะไม่มีลิงก์เปิดร้านในแอป',
  },
  {
    id: 'campaigns',
    title: 'ส่งโปรโมชัน (แคมเปญ)',
    requires: [
      { label: 'NOTIFY_LINE_TOKEN', present: (env) => has(env, 'NOTIFY_LINE_TOKEN') },
      /*
       * Again the friend list: the audience is consented **and** friended, so without the
       * webhook's secret every campaign plans zero recipients. The old wizard said "ส่งได้
       * แต่ยังนับผู้รับไม่ได้", which reads like a partial success and is not one.
       */
      {
        label: 'LINE_MESSAGING_CHANNEL_SECRET',
        present: (env) => has(env, 'LINE_MESSAGING_CHANNEL_SECRET'),
      },
    ],
    ready: 'ส่งโปรโมชันถึงลูกค้าที่ผูกบัญชี เพิ่มเพื่อนร้าน และยินยอมรับโปรโมชันได้',
    blocked: (missing) =>
      `ส่งโปรโมชันไม่ได้จนกว่าจะตั้ง ${missing.join(' และ ')} — รายชื่อผู้รับจะว่าง`,
    off: 'ยังไม่ได้ตั้งค่าส่งโปรโมชัน — ลูกค้ายังได้รับการแจ้งเตือนออเดอร์ตามปกติ',
  },
];

/**
 * Every door, in the order a shop should read them.
 *
 * The state is derived, not declared: `ready` when nothing is missing, `off` when nothing
 * is present, `blocked` for everything between. A door with one requirement therefore has
 * no blocked state, which is correct — one value is either there or it is not.
 */
export function lineReadiness(
  env: Record<string, string | undefined> = process.env,
): LineDoorStatus[] {
  return DOORS.map((door) => {
    const missing = door.requires.filter((rule) => !rule.present(env)).map((rule) => rule.label);
    const present = door.requires.length - missing.length;
    const state: LineDoorState = missing.length === 0 ? 'ready' : present === 0 ? 'off' : 'blocked';

    return {
      id: door.id,
      title: door.title,
      state,
      missing,
      sentence:
        state === 'ready' ? door.ready : state === 'off' ? door.off : door.blocked(missing),
    };
  });
}

/** The door a counter question is about, so a screen does not have to search by string. */
export function customerPushDoor(
  env: Record<string, string | undefined> = process.env,
): LineDoorStatus {
  return lineReadiness(env).find((door) => door.id === 'customer_push') as LineDoorStatus;
}

/**
 * How long a due message may sit unclaimed before the worker is called absent.
 *
 * Ten minutes against a worker that passes every thirty seconds: a single busy pass
 * cannot reach it, so the answer means "nothing is draining the queue" rather than
 * "the queue is busy". The number is here rather than in a screen because the dashboard
 * and any future `notify:check` must not disagree about what "stalled" means.
 */
export const OUTBOX_STALL_MINUTES = 10;

/**
 * Whether the outbox is draining.
 *
 * `oldestDueAt` is the oldest `next_attempt_at` among rows that are due — not the oldest
 * row, because a message scheduled for tomorrow is not late. A due row whose deadline
 * passed more than the grace ago is one nobody has claimed, and claiming is the worker's
 * first act.
 *
 * `stalled` is false at exactly the grace: the boundary is "longer than ten minutes", so
 * a worker that wakes on the minute is never reported as dead. `waitingMinutes` is
 * returned for the sentence a screen prints, and is null when nothing is due.
 */
export function outboxStalled(input: {
  dueNow: number;
  oldestDueAt: Date | null;
  now?: Date;
  graceMinutes?: number;
}): { stalled: boolean; waitingMinutes: number | null } {
  if (input.dueNow <= 0) {
    return { stalled: false, waitingMinutes: null };
  }

  /*
   * A due count with no timestamp is the database disagreeing with itself — the count and
   * the oldest read are two queries. Treated as stalled rather than as "all fine",
   * because the only safe reading of an unreadable queue is that it is not moving.
   */
  if (input.oldestDueAt === null) {
    return { stalled: true, waitingMinutes: null };
  }

  const now = input.now ?? new Date();
  const grace = input.graceMinutes ?? OUTBOX_STALL_MINUTES;
  const waitingMinutes = Math.floor((now.getTime() - input.oldestDueAt.getTime()) / 60_000);

  return { stalled: waitingMinutes > grace, waitingMinutes };
}
