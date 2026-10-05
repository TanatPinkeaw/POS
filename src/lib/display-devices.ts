/**
 * Pairing a customer display with this shop's till.
 *
 * The screen has no account, no password and no session — giving it one would
 * mean either a shared login anybody could use, or a login screen in front of a
 * customer. So it holds a single revocable token instead, and this module is the
 * whole of its lifecycle.
 *
 * Why a pairing code at all, when the token could simply be printed on the
 * settings screen? Because a token on a screen can be photographed, and it is
 * permanent. The code is six digits, lives five minutes, and is worthless after
 * it is redeemed — the window in which a shoulder-surfer can act is the same five
 * minutes as the window in which the screen is being installed.
 *
 * The token is hashed with SHA-256 rather than bcrypt, and that is deliberate:
 * the value is 32 random bytes, so there is nothing to brute-force and no need
 * for a slow hash — while every socket connection verifies it, and 60ms of
 * bcrypt per reconnect is a real cost on a shop's cheap tablet.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

import { prisma } from './db';
import { optionalNumberEnv } from './env';
import { ConflictError, NotFoundError, UnauthenticatedError, ValidationError } from './errors';
import { DISPLAY_TOKEN_HEADER, type DisplayDeviceView } from './display-view';
import { recordAudit } from './audit';

/** How long a pairing code stays redeemable. */
export function pairingTtlMinutes(): number {
  return optionalNumberEnv('DISPLAY_PAIRING_TTL_MINUTES', 5);
}

/** The label used when an admin does not name the screen. */
const DEFAULT_LABEL = 'จอลูกค้า';

/**
 * Starts a pairing: a code for a screen that is not yet known.
 *
 * The row exists before the screen does, which is what lets the code be checked
 * against something. A pairing that is never completed leaves a revoked-less row
 * with no token — visible in the list as an unpaired attempt, which is honest.
 */
export async function createPairingCode(input: {
  label?: string | null;
  actorId: string;
}): Promise<{ id: string; code: string; expiresAt: string }> {
  const label = (input.label?.trim() || DEFAULT_LABEL).slice(0, 60);
  const code = newPairingCode();

  /*
   * The deadline is the database's, because the check that redeems the code is
   * `pairing_expires_at > now()` — a comparison that happens on the server. A
   * deadline written from here would be compared against a different clock, and a
   * code that is silently already dead is worse than no code at all: it looks like
   * the screen failed to connect.
   */
  const rows = await prisma.$queryRaw<{ id: bigint; pairing_expires_at: Date }[]>`
    INSERT INTO "display_devices"
      ("label", "token_hash", "pairing_code", "pairing_expires_at", "paired_by_user_id")
    VALUES (
      ${label},
      /* A placeholder that can never be presented: the real token is written when
         the code is redeemed. The column is unique and non-null, so an unpaired
         row has to hold something. */
      ${unpairedPlaceholder()},
      ${code},
      now() + make_interval(mins => ${pairingTtlMinutes()}),
      ${input.actorId}::uuid
    )
    RETURNING "id", "pairing_expires_at"
  `;

  const row = rows[0];
  if (!row) {
    throw new ConflictError('สร้างรหัสจับคู่ไม่สำเร็จ', 'PAIRING_CODE_NOT_CREATED');
  }

  return {
    id: row.id.toString(),
    code,
    expiresAt: row.pairing_expires_at.toISOString(),
  };
}

/**
 * Redeems a code for a token.
 *
 * The `WHERE` clause is the whole check: a live code, not yet expired, not
 * revoked. The update is conditional rather than read-then-write so two screens
 * racing the same code cannot both be paired — the second finds the code already
 * cleared and is refused.
 */
export async function redeemPairingCode(code: string): Promise<{ token: string; label: string }> {
  const trimmed = code.replace(/\D/g, '');
  if (trimmed.length !== 6) {
    throw new ValidationError('รหัสจับคู่ต้องเป็นตัวเลข 6 หลัก');
  }

  const token = randomBytes(32).toString('hex');
  const rows = await prisma.$queryRaw<{ id: bigint; label: string }[]>`
    UPDATE "display_devices"
       SET "token_hash" = ${hashToken(token)},
           "pairing_code" = NULL,
           "pairing_expires_at" = NULL,
           "last_seen_at" = now(),
           "revoked_at" = NULL
     WHERE "pairing_code" = ${trimmed}
       AND "pairing_expires_at" > now()
       AND "revoked_at" IS NULL
    RETURNING "id", "label"
  `;

  const row = rows[0];
  if (!row) {
    throw new ConflictError(
      'รหัสจับคู่ไม่ถูกต้องหรือหมดอายุแล้ว — กด "เพิ่มจอ" เพื่อขอรหัสใหม่',
      'PAIRING_CODE_INVALID',
    );
  }

  await recordAudit({
    action: 'display_paired',
    targetType: 'display_device',
    targetId: row.id.toString(),
    detail: { label: row.label },
  });

  return { token, label: row.label };
}

