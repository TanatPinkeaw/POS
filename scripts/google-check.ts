/**
 * `npm run google:check` — is the Google door's address registered, and is this process the
 * one customers reach?
 *
 * The I/O half of `src/lib/google-registration.ts`, which holds the decision and the whole
 * story of the failure it exists for (a customer on a phone, Google's own
 * `redirect_uri_mismatch` page, a shop that saw nothing on its own side). Read that file
 * first: this one only fetches.
 *
 * Three questions, in the order a failure is worth finding:
 *
 *   1. **What does this deployment intend to hand Google?** `GOOGLE_CLIENT_ID` and
 *      `PUBLIC_BASE_URL`, read through the same functions the doors read them with, so the
 *      answer cannot drift from what the button actually sends.
 *   2. **Will Google accept it?** The authorize endpoint is asked the question the button
 *      asks, and the answer is read by the pure function. This is the check no other gate in
 *      this repo can make — `npm run google:door` proves the *browser* half against a stub,
 *      and nothing proves the half that lives in someone else's console.
 *   3. **Does the running process agree?** The served `/login` page is fetched and the
 *      address it hands Google is read out of it, then compared with the configured one. A
 *      process left over from before a rebuild answers question 1 differently from question
 *      3, which is the trap `npm run server:check` exists for, arriving through a second door.
 *
 * Read-only: nothing is written, no session is created, no account is touched. The one
 * request that reaches the shop's own server is a landing POST with **no** credential, which
 * the route refuses before it spends a rate-limit bucket — deliberately, so running this
 * against a live shop costs it nothing.
 *
 * Usage:
 *   npm run google:check                       (configuration, Google, and the live page)
 *   npm run google:check -- --client-id <id>   (when .env is not where you are)
 *   npm run google:check -- --url https://pos.example.com
 *   npm run google:check -- --offline          (skip the two live probes, ask Google only)
 *
 * Exit: 0 the door is ready · 1 something to fix, named · 2 nothing could be measured.
 */
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { googleRedirectLoginUri } from '../src/lib/google-door';
import { readGoogleClientId } from '../src/lib/google-id-token';
import {
  googleRegistrationProbeUrl,
  readGoogleRegistrationVerdict,
  type GoogleRegistrationVerdict,
} from '../src/lib/google-registration';
import { readPublicBaseUrl } from '../src/lib/public-url';

/** The path Google has to be told about, as a suffix: what the served page is searched for. */
const LOGIN_URI_SUFFIX = '/api/v1/auth/google/redirect';

/** A hung probe must not hang the tool, the rule `server-check.ts` states. */
const TIMEOUT_MS = 15_000;

/**
 * `.env` is read only when the two values are missing from the environment, because
 * `loadEnvFile` overwrites — the note `prisma7.config.ts` already carries.
 */
if (!process.env.GOOGLE_CLIENT_ID && !process.env.PUBLIC_BASE_URL && existsSync('.env')) {
  loadEnvFile('.env');
}

function argument(argv: readonly string[], name: string): string | null {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) {
    return inline.slice(name.length + 3);
  }
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

