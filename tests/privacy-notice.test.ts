/**
 * The privacy notices at `/privacy` and `/privacy/staff`.
 *
 * **Why this test reads the source instead of rendering the pages.** The defect it
 * exists to catch is a disclosure going to the wrong reader, and rendering would only
 * prove the page still renders. What matters is *which sentences are in which file* —
 * so the source is the thing under test, the same way `offline-shell.test.ts` reads the
 * shipped `public/sw.js` rather than a twin of it.
 *
 * **The defect.** The first draft carried one line in the customer notice:
 *
 *     <li>ข้อมูลการเข้า–ออกงาน เฉพาะกรณีที่คุณเป็นพนักงานของร้าน</li>
 *
 * Attendance records, inside a list of purchase history. Every customer standing at
 * the counter was told the shop keeps a clock on its own employees: a disclosure about
 * somebody else's data, made in the one document that customer is entitled to read, to
 * the wrong person. Attendance is the most personal record this system holds, because
 * it measures a person's day. The schema cannot prevent the confusion — `users` is one
 * table, and a person can be a member and a cashier in the same row — so the split has
 * to be asserted here instead.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The copy a reader actually sees, with the comments removed.
 *
 * Both notices explain at length *why* the split exists, and both explanations quote
 * the very phrases the assertions below forbid — the customer page names attendance
 * records in the comment recording that it used to list them, and would name them in
 * the comment recording that it must not. Asserting against the raw source would make
 * the documentation of a fix read as the fix's violation of it, which is how a guard
 * like this quietly gets deleted rather than obeyed.
 *
 * A regex rather than a parser, because the repository is one-sided: these two files
 * have no block comment inside a string, and a stripper that lost its mind on the copy
 * would fail the very assertions it exists to make.
 */
