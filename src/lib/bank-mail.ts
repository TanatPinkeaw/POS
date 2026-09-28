/**
 * Reading a bank's notification email, without a mail library.
 *
 * This is the half of the bank-notification bridge that is pure: what an IMAP
 * response announces, what a MIME message actually says, and what the amount in
 * it is. The socket lives in `scripts/bank-bridge.ts`, and the split is
 * deliberate rather than tidy-minded — a parser coupled to a TLS socket is a
 * parser nobody can test, and every bank formats its notifications a little
 * differently, so this is the file that will be edited first.
 *
 * **What it does not do.** No attachment reading (a statement PDF is not a
 * notification), no `windows-874`/TIS-620 tables, and no OAuth. On the charset:
 * anything that is not UTF-8 or UTF-16 is read as Latin-1, which is not the right
 * Thai text but *is* byte-exact for ASCII — and the only two things the matcher
 * looks for, the amount and the reference, are ASCII. Mangling the prose around
 * them is survivable; refusing to read the numbers would not be.
 */

/**
 * The octet count an IMAP FETCH response announces for a literal, or null.
 *
 * A literal's length is the last thing on the response line, and it is the only
 * way to know where the message ends: the body may contain anything, including
 * lines that look like IMAP. `{1234}` is the synchronising form (the client must
 * send a continuation before the server writes it) and `{1234+}` is not.
 */
export function literalLength(line: string): number | null {
  const match = /\{(\d+)\+?\}$/.exec(line.trimEnd());
  return match ? Number(match[1]) : null;
}

/**
 * The first amount the shop's own pattern finds, or null.
 *
 * Refusing is the important half. A notification whose amount cannot be read is
 * recorded as unattributed; an amount *invented* from some other number in the
 * email — a footer's phone number, a balance, last month's bill — is money
 * attached to the wrong sale, which is worse than money with no sale.
 */
export function extractAmountThb(text: string, pattern: RegExp): number | null {
  // A shop may well configure a `/g` pattern by reflex; `exec` on a global regex
  // continues from `lastIndex`, which would make the second notification of a
  // batch read a different number than the first.
  if (pattern.global) {
    pattern.lastIndex = 0;
  }

  const match = pattern.exec(text);
  if (!match) {
    return null;
  }

  /*
   * A capture group if the shop's pattern has one, else the whole match — and
   * either way everything that is not a digit or a decimal point is dropped, so
   * a pattern as loose as /THB\s*[0-9.]+/ still yields a number. Two decimal
   * points survive that filter and then fail `Number`, which is the intended
   * refusal: 1.2.3 is not an amount.
   */
  const raw = (match[1] ?? match[0]).replace(/[^0-9.]/g, '');
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  // Satang is the smallest unit the money has; a third decimal is noise from
  // somebody's formatter, not a third of a satang.
  return Math.round(value * 100) / 100;
}

/** Base64 text (a body or a part), as UTF-8. */
export function decodeBase64Text(input: string): string {
  return Buffer.from(input.replace(/\s+/g, ''), 'base64').toString('utf8');
}

/**
 * Quoted-printable, decoded a *byte* at a time.
 *
 * Decoding character by character is the classic way to turn Thai into mojibake:
 * one Thai letter is three bytes and every one of them arrives hex-escaped, so
 * they have to be assembled into a buffer before anybody asks what they say.
 * `=\r\n` is a soft line break and vanishes — it is a line-length artefact of the
 * sending mail server, not content.
 */
