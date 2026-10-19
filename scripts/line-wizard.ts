/**
 * The LINE provisioning walk — the steps only a human can do (ADR 0030).
 *
 * The code opens every door LINE offers once the values exist, but *making* the
 * values needs a person in LINE's console: two channels, one token, two URLs
 * pasted through the shop's own tunnel. This script walks that person through
 * the clicks, captures each value as they reach it, and writes the result into
 * `.env` — so the procedure stops being something an agent re-explains every
 * round and becomes something the operator runs once.
 *
 * `node scripts/line-wizard.ts --verify` skips the walk and checks what is
 * already in `.env`, naming which door each value opens and which doors stay
 * shut. It exits 0 on an unconfigured shop with "nothing configured" rather
 * than a traceback, because "not set up yet" is a state, not an error.
 *
 * The doors it reports are **not** worked out here. They come from
 * `src/lib/line-readiness.ts`, the same module `/admin/line` renders, because the
 * version written inline in this file was wrong in the one way that mattered: it
 * printed "push ลูกค้า: พร้อม" from a channel secret and a push token, while the
 * customer's "order ready" message is also gated on `NOTIFY_CHANNEL=line` — a value
 * this file never read (ADR 0035). A shop could follow the wizard, believe it was
 * notifying customers, and send nothing, with no error anywhere.
 *
 * One more difference a reader should know before trusting the output: this reads
 * `.env` from disk, and the running server holds whatever it read when it started.
 * After a change the two disagree until a restart, and that is why the note at the
 * bottom of the report exists rather than being left to memory.
 *
 * No new dependency: `readline` from the standard library, in the shape
 * `scripts/setup.ts` already uses.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { lineReadiness, type LineDoorState } from '../src/lib/line-readiness';

const ENV_FILE = '.env';

/** The values this feature reads, what opens with them, and how a human gets one. */
const STEPS = [
  {
    key: 'LINE_MESSAGING_CHANNEL_SECRET',
    what: 'channel secret ของ Messaging API channel',
    how: 'LINE Developers Console → ช่องทาง Messaging API → Channel secret (แท็บ Basic settings) — กด Issue/แสดงค่า',
    optional: false,
  },
  {
    key: 'NOTIFY_LINE_TOKEN',
    what: 'channel access token (ยาว ~170 ตัวอักษร)',
    how: 'ช่องทางเดียวกัน → แท็บ Messaging API → Issue channel access token (อายุ long-lived) — ตัวนี้ใช้ push ทั้งกลุ่มร้านและลูกค้า',
    optional: false,
  },
  {
    key: 'LINE_LOGIN_CHANNEL_ID',
    what: 'channel ID ของ LINE Login channel',
    how: 'LINE Developers Console → สร้างช่องทาง LINE Login → Basic settings → Channel ID',
    optional: true,
  },
  {
    key: 'LINE_LOGIN_CHANNEL_SECRET',
    what: 'channel secret ของ LINE Login channel',
    how: 'ช่องทาง LINE Login เดียวกัน → Basic settings → Channel secret',
    optional: true,
  },
  {
    key: 'LINE_LIFF_ID',
    what: 'LIFF ID สำหรับให้ลูกค้าเปิดร้านในแอป LINE (ADR 0032)',
    how: 'ช่องทาง LINE Login เดียวกัน → แท็บ LIFF → Add — ตั้ง Endpoint URL เป็น https://<โดเมนของร้าน>/line (ต้องเป็น https) แล้วคัดลอก LIFF ID ซึ่งมีรูปแบบ 2000000000-xxxxxxxx',
    optional: true,
  },
] as const;

/**
 * Where LINE sends the customer back, where its platform posts events, and the address a
 * LIFF app's endpoint URL must be (ADR 0032).
 *
 * The last one is printed here rather than left to the console walk because LINE compares
 * it against the app the customer actually opens: an endpoint URL that is not this
 * deployment's own `/line` fails inside LINE's browser, with nothing on this server to read.
 */
function callbackUrls(origin: string): string[] {
  return [`${origin}/api/v1/auth/line/callback`, `${origin}/api/v1/line/webhook`, `${origin}/line`];
}

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = (await rl.question(question)).trim();
  return answer;
}

function upsertEnvLine(lines: string[], key: string, value: string): string[] {
  const kept = lines.filter((line) => !line.startsWith(`${key}=`));
  kept.push(`${key}=${value}`);
  return kept;
}