function renderedCopy(path: string): string {
  return readFileSync(resolve(path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/*
 * The notice body, not the page.
 *
 * The copy moved out of `page.tsx` and into `PrivacyNoticeBody.tsx` when the sign-in
 * page started rendering the same notice in an overlay scrim — one document, two
 * surfaces. The assertions below are about what the notice *says*, so they follow the
 * text rather than the wrapper; pointing them at the page again would have let a
 * violation slip through into the file that now actually renders the words.
 */
const CUSTOMER = renderedCopy('src/app/privacy/PrivacyNoticeBody.tsx');
const STAFF = renderedCopy('src/app/privacy/staff/page.tsx');

it('reads the copy rather than the comments', () => {
  // A guard that could not tell a comment from copy would be worse than no guard: it
  // would fail for the wrong reason, and the fix would look like deleting the notes.
  expect(CUSTOMER).not.toContain('Staff are not the reader');
  expect(CUSTOMER).toContain('ข้อมูลลูกค้าที่ร้านเก็บ');
});

describe('the two notices are separate documents', () => {
  it('keeps staff-only data out of the customer notice', () => {
    /*
     * The vocabulary a person reads as "this is about someone's working day".
     * Deliberately checks the nouns rather than the section headings, because the
     * failure was a list item, not a heading.
     */
    const staffOnly = [
      'เข้า–ออกงาน',
      'เข้า-ออกงาน',
      'ตารางเวลาทำงาน',
      'ตารางกะ',
      'ชั่วโมงที่ทำงาน',
      'ลิ้นชัก',
      'รหัส PIN',
      'PIN สำหรับผู้ดูแล',
    ];

    for (const phrase of staffOnly) {
      expect(CUSTOMER, `customer notice must not mention "${phrase}"`).not.toContain(phrase);
    }
  });

  it('keeps purchase data out of the staff notice', () => {
    /*
     * The mirror image, and the one that is easy to forget: an employee is also a
     * member in the same row, so the temptation is to make one notice that covers
     * both. Then a reader is told about data that is not theirs in either direction.
     */
    const customerOnly = [
      'ยอดแต้มสะสม',
      'ประวัติการซื้อขาย',
      'รหัสรับของ 4 หลัก',
      'พรีออเดอร์ของคุณ',
      'รหัสรับของ',
      'พรีออเดอร์',
    ];

    for (const phrase of customerOnly) {
      expect(STAFF, `staff notice must not mention "${phrase}"`).not.toContain(phrase);
    }
  });

  it('names the controller and the data subject in both', () => {
    // The Act requires a reader to be able to tell who is collecting whose data.
    for (const [name, source] of [
      ['customer', CUSTOMER],
      ['staff', STAFF],
    ] as const) {
      expect(source, `${name} notice must name the controller`).toContain('ผู้ควบคุมข้อมูลส่วนบุคคล');
      expect(source, `${name} notice must name the data subject`).toContain('เจ้าของข้อมูลส่วนบุคคล');
    }
  });

  it('tells each reader where the other notice is', () => {
    // A reader who turns out to be the other kind of person needs a way out.
    expect(CUSTOMER).toContain('href="/privacy/staff"');
    expect(STAFF).toContain('href="/privacy"');
  });

  it('states the audience above the title, before the reader starts', () => {
    expect(CUSTOMER).toContain('นโยบายนี้สำหรับ');
    expect(STAFF).toContain('นโยบายนี้สำหรับ');
  });

  it('renders no unparsed markdown in either notice', () => {
    /*
     * Both audience lines were written as plain strings carrying `**bold**`, which a
     * JSX text node does not parse — the reader saw two literal asterisks where the
     * emphasis was meant to be. A legal document that shows its own markup reads as a
     * draft, and nothing about a notice undermines it faster than that.
     */
    for (const [name, source] of [
      ['customer', CUSTOMER],
      ['staff', STAFF],
    ] as const) {
      expect(source, `${name} notice must not contain markdown emphasis`).not.toMatch(/\*\*/);
    }
  });
});

describe('the customer notice', () => {
  it('reports the periods this repository can actually verify', () => {
    /*
     * Thirty days is `receiptAccessDays`' default and five minutes is `otpTtlMinutes`'
     * default. These are asserted against the defaults in `src/lib`, so a change to
     * either constant that is not carried into the notice fails here rather than in a
     * customer's browser.
     */
    expect(CUSTOMER).toContain('30 วัน');
    expect(CUSTOMER).toContain('5 นาที');
  });

  it('does not promise the receipt image is kept when it is not', () => {
    /*
     * `receipt-access.ts` is explicit that the window is an *access* rule: "nothing is
     * ever deleted when the window closes". A notice that said the image would be
     * regenerated would be telling a customer to expect something the code does not do.
     */
    expect(CUSTOMER).toContain('ข้อมูลการขายไม่ถูกลบ');
    expect(CUSTOMER).not.toContain('จะถูกสร้างใหม่');
  });

  it('does not promise a download the account page cannot perform', () => {
    // `src/app/(shop)/shop/account` shows history and receipts; it has no export.
    expect(CUSTOMER).toContain('ต้องให้ร้านเป็นผู้จัดทำให้');
  });
});

/*
 * The copy the customer reads *while signing up* — a second copy of the notice's substance,
 * inside the flow, and the one this file used to leave unfenced.
 *
 * `NoticeAcknowledge`'s own comment claimed these assertions existed. They did not: everything
 * above reads `PrivacyNoticeBody.tsx` and the staff notice only, so the paragraphs in the signup
 * panel could state a different retention window from `/privacy` and the whole suite stayed
 * green — which is exactly the drift the panel duplicates the text to avoid. So the fence is
 * built here rather than described there.
 *
 * The stakes are the ones the panel names: these are the figures a customer acts on. The
 * receipt window and the OTP window are the two periods a reader decides anything by.
 */
const SIGNUP_PANEL = renderedCopy('src/components/shop/NoticeAcknowledge.tsx');

describe('the notice the signup panel tells', () => {
  it('states the same periods the page states', () => {
    for (const phrase of ['30 วัน', '5 นาที']) {
      expect(SIGNUP_PANEL, `the signup panel must state "${phrase}" too`).toContain(phrase);
    }
  });

  it('does not promise the receipt image is kept when it is not', () => {
    expect(SIGNUP_PANEL).toContain('ข้อมูลการขายไม่ถูกลบ');
    expect(SIGNUP_PANEL).not.toContain('จะถูกสร้างใหม่');
  });

  it('reads its effective date from the one constant, in both copies', () => {
    /*
     * A date typed into either file is a version that can move without the version string
     * moving with it — the specific mistake `privacy-notice.ts` exists to make impossible, and
     * the reason the panel may not simply print "4 ตุลาคม 2569".
     */
    for (const [name, source] of [
      ['the page', CUSTOMER],
      ['the signup panel', SIGNUP_PANEL],
    ] as const) {
      expect(source, `${name} must render the shared effective date`).toContain(
        'CUSTOMER_NOTICE_EFFECTIVE_FROM',
      );
      expect(source, `${name} must not carry its own date literal`).not.toMatch(/มีผลตั้งแต่ \d/);
    }
  });

  it('renders no unparsed markdown in the panel either', () => {
    expect(SIGNUP_PANEL).not.toMatch(/\*\*/);
  });
});