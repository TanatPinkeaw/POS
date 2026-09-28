// Seam under test: turning a bank's notification email into an amount and some
// text, with no network in sight.
//
// The bridge (`scripts/bank-bridge.ts`) is a thin socket around these functions
// on purpose. Everything that can be wrong about reading somebody else's mail —
// where the body ends, which part to believe, what the encoding means — is a pure
// function here, tested against messages shaped like the ones a Thai bank sends.
import { describe, expect, it } from 'vitest';

import {
  decodeBase64Text,
  decodeMimeText,
  decodeQuotedPrintable,
  extractAmountThb,
  isFromSender,
  literalLength,
  stripHtml,
} from '@/lib/bank-mail';

/** The Thai phrase the encodings below were generated from, independently. */
const THAI = 'รับเงินโอน 107.00 บาท K7M2QX';
const THAI_BASE64 = '4Lij4Lix4Lia4LmA4LiH4Li04LiZ4LmC4Lit4LiZIDEwNy4wMCDguJrguLLguJcgSzdNMlFY';
const THAI_QUOTED_PRINTABLE =
  '=E0=B8=A3=E0=B8=B1=E0=B8=9A=E0=B9=80=E0=B8=87=E0=B8=B4=E0=B8=99=E0=B9=82=E0=B8=AD=E0=B8=99 107.00 =E0=B8=9A=E0=B8=B2=E0=B8=97 K7M2QX';

describe('reading an IMAP literal', () => {
  it('reads the octet count at the end of a FETCH response', () => {
    expect(literalLength('* 1 FETCH (BODY[] {1234}')).toBe(1234);
    expect(literalLength('* 1 FETCH (BODY[] {7}')).toBe(7);
  });

  it('accepts the non-synchronising form, which needs no continuation', () => {
    expect(literalLength('* 1 FETCH (BODY[] {1234+}')).toBe(1234);
  });

  it('does not mistake a brace in the message for a literal count', () => {
    // A body containing `{99}` is not a length announcement; only the end of the
    // response line is.
    expect(literalLength('* 1 FETCH (BODY[] "amount {99} baht")')).toBeNull();
    expect(literalLength('a1 OK LOGIN completed')).toBeNull();
  });
});

describe('deciding whether mail is even the bank\'s', () => {
  const MESSAGE = [
    'From: SCB Alerts <alerts@scb.co.th>',
    'Subject: แจ้งเตือนเงินเข้า',
    '',
    'โอน 107.00',
  ].join('\r\n');

  it('accepts the bank\'s address, and only a part of it needs naming', () => {
    // Banks change the mailbox they send from; the domain is the stable part.
    expect(isFromSender(MESSAGE, 'scb.co.th')).toBe(true);
    expect(isFromSender(MESSAGE, 'alerts@scb.co.th')).toBe(true);
    expect(isFromSender(MESSAGE, 'SCB.CO.TH')).toBe(true);
  });

  it('turns down somebody else\'s mail', () => {
    // The case this exists for: an ordinary mailbox with a newsletter in it, which
    // must not become "money we could not read".
    expect(isFromSender(MESSAGE, 'shopee.co.th')).toBe(false);
  });

  it('accepts everything when nothing is configured, which a dedicated mailbox wants', () => {
    expect(isFromSender(MESSAGE, null)).toBe(true);
    expect(isFromSender(MESSAGE, '')).toBe(true);
  });

  it('turns down a message with no From header at all once a filter is set', () => {
    expect(isFromSender('โอน 107.00', 'scb.co.th')).toBe(false);
  });
});

describe('reading the amount out of a notification', () => {
  const PATTERN = /(?:จำนวนเงิน|amount)\s*:?\s*([0-9][0-9,]*\.?[0-9]*)/i;

  it('reads a Thai notification with thousands separators', () => {
    expect(extractAmountThb('จำนวนเงิน 1,234.50 บาท', PATTERN)).toBe(1234.5);
  });

  it('reads a plain integer amount as a whole baht', () => {
    expect(extractAmountThb('จำนวนเงิน 250 บาท', PATTERN)).toBe(250);
  });

  it('says nothing when the pattern is absent', () => {
    // The refusal matters more than the match: an amount invented from an
    // unrelated number in an email footer is money on the wrong bill.
    expect(extractAmountThb('รับเงินโอน จาก นายสมชาย', PATTERN)).toBeNull();
  });

  it('refuses a zero or a negative, which no transfer can be', () => {
    expect(extractAmountThb('จำนวนเงิน 0.00 บาท', PATTERN)).toBeNull();
    expect(extractAmountThb('จำนวนเงิน -100 บาท', PATTERN)).toBeNull();
  });

  it('rounds to satang rather than trusting a third decimal', () => {
    expect(extractAmountThb('จำนวนเงิน 107.005 บาท', PATTERN)).toBe(107.01);
  });

  it('works with a pattern that captures nothing, using the whole match', () => {
    expect(extractAmountThb('THB 88.00 to shop', /THB\s*[0-9.]+/)).toBe(88);
  });
});

