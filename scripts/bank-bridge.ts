/**
 * `npm run bank:bridge` — the shop's own bank-notification bridge.
 *
 * This is the piece that makes automatic confirmation cost nothing: the shop's
 * bank already sends an email when money arrives, the shop already has a mailbox,
 * and this script reads that mailbox and tells the till. No payment provider, no
 * per-check fee, no third party holding the shop's credentials.
 *
 * ```
 * BANK_IMAP_HOST=imap.gmail.com
 * BANK_IMAP_USER=shop@example.com
 * BANK_IMAP_PASSWORD=app-password
 * BANK_AMOUNT_REGEX='จำนวนเงิน\s*:?\s*([0-9][0-9,]*\.?[0-9]*)'
 * PAYMENT_WEBHOOK_SECRET=<same secret the till was configured with>
 * npm run bank:bridge -- --once
 * ```
 *
 * **It is deliberately small and deliberately dumb.** It does not decide which
 * bill a transfer paid — the server does that, in `src/lib/inbound-match.ts`,
 * where the decision is pure and tested. This script's whole job is to get an
 * amount and the notification's text to `POST /api/v1/payments/inbound`, with the
 * bank's own instant and the message's own id so a retry cannot double-count.
 * Everything about reading mail — where a body ends, what a quoted-printable
 * string says — lives in `src/lib/bank-mail.ts`, which is pure and unit-tested;
 * what is left here is a socket and a loop.
 *
 * **What it does not do.** No STARTTLS (port 143 in the clear), no OAuth, no
 * attachments, and no `windows-874` decoding — see `bank-mail.ts` for that last
 * one and why ASCII is enough for the two things it has to read. A shop whose
 * bank needs any of those should point the same `POST` at whatever it already
 * runs; the endpoint does not care who calls it.
 *
 * **Nothing is marked read until the server has accepted it.** A pass that fails
 * halfway leaves the messages it did not deliver still unseen, so the next pass
 * picks them up — and the server's `UNIQUE (source, external_id)` makes the ones
 * it did deliver harmless to re-post.
 */
import { readFileSync } from 'node:fs';
import { connect, type TLSSocket } from 'node:tls';

// Side-effect import: `src/lib/env.ts` loads `.env` for anything that runs
// outside Next's own bundler, which this script does.
import '../src/lib/env';

import {
  decodeMimeText,
  extractAmountThb,
  isFromSender,
  literalLength,
} from '../src/lib/bank-mail';

interface Config {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  baseUrl: string;
  secret: string;
  amountPattern: RegExp;
  /** Only mail from this sender is treated as a notification, when set. */
  from: string | null;
  source: string;
  once: boolean;
  intervalSeconds: number;
  dryRun: boolean;
  file: string | null;
}

