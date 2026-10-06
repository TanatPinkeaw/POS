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
 * No new dependency: `readline` from the standard library, in the shape
 * `scripts/setup.ts` already uses.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

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
] as const;

/** Where LINE sends the customer back, and where its platform posts events. */
function callbackUrls(origin: string): string[] {
  return [`${origin}/api/v1/auth/line/callback`, `${origin}/api/v1/line/webhook`];
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
  const messagingSecret = env.LINE_MESSAGING_CHANNEL_SECRET?.trim();
  const pushToken = env.NOTIFY_LINE_TOKEN?.trim();
  const loginId = env.LINE_LOGIN_CHANNEL_ID?.trim();
  const loginSecret = env.LINE_LOGIN_CHANNEL_SECRET?.trim();

  console.log(
    messagingSecret && pushToken
      ? '  ✓ webhook + push ลูกค้า: พร้อม (Messaging API ครบ) — อย่าลืมลงทะเบียน webhook URL'
      : messagingSecret
        ? '  ✗ push ลูกค้า: ขาด NOTIFY_LINE_TOKEN'
        : pushToken
          ? '  ✗ webhook: ขาด LINE_MESSAGING_CHANNEL_SECRET (ประตู webhook ยังไม่เป็นประตู)'
          : '  ✗ Messaging API: ยังไม่ตั้งค่า',
  );
  console.log(
    loginId && loginSecret
      ? '  ✓ ประตูล็อกอิน/ผูกบัญชีด้วย LINE: พร้อม (LINE Login ครบ)'
      : loginId
        ? '  ✗ ประตู LINE Login: ขาด LINE_LOGIN_CHANNEL_SECRET'
        : '  ✗ LINE Login: ยังไม่ตั้งค่า (ลูกค้ายังใช้เบอร์/Google เข้าได้ตามปกติ)',
  );

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