describe('decoding what the bank actually sent', () => {
  it('passes an unencoded body through', () => {
    expect(decodeMimeText(THAI)).toBe(THAI);
  });

  it('reads a base64 body as UTF-8', () => {
    expect(decodeBase64Text(THAI_BASE64)).toBe(THAI);
  });

  it('reads a quoted-printable body, byte by byte', () => {
    // Decoding this one character at a time rather than byte at a time is the
    // classic way to turn Thai into mojibake: one Thai letter is three bytes, and
    // every one of them arrives hex-escaped.
    expect(decodeQuotedPrintable(THAI_QUOTED_PRINTABLE)).toBe(THAI);
  });

  it('joins soft line breaks without leaving the equals sign behind', () => {
    expect(decodeQuotedPrintable('จำนวน=\r\nเงิน')).toBe('จำนวนเงิน');
  });
});

describe('decoding a whole message', () => {
  it('honours the declared transfer encoding', () => {
    const message = [
      'From: alerts@bank.example',
      'Subject: แจ้งเตือนเงินเข้า',
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      THAI_BASE64,
    ].join('\r\n');
    expect(decodeMimeText(message)).toBe(THAI);
  });

  it('prefers the plain-text part of a multipart message', () => {
    const message = [
      'Content-Type: multipart/alternative; boundary="BOUND"',
      '',
      '--BOUND',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'plain 107.00 K7M2QX',
      '--BOUND',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<html><body>html 107.00 K7M2QX</body></html>',
      '--BOUND--',
      '',
    ].join('\r\n');
    expect(decodeMimeText(message)).toBe('plain 107.00 K7M2QX');
  });

  it('falls back to the HTML part when there is no plain-text one', () => {
    const message = [
      'Content-Type: multipart/alternative; boundary="BOUND"',
      '',
      '--BOUND',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<p>จำนวนเงิน&nbsp;<b>107.00</b> บาท</p>',
      '--BOUND--',
      '',
    ].join('\r\n');
    // Tags become spaces, entities become the characters they stand for: the
    // reference and the amount have to survive into the matcher's text.
    expect(decodeMimeText(message)).toBe('จำนวนเงิน 107.00 บาท');
  });

  it('parses a header folded across lines', () => {
    const message = [
      'Content-Type: multipart/alternative;',
      ' boundary="BOUND"',
      '',
      '--BOUND',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'folded 107.00 K7M2QX',
      '--BOUND--',
      '',
    ].join('\r\n');
    expect(decodeMimeText(message)).toBe('folded 107.00 K7M2QX');
  });

  it('returns nothing for a message with no readable text part', () => {
    const message = [
      'Content-Type: multipart/mixed; boundary="BOUND"',
      '',
      '--BOUND',
      'Content-Type: application/pdf; name="statement.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
      '--BOUND--',
      '',
    ].join('\r\n');
    expect(decodeMimeText(message)).toBe('');
  });
});

describe('HTML, which is what most banks really send', () => {
  it('drops script and style content instead of reading it as text', () => {
    expect(stripHtml('<div>107.00<script>var x = 1;</script></div>')).toBe('107.00');
    expect(stripHtml('<style>p { color: red }</style>107.00')).toBe('107.00');
  });

  it('turns entities back into characters', () => {
    expect(stripHtml('a&amp;b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe('a&b <c> "d" \'e\'');
  });

  it('collapses the whitespace that markup leaves behind', () => {
    expect(stripHtml('<td>จำนวนเงิน</td>\n   <td>107.00</td>')).toBe('จำนวนเงิน 107.00');
  });
});