/** The addresses a served `/login` page hands Google, read the way `server-check.ts` reads assets. */
function loginUrisIn(html: string): string[] {
  // Next writes part of its payload inside `<script>` JSON, where a path arrives as
  // `\/api\/v1\/…`; matching before that flattening finds nothing on the pages that matter.
  const flattened = html.replace(/\\/g, '');
  const found = flattened.match(new RegExp(`https?://[^"'\\s<>()]*${LOGIN_URI_SUFFIX}`, 'g')) ?? [];
  return [...new Set(found)];
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** What Google said, as one line for a human, plus the verdict the exit code uses. */
function describeVerdict(verdict: GoogleRegistrationVerdict): string {
  switch (verdict.kind) {
    case 'registered':
      return 'Google ไม่ได้ตอบหน้าข้อผิดพลาด — ที่อยู่นี้ผ่านการตรวจ (Google จะพาไปหน้าลงชื่อเข้าใช้)';
    case 'not-registered':
      return 'Google ตอบหน้าข้อผิดพลาด: redirect_uri_mismatch — ยังไม่ได้ลงทะเบียนที่อยู่นี้';
    case 'refused':
      return `Google ตอบหน้าข้อผิดพลาด: ${verdict.code}`;
    case 'unmeasured':
      return 'อ่านคำตอบของ Google ไม่ได้ — ไม่ถือว่าผ่าน';
  }
}

async function askGoogle(input: {
  clientId: string;
  loginUri: string;
}): Promise<GoogleRegistrationVerdict | null> {
  const probe = googleRegistrationProbeUrl({
    clientId: input.clientId,
    redirectUri: input.loginUri,
  });
  try {
    const response = await fetchWithTimeout(probe, { redirect: 'follow' });
    /*
     * The body is only worth downloading when it is the error page: Google's sign-in screen
     * is the same 700 kB either way, and the fallback it feeds (`googleErrorCodeIn`) exists
     * for an answer that arrives without a readable `authError`.
     */
    const body = response.url.includes('/signin/oauth/error') ? await response.text() : undefined;
    return readGoogleRegistrationVerdict({ finalUrl: response.url, body });
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const offline = argv.includes('--offline');

  /*
   * A value given on the command line is read through the same function the deployment reads
   * its own with, so `--url https://pos.example.com/` cannot arrive as a doubled slash that
   * Google then compares character for character against the console — the probe and the
   * button have to be asking about one address, and this is what keeps the two from being
   * normalised differently.
   */
  const clientIdArgument = argument(argv, 'client-id');
  const baseArgument = argument(argv, 'url');
  const clientId =
    clientIdArgument === null
      ? readGoogleClientId()
      : readGoogleClientId({ GOOGLE_CLIENT_ID: clientIdArgument });
  const base =
    baseArgument === null
      ? readPublicBaseUrl()
      : readPublicBaseUrl({ PUBLIC_BASE_URL: baseArgument });

  console.log('');
  console.log('google check: ที่อยู่ที่ปุ่ม Google ส่งให้ Google ต้องลงทะเบียนไว้ก่อน');
  console.log(`  client id   ${clientId ?? '(ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID)'}`);
  console.log(`  base        ${base ?? '(ยังไม่ได้ตั้งค่า PUBLIC_BASE_URL)'}`);
  console.log('');

  /*
   * Configuration first, and both halves are findings rather than errors: a deployment
   * without a client id has no Google door to check, and one without `PUBLIC_BASE_URL` builds
   * the address out of whatever host the customer's link happened to use — an address that
   * cannot be registered once and stay right (see `public-url.ts`).
   */
  const findings: string[] = [];
  if (clientId === null) {
    findings.push(
      'ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID — ปุ่ม Google จะขึ้นข้อความว่าร้านยังไม่ได้ตั้งค่า (ดู docs/renter-onboarding.md §6.4)',
    );
  }
  if (base === null) {
    findings.push(
      'ยังไม่ได้ตั้งค่า PUBLIC_BASE_URL — ที่อยู่ที่ปุ่มส่งให้ Google จะเปลี่ยนตามลิงก์ที่ลูกค้าใช้เปิดร้าน จึงลงทะเบียนไว้ตายตัวไม่ได้ (ดู docs/renter-onboarding.md §3)',
    );
  }

  if (clientId === null || base === null) {
    for (const finding of findings) {
      console.error(`  ✗ ${finding}`);
    }
    console.error('');
    process.exit(1);
  }

  const loginUri = googleRedirectLoginUri(base);
  const origin = new URL(base).origin;
  console.log(`  login_uri   ${loginUri}`);
  console.log(`  origin      ${origin}`);
  console.log('');

  let failed = false;

  // ---- 2. Will Google accept it? -------------------------------------------------------
  const verdict = await askGoogle({ clientId, loginUri });
  if (verdict === null) {
    console.error('  ? ถาม Google ไม่ได้ (เครือข่าย) — ยังไม่ได้ตรวจอะไรเลย ลองอีกครั้ง');
    console.error('');
    process.exit(2);
  }
  console.log(`  Google: ${describeVerdict(verdict)}`);

  if (verdict.kind === 'not-registered' || verdict.kind === 'refused') {
    failed = true;
    console.error('');
    console.error(`  ✗ ต้องแก้ที่ Google Cloud Console (ครั้งเดียว):`);
    console.error('    1. เปิด https://console.cloud.google.com/apis/credentials');
    console.error(`    2. เลือก OAuth 2.0 Client ID ตัวที่ client id คือ ${clientId}`);
    console.error('       (ถ้าไม่มีตัวนี้ ให้สร้าง Web application ใหม่แล้วเอา id ไปใส่ .env)');
    console.error(`    3. Authorized JavaScript origins → ต้องมี: ${origin}`);
    console.error(`    4. Authorized redirect URIs → เพิ่มบรรทัดนี้ให้ตรงทุกตัวอักษร`);
    console.error(`       (ไม่มี / ปิดท้าย ไม่มีช่องว่าง): ${loginUri}`);
    console.error('    5. Save แล้วรอ 5 นาที ถึง 2 ชั่วโมง (Google แนะนำให้รอ) แล้วรันคำสั่งนี้อีกครั้ง');
    if (verdict.kind === 'refused' && verdict.code === 'invalid_request') {
      console.error(
        '       invalid_request = Google ไม่รับที่อยู่ตั้งแต่ต้น: ต้องเป็น https และชื่อโดเมนต้องมีจริง',
      );
    }
    if (verdict.kind === 'refused' && verdict.code === 'invalid_client') {
      console.error('       invalid_client = client id ไม่ถูกต้อง หรือไม่ได้เป็นชนิด Web application');
    }
  }
  if (verdict.kind === 'unmeasured') {
    failed = true;
  }

  // ---- 3. Does the running process agree, and does the endpoint answer? -----------------
  if (!offline) {
    let served: string[] = [];
    try {
      const response = await fetchWithTimeout(`${base}/login`, { redirect: 'follow' });
      served = loginUrisIn(await response.text());
    } catch {
      console.error(`  ? ดึง ${base}/login ไม่ได้ — ข้ามการตรวจฝั่งเซิร์ฟเวอร์`);
      failed = true;
    }

    if (served.length > 0) {
      const agrees = served.length === 1 && served[0] === loginUri;
      console.log(
        `  หน้า /login ส่งให้ Google: ${served.join(', ')} ${agrees ? '→ ตรงกับที่ตั้งค่าไว้' : '→ ไม่ตรง!'}`,
      );
      if (!agrees) {
        failed = true;
        console.error(
          '  ✗ หน้าที่ลูกค้าเห็นไม่ได้ใช้ที่อยู่ในข้อ 4 — มักเป็นโปรเซสที่ยังไม่ได้ build/restart ใหม่ ให้รัน npm run server:check',
        );
      }
    } else if (findings.length === 0) {
      // An empty read is not proof of an old build: a page whose door is unconfigured prints
      // the "ยังไม่ได้ตั้งค่า" notice and carries no address at all, which is its own finding.
      failed = true;
      console.error(
        '  ✗ หน้า /login ไม่ได้ส่งที่อยู่ Google ออกมาเลย — ดูว่า GOOGLE_CLIENT_ID ของโปรเซสที่รันอยู่มีค่าหรือไม่',
      );
    }

    try {
      /*
       * An empty `credential` is refused by the landing before it spends a rate-limit bucket,
       * so this proves the endpoint answers without costing the shop a token. 303 is the
       * answer the route gives everything (`google/redirect/route.ts` explains why 303 and
       * not 307), and it always lands on the front door with `?google=`.
       */
      const response = await fetchWithTimeout(loginUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'credential=',
        redirect: 'manual',
      });
      const location = response.headers.get('location') ?? '';
      const answers = response.status === 303 && location.includes('/login?google=');
      console.log(
        `  ${loginUri} → ${response.status}${answers ? ' (ปลายทางตอบรับ)' : ' (ไม่ใช่ 303 ไปหน้า /login)'}`,
      );
      if (!answers) {
        failed = true;
        console.error(
          '  ✗ ที่อยู่นี้ไม่ได้ชี้มาที่ระบบนี้ — ถ้า PUBLIC_BASE_URL ถูกต้องแล้ว ให้ตรวจว่า tunnel/proxy ส่งมาถึงแอป',
        );
      }
    } catch {
      console.error(`  ? ยิงไปที่ ${loginUri} ไม่ได้ — ยังไม่ได้ตรวจว่าปลายทางตอบหรือไม่`);
      failed = true;
    }
  }

  console.log('');
  if (failed) {
    console.error('google check: ยังไม่พร้อม — แก้ข้อที่ขึ้น ✗ แล้วรันใหม่');
    console.error('');
    process.exit(1);
  }

  console.log('google check: พร้อม — ที่อยู่นี้ลงทะเบียนไว้แล้ว และโปรเซสที่รันอยู่ใช้ที่อยู่นี้จริง');
  console.log('  (ครั้งแรกที่ลูกค้าลงชื่อเข้าใช้ด้วย Google ให้ทดสอบบนมือถือจริงหนึ่งครั้ง)');
  console.log('');
}

void main();