export function decodeQuotedPrintable(input: string): string {
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;

    if (character !== '=') {
      bytes.push(...Buffer.from(character, 'utf8'));
      continue;
    }

    const next = input.slice(index + 1, index + 3);
    if (next === '\r\n' || next === '\n') {
      index += next === '\r\n' ? 2 : 1;
      continue;
    }

    if (/^[0-9A-Fa-f]{2}$/.test(next)) {
      bytes.push(Number.parseInt(next, 16));
      index += 2;
      continue;
    }

    // A lone `=` that starts no valid escape is literal text, which is what the
    // encoding's own specification says to do with it.
    bytes.push(0x3d);
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * The readable text of a message: the plain part if there is one, else the HTML
 * one with its markup removed, else nothing.
 *
 * Nothing is a real answer. A message that carries only a PDF, or only images,
 * says nothing this system can match on, and inventing text for it would be
 * guessing at which bill somebody paid.
 */
export function decodeMimeText(raw: string): string {
  const part = readPart(raw, 0);
  return (part.plain ?? part.html ?? '').trim();
}

/**
 * Whether a message came from the address the shop expects its bank to use.
 *
 * A mailbox usually holds other mail. Without this check the bridge would file an
 * unread newsletter as money it could not read the amount out of, and the one
 * screen that must stay trustworthy — "there is money we cannot explain" — would
 * fill with things that are not money. Case-insensitive, and a *substring* of the
 * From header: banks send from `no-reply@bank.co.th` one week and
 * `alerts@bank.co.th` the next, and a shop should be able to write `bank.co.th`.
 */
export function isFromSender(raw: string, needle: string | null): boolean {
  if (!needle) {
    return true;
  }
  const from = /^from:\s*(.+)$/im.exec(raw)?.[1]?.trim().toLowerCase() ?? '';
  return from.includes(needle.trim().toLowerCase());
}

/**
 * HTML reduced to something a pattern can be run against.
 *
 * `<script>` and `<style>` contents are dropped rather than flattened into text:
 * a bank's HTML email carries tracking scripts with numbers in them, and the only
 * defence against reading a number that is not the amount is not to read it.
 * Entities become their characters because `&nbsp;` between "จำนวนเงิน" and the
 * amount would otherwise break a pattern that expects a space.
 */
export function stripHtml(input: string): string {
  return decodeEntities(
    input
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Named and numeric entities, including the ones markup turns into neighbours. */
function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    middot: '·',
    ndash: '–',
    mdash: '—',
  };

  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

interface ReadPart {
  plain: string | null;
  html: string | null;
}

/** Depth-limited because a message may nest multiparts, and a loop must end. */
const MAX_DEPTH = 4;

function readPart(raw: string, depth: number): ReadPart {
  const empty: ReadPart = { plain: null, html: null };
  if (depth > MAX_DEPTH) {
    return empty;
  }

  const { headers, body } = splitHeaders(raw);
  const type = header(headers, 'content-type') ?? 'text/plain';
  const boundary = parameter(type, 'boundary');

  if (boundary) {
    /*
     * A multipart's children are searched in order and the first readable one
     * wins for each kind. Preferring the plain part over the HTML one is not
     * tidiness: the two are meant to say the same thing, and the HTML one is the
     * one with markup that could be misread.
     */
    const segments = body.split(`--${boundary}`).slice(1);
    let plain: string | null = null;
    let html: string | null = null;

    for (const [index, segment] of segments.entries()) {
      // The closing `--boundary--` leaves an epilogue, not a part.
      if (index === segments.length - 1 && segment.trimStart().startsWith('--')) {
        continue;
      }
      const child = readPart(segment, depth + 1);
      plain = plain ?? child.plain;
      html = html ?? child.html;
      if (plain && html) {
        break;
      }
    }

    return { plain, html };
  }

  const text = decodeBody(body, header(headers, 'content-transfer-encoding'));

  if (/^text\/html\b/i.test(type)) {
    return { plain: null, html: stripHtml(text) || null };
  }
  if (/^text\/plain\b/i.test(type) || type === '') {
    return { plain: text.trim() || null, html: null };
  }

  // application/pdf, an image, a calendar invitation: not something to guess from.
  return empty;
}

/** Splits a message or a part into its unfolded headers and its body. */
function splitHeaders(raw: string): { headers: string; body: string } {
  const separator = /\r?\n\r?\n/.exec(raw);
  if (!separator) {
    return { headers: '', body: raw };
  }
  return {
    // A header may be folded across lines; the continuation lines are whitespace
    // and are part of the value, not separate headers.
    headers: raw.slice(0, separator.index).replace(/\r?\n[ \t]+/g, ' '),
    body: raw.slice(separator.index + separator[0].length),
  };
}

function header(headers: string, name: string): string | null {
  for (const line of headers.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at === -1) {
      continue;
    }
    if (line.slice(0, at).trim().toLowerCase() === name) {
      return line.slice(at + 1).trim();
    }
  }
  return null;
}

/** One `; name=value` parameter out of a header value, unquoted. */
function parameter(headerValue: string, name: string): string | null {
  const match = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(headerValue);
  if (!match) {
    return null;
  }
  return (match[2] ?? match[1])!.trim() || null;
}

/**
 * The body, according to the encoding the sender declared.
 *
 * An undeclared body is treated as text, because that is what it is. Guessing at
 * an undeclared base64 body — by looking for a long run of base64 characters —
 * was considered and rejected: a bank's HTML body can contain such a run, and the
 * cost of guessing wrong is a message whose amount parses out of the wrong text.
 */
function decodeBody(body: string, encoding: string | null): string {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'base64':
      return decodeBase64Text(body);
    case 'quoted-printable':
      return decodeQuotedPrintable(body);
    default:
      return body;
  }
}