function readConfig(argv: string[]): Config {
  const flag = (name: string): string | null => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : (argv[at + 1] ?? '');
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const pattern = process.env.BANK_AMOUNT_REGEX;
  if (!pattern && !has('file')) {
    throw new Error(
      'BANK_AMOUNT_REGEX is not set. It must capture the amount out of your bank\'s ' +
        'notification — see .env.example for a Thai example.',
    );
  }

  return {
    host: process.env.BANK_IMAP_HOST ?? '',
    port: Number(process.env.BANK_IMAP_PORT ?? 993),
    user: process.env.BANK_IMAP_USER ?? '',
    password: process.env.BANK_IMAP_PASSWORD ?? '',
    mailbox: process.env.BANK_IMAP_MAILBOX ?? 'INBOX',
    baseUrl: (process.env.BANK_BRIDGE_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    secret: process.env.PAYMENT_WEBHOOK_SECRET ?? '',
    amountPattern: new RegExp(pattern ?? '(?!)', 'i'),
    from: process.env.BANK_NOTIFICATION_FROM?.trim().toLowerCase() || null,
    source: process.env.BANK_BRIDGE_SOURCE ?? 'bank-bridge',
    once: has('once') || !has('interval'),
    intervalSeconds: Number(flag('interval') ?? 60),
    dryRun: has('dry-run'),
    file: flag('file'),
  };
}

// --------------------------------------------------------------- IMAP, barely

/**
 * The smallest IMAP client that can read one mailbox.
 *
 * Hand-written, like the CSV parser and the THB formatter, because the dependency
 * it replaces would be a package this shop has to keep patched in order to read
 * its own email. It speaks the four commands this job needs and nothing else.
 *
 * The one genuinely fiddly part is literals: a FETCH response announces the octet
 * count of the body (`{1234}`) and then writes exactly that many bytes, which may
 * contain anything at all — including lines that look like IMAP. So the parser
 * reads counts, not lines, at that point.
 */
class Imap {
  private buffer = Buffer.alloc(0);
  private tagCounter = 0;
  private waiting: {
    tag: string;
    resolve: (value: { literal: string; lines: string[] }) => void;
    reject: (error: Error) => void;
  } | null = null;
  private responseLines: string[] = [];
  private literal = '';

  private constructor(private readonly socket: TLSSocket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.consume();
    });
    socket.on('error', (error: Error) => this.waiting?.reject(error));
  }

  static async open(config: Config): Promise<Imap> {
    const socket = connect({
      host: config.host,
      port: config.port,
      servername: config.host,
      rejectUnauthorized: true,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    return new Imap(socket);
  }

  /** Sends one command and resolves when the server finishes answering it. */
  command(text: string): Promise<{ literal: string; lines: string[] }> {
    this.tagCounter += 1;
    const tag = `a${this.tagCounter}`;
    this.responseLines = [];
    this.literal = '';

    return new Promise((resolve, reject) => {
      this.waiting = { tag, resolve, reject };
      this.socket.write(`${tag} ${text}\r\n`);
    });
  }

  close(): void {
    this.socket.end();
  }

  /**
   * Walks whatever has arrived, completing one response at a time.
   *
   * A line ending in `{n}` means n octets of literal follow; they are consumed as
   * bytes and only then does line parsing resume. `{n+}` is the non-synchronising
   * form the server may send without waiting for a continuation.
   */
  private consume(): void {
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end === -1) {
        return;
      }

      const line = this.buffer.subarray(0, end).toString('utf8');
      const length = literalLength(line);

      if (length !== null) {
        if (this.buffer.length < end + 2 + length) {
          return; // the literal has not fully arrived yet
        }
        this.literal += this.buffer.subarray(end + 2, end + 2 + length).toString('utf8');
        this.buffer = this.buffer.subarray(end + 2 + length);
        continue;
      }

      this.buffer = this.buffer.subarray(end + 2);
      this.responseLines.push(line);

      const waiting = this.waiting;
      if (waiting && line.startsWith(`${waiting.tag} `)) {
        this.waiting = null;
        const { literal, lines } = { literal: this.literal, lines: this.responseLines };
        // The status is the first token after the tag: OK, NO or BAD.
        const status = line.slice(waiting.tag.length).trim().split(/\s+/)[0]?.toUpperCase();
        if (status === 'NO' || status === 'BAD') {
          /*
           * A refusal is an exception rather than a quiet empty result: `LOGIN`
           * with a wrong app password answers NO, and a bridge that treated that
           * as "no new mail" would look healthy while delivering nothing.
           */
          waiting.reject(new Error(`IMAP refused ${waiting.tag}: ${line}`));
        } else {
          waiting.resolve({ literal, lines });
        }
      }
    }
  }
}