async function main(): Promise<void> {
  if (process.argv.includes('--verify')) {
    await verify();
    return;
  }

  console.log('การตั้งค่า LINE สำหรับเหลี่ยมนอก (ADR 0030)');
  console.log('');
  console.log('ก่อนเริ่ม: สร้างบัญชี Official Account ของร้านที่ https://account.line.biz');
  console.log('แล้วเปิด LINE Developers Console (https://developers.line.biz) ภายใต้บัญชีเดียวกัน');
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });
  const values = new Map<string, string>();

  for (const step of STEPS) {
    console.log('');
    console.log(`• ${step.what}`);
    console.log(`  ${step.how}`);
    const answer = await ask(rl, `  วางค่า (Enter เพื่อข้าม): `);
    if (answer) {
      values.set(step.key, answer);
    } else if (!step.optional) {
      console.log('  ข้ามไปก่อน — ประตูที่ใช้ค่านี้จะยังปิดอยู่จนกว่าจะตั้งค่า');
    }
  }

  const origin = await ask(
    rl,
    'URL ภายนอกของระบบ (เช่น https://pos.example.com ผ่าน tunnel ของร้าน): ',
  );
  if (origin) {
    console.log('');
    console.log('จะลงทะเบียน URL เหล่านี้ในคอนโซลของ LINE:');
    for (const url of callbackUrls(origin)) {
      console.log(`  ${url}`);
    }
    console.log('  (callback URL: ทั้งสองช่องทาง · webhook URL: ช่องทาง Messaging API)');
  }

  rl.close();

  if (values.size === 0) {
    console.log('');
    console.log('ไม่มีค่าใหม่ — ไม่แตะไฟล์ .env');
    return;
  }

  const fs = await import('node:fs');
  const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  let lines = existing;
  for (const [key, value] of values) {
    lines = upsertEnvLine(lines, key, value);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
  console.log('');
  console.log(`เขียน ${values.size} ค่าลง ${ENV_FILE} แล้ว — รีสตาร์ตเซิร์ฟเวอร์เพื่อให้ประตูเปิด`);
  await verify();
}

/** Reads `.env` and says, in one line each, which door every value opens. */
async function verify(): Promise<void> {
  const fs = await import('node:fs');
  const env: Record<string, string> = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) {
        env[match[1]] = match[2];
      }
    }
  }

  console.log('สถานะประตู LINE:');

  /*
   * Symbol per state, and the symbol is the whole distinction a terminal can carry: `✓`
   * open, `✗` half-configured (the state that sends nothing while looking configured),
   * `·` never set up (a shop that works without it).
   */
  const MARK: Record<LineDoorState, string> = { ready: '✓', blocked: '✗', off: '·' };

  for (const door of lineReadiness(env)) {
    console.log(`  ${MARK[door.state]} ${door.title}: ${door.sentence}`);
  }

  if (lineReadiness(env).some((door) => door.state === 'blocked')) {
    console.log('');
    console.log(
      '  หมายเหตุ: รายงานนี้อ่านจาก .env บนดิสก์ — ถ้าเพิ่งแก้ค่า ต้องรีสตาร์ตเซิร์ฟเวอร์ก่อน หน้า /admin/line จึงจะเห็นค่าใหม่',
    );
  }

  const liffId = env.LINE_LIFF_ID?.trim();
  if (liffId) {
    console.log(`  ลิงก์ที่จะแนบในข้อความคือ https://liff.line.me/${liffId}`);
  }
  /*
   * A loud line for the one setting that moves where the shop's own secret goes: it is a
   * legitimate setting (an egress proxy, or the acceptance run's stub) and an easy one to
   * leave behind, and the symptom of a stale one is a send that simply never arrives.
   */
  const apiBase = env.LINE_API_BASE_URL?.trim();
  if (apiBase) {
    console.log(
      `  ! LINE_API_BASE_URL ถูกตั้งไว้เป็น ${apiBase} — โทเคนของช่องทางร้านจะถูกส่งไปที่นั่น ไม่ใช่ api.line.me ของ LINE`,
    );
  }

  const url = process.env.PUBLIC_BASE_URL?.trim() ?? env.PUBLIC_BASE_URL?.trim();
  if (url) {
    console.log('URL ที่ควรลงทะเบียนกับ LINE:');
    for (const callback of callbackUrls(url)) {
      console.log(`  ${callback}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