/**
 * The device behind a token, or null.
 *
 * Called on every socket connection, so it is one indexed lookup and no bcrypt.
 * A revoked device returns null, which is what makes revoking take effect the
 * next time the screen reconnects rather than never.
 */
export async function verifyDisplayToken(token: string): Promise<{ id: string; label: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return null;
  }

  const row = await prisma.display_devices.findUnique({
    where: { token_hash: hashToken(token) },
    select: { id: true, label: true, revoked_at: true },
  });

  if (!row || row.revoked_at !== null) {
    return null;
  }

  return { id: row.id.toString(), label: row.label };
}

/**
 * The device behind a request's `x-display-token` header, or a refusal.
 *
 * The HTTP counterpart to the socket handshake, and deliberately the same check:
 * `verifyDisplayToken` refuses a revoked screen, so a screen cut off in the
 * settings panel stops being able to read its own state the next time it asks.
 *
 * The token travels in a header rather than a cookie because the display page is
 * unauthenticated — a cookie would be attached to every request to the origin,
 * including the ones that are nothing to do with this screen.
 */
export async function requireDisplayDevice(
  request: Request,
): Promise<{ id: string; label: string }> {
  const token = request.headers.get(DISPLAY_TOKEN_HEADER) ?? '';
  const device = await verifyDisplayToken(token);
  if (!device) {
    throw new UnauthenticatedError('จอนี้ยังไม่ได้จับคู่ หรือถูกยกเลิกการเชื่อมต่อแล้ว');
  }
  return device;
}

/** Records that a screen is alive, so the settings list can tell. */
export async function touchDisplayDevice(id: string): Promise<void> {
  await prisma.display_devices.update({
    where: { id: BigInt(id) },
    data: { last_seen_at: new Date() },
  }).catch(() => {
    // The row can be revoked between the connection and the touch. Losing this
    // write costs a timestamp, and throwing here would take down a socket that is
    // otherwise fine.
  });
}

/** Every screen, newest first — including ones that were never completed. */
export async function listDisplayDevices(): Promise<DisplayDeviceView[]> {
  const rows = await prisma.display_devices.findMany({
    orderBy: { id: 'desc' },
    include: { paired_by: { select: { full_name: true } } },
  });

  return rows.map((row) => ({
    id: row.id.toString(),
    label: row.label,
    pairedAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    pairedByName: row.paired_by?.full_name ?? null,
  }));
}

/**
 * Cuts a screen off.
 *
 * Revoking rather than deleting, because the trail should still say the screen
 * existed and who added it. The token hash is not rewritten: it is unreachable
 * once `revoked_at` is set, and destroying it would remove the only evidence that
 * a particular token was ever issued.
 */
export async function revokeDisplayDevice(input: {
  id: string;
  actorId: string;
}): Promise<DisplayDeviceView> {
  const existing = await prisma.display_devices.findUnique({ where: { id: BigInt(input.id) } });
  if (!existing) {
    throw new NotFoundError('ไม่พบจอแสดงผลที่ระบุ', `Display device ${input.id}`);
  }
  if (existing.revoked_at !== null) {
    throw new ConflictError('จอนี้ถูกยกเลิกไปแล้ว', 'DISPLAY_ALREADY_REVOKED');
  }

  const row = await prisma.display_devices.update({
    where: { id: existing.id },
    data: { revoked_at: new Date(), pairing_code: null, pairing_expires_at: null },
    include: { paired_by: { select: { full_name: true } } },
  });

  await recordAudit({
    action: 'display_revoked',
    actorUserId: input.actorId,
    targetType: 'display_device',
    targetId: row.id.toString(),
    detail: { label: row.label },
  });

  return {
    id: row.id.toString(),
    label: row.label,
    pairedAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    pairedByName: row.paired_by?.full_name ?? null,
  };
}

/**
 * The value an unpaired row holds in the token column.
 *
 * A function rather than an inline template because a nested backtick inside the
 * SQL template literal would end it early — which is a parse error, not a runtime
 * one, and therefore cheap to avoid forever.
 */
function unpairedPlaceholder(): string {
  return `unpaired:${randomBytes(24).toString('hex')}`;
}

/** SHA-256 of a token, hex. Not a password hash: see the note at the top. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Six digits, drawn from `randomInt`.
 *
 * `randomInt` rather than `Math.floor(Math.random() * 1e6)`: a pairing code is a
 * credential for five minutes, and `Math.random` is not a credential-grade
 * source. Leading zeros are kept, which is why this is a string.
 */
function newPairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