/** Quotes an IMAP argument; passwords and mailboxes can contain spaces. */
function quoted(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

// ------------------------------------------------------------------- the work

interface Notification {
  amountThb: number | null;
  text: string;
  externalId: string | null;
  receivedAt: string | null;
}

/** What the bank's mail says, as far as this shop's pattern can tell. */
function readNotification(raw: string, config: Config): Notification {
  const text = decodeMimeText(raw);
  const amountThb = extractAmountThb(text, config.amountPattern);

  /*
   * The Message-ID is the ideal idempotency key: it is the bank's own name for
   * the message, so it survives this mailbox, this machine and this release. The
   * Date header is the bank's instant, which is what payability is judged
   * against — a notification delayed in a mailbox is still a payment made when
   * the money moved.
   */
  const messageId = /^message-id:\s*(.+)$/im.exec(raw)?.[1]?.trim() ?? null;
  const date = /^date:\s*(.+)$/im.exec(raw)?.[1]?.trim() ?? null;
  const parsed = date ? new Date(date) : null;

  return {
    amountThb,
    text,
    externalId: messageId,
    receivedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
  };
}

async function post(
  config: Config,
  notification: Notification,
  mailboxId: string,
): Promise<void> {
  const body = {
    amountThb: notification.amountThb,
    // The route caps this too; truncating here as well means a bank that wraps
    // its notification in a wall of invisible marketing HTML cannot make the
    // message unpostable, and therefore retried forever.
    text: notification.text.slice(0, 20_000),
    source: config.source,
    // The mailbox UID is the fallback id, and it is a good one: it is stable for
    // the life of the message in this mailbox, which is exactly as long as it can
    // be posted twice.
    externalId: notification.externalId ?? `${config.mailbox}:${mailboxId}`,
    ...(notification.receivedAt ? { receivedAt: notification.receivedAt } : {}),
  };

  if (config.dryRun) {
    console.log(`  would post: ${JSON.stringify(body)}`);
    return;
  }

  const response = await fetch(`${config.baseUrl}/api/v1/payments/inbound`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-payment-secret': config.secret,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as
    | { data?: { status?: string; intentRef?: string | null; refusalReason?: string | null } }
    | { error?: { message?: string } }
    | null;

  if (!response.ok) {
    const message = payload && 'error' in payload ? payload.error?.message : undefined;
    throw new Error(`ingress refused it (${response.status}): ${message ?? 'no message'}`);
  }

  const result = payload && 'data' in payload ? payload.data : undefined;
  console.log(
    result?.intentRef
      ? `  matched → closed ${result.intentRef}`
      : `  recorded, not matched${result?.refusalReason ? ` (${result.refusalReason})` : ''}`,
  );
}

async function pass(config: Config): Promise<number> {
  const imap = await Imap.open(config);
  try {
    await imap.command(`LOGIN ${quoted(config.user)} ${quoted(config.password)}`);
    const selected = await imap.command(`SELECT ${quoted(config.mailbox)}`);
    const exists = /^\* (\d+) EXISTS/m.exec(selected.lines.join('\n'))?.[1] ?? '?';
    console.log(`${config.mailbox}: ${exists} messages`);

    const search = await imap.command('SEARCH UNSEEN');
    const ids = (search.lines.find((line) => line.startsWith('* SEARCH')) ?? '')
      .replace('* SEARCH', '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (ids.length === 0) {
      console.log('nothing unseen');
      return 0;
    }
    console.log(`${ids.length} unseen`);

    let delivered = 0;
    for (const id of ids) {
      // `BODY.PEEK[]` rather than `BODY[]`: asking for the body must not be what
      // marks it read, because a failed POST has to be retried next pass.
      const fetched = await imap.command(`FETCH ${id} (BODY.PEEK[])`);
      if (fetched.literal.length === 0) {
        console.log(`  #${id}: no body`);
        continue;
      }

      if (!isFromSender(fetched.literal, config.from)) {
        // Not the bank's mail. Marked read so it is not re-examined every pass,
        // and *not* posted: the alternative is a dashboard full of newsletters
        // under a heading about unattributed money.
        console.log(`  #${id}: skipped (not from ${config.from})`);
        if (!config.dryRun) {
          await imap.command(`STORE ${id} +FLAGS (\\Seen)`);
        }
        continue;
      }

      const notification = readNotification(fetched.literal, config);
      console.log(
        `  #${id}: ${notification.amountThb === null ? 'amount unreadable' : `${notification.amountThb.toFixed(2)} THB`}`,
      );

      await post(config, notification, id);

      if (!config.dryRun) {
        await imap.command(`STORE ${id} +FLAGS (\\Seen)`);
      }
      delivered += 1;
    }

    return delivered;
  } finally {
    imap.close();
  }
}

async function main(): Promise<void> {
  const config = readConfig(process.argv.slice(2));

  if (config.file) {
    /*
     * The offline mode, and the one a shop uses *before* wiring the bridge up:
     * point it at a saved notification and see what would be posted. It is also
     * how the amount pattern gets tuned, which is the only part of this bridge
     * that is specific to one bank.
     */
    const notification = readNotification(readFileSync(config.file, 'utf8'), config);
    console.log(`text: ${notification.text.replace(/\s+/g, ' ').slice(0, 400)}`);
    console.log(
      `amount: ${notification.amountThb === null ? 'unreadable' : notification.amountThb.toFixed(2)}`,
    );
    console.log(`external id: ${notification.externalId ?? '(none — the UID would be used)'}`);
    console.log(`received at: ${notification.receivedAt ?? '(none — the server would use now)'}`);
    return;
  }

  if (!config.host || !config.user || !config.password) {
    throw new Error('BANK_IMAP_HOST, BANK_IMAP_USER and BANK_IMAP_PASSWORD must all be set.');
  }
  if (!config.from) {
    console.log(        'BANK_NOTIFICATION_FROM is not set: every unseen message in this mailbox is ' +
        'treated as a bank notification. Fine for a mailbox created for that purpose; ' +
        'set it if the shop reuses an address.',
    );
  }
  if (!config.secret) {
    throw new Error('PAYMENT_WEBHOOK_SECRET must be set, and must match the till\'s.');
  }

  for (;;) {
    try {
      const delivered = await pass(config);
      console.log(`pass complete: ${delivered} notification(s) delivered`);
    } catch (error) {
      // Logged, then retried: a mail server that is briefly unreachable, or a
      // till that is being restarted, must not stop the bridge from ever running
      // again — the money is not lost meanwhile, it is simply still unread.
      console.error(`pass failed: ${error instanceof Error ? error.message : String(error)}`);
      if (config.once) {
        process.exitCode = 1;
        return;
      }
    }

    if (config.once) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, config.intervalSeconds * 1000));
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
