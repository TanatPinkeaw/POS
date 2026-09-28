// Seam under test: the supervisor PIN and the approvals it mints.
//
// The interesting behaviour is not "the right PIN works" — it is everything
// around it. How many guesses a person gets, what happens on the fifth, whether
// the lock resets so the PIN is usable again, and whether an approval can be
// spent on something other than what it was granted for. Each of those is a way
// a four-digit PIN could quietly become no protection at all.
import { SignJWT } from 'jose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ApprovalRejectedError, ForbiddenError, ValidationError } from '@/lib/errors';
import { passwordProblem } from '@/lib/staff';
import { authSecretKey } from '@/lib/session-token';
import {
  assertApprovalMatches,
  clearSupervisorPin,
  issueApprovalToken,
  listSupervisors,
  requestApproval,
  setSupervisorPin,
  supervisorStatus,
  verifyApprovalToken,
  verifySupervisorPin,
} from '@/lib/supervisor';
import { MAX_PIN_ATTEMPTS, pinProblem } from '@/lib/supervisor-view';

import { prisma, resetDatabase, seedPeople, type TestPeople } from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** `passwordProblem` is imported so the two credential rules are read side by side. */
void passwordProblem;

describe('which four digits are allowed', () => {
  it('refuses anything that is not four digits', () => {
    expect(pinProblem('123')).toBeTruthy();
    expect(pinProblem('12345')).toBeTruthy();
    expect(pinProblem('12a4')).toBeTruthy();
    expect(pinProblem('')).toBeTruthy();
  });

  it('refuses the same digit four times', () => {
    expect(pinProblem('0000')).toBeTruthy();
    expect(pinProblem('7777')).toBeTruthy();
  });

  it('refuses a run, in either direction', () => {
    expect(pinProblem('1234')).toBeTruthy();
    expect(pinProblem('4321')).toBeTruthy();
  });

  it('accepts any four digits that are neither repeated nor consecutive', () => {
    expect(pinProblem('2580')).toBeNull();
    // A run that wraps (9,0,1,2) is not a run: the digits are adjacent on a
    // keypad only if it is laid out as a circle, which it is not.
    expect(pinProblem('9012')).toBeNull();
  });
});

describe('who may hold a PIN', () => {
  it('refuses to give one to an employee', async () => {
    await expect(
      setSupervisorPin({ userId: people.employeeId, pin: '2580', actorId: people.adminId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('gives one to an admin, and records that it happened', async () => {
    const status = await setSupervisorPin({
      userId: people.adminId,
      pin: '2580',
      actorId: people.adminId,
    });

    expect(status.hasPin).toBe(true);
    expect(await supervisorStatus(people.adminId)).toEqual({ hasPin: true, lockedUntil: null });

    const trail = await prisma.audit_logs.findMany({ where: { action: 'pin_set' } });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.target_id).toBe(people.adminId);
  });

  it('refuses a PIN that is a run, and stores nothing', async () => {
    await expect(
      setSupervisorPin({ userId: people.adminId, pin: '1234', actorId: people.adminId }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await supervisorStatus(people.adminId)).toEqual({ hasPin: false, lockedUntil: null });
  });

  it('never stores the four digits themselves', async () => {
    await setSupervisorPin({ userId: people.adminId, pin: '2580', actorId: people.adminId });

    const row = await prisma.users.findUniqueOrThrow({ where: { id: people.adminId } });
    expect(row.pin_hash).toBeTruthy();
    expect(row.pin_hash).not.toContain('2580');
    expect(row.pin_hash?.length).toBeGreaterThan(50);
  });

  it('lists the admins who can approve, and nobody else', async () => {
    await setSupervisorPin({ userId: people.adminId, pin: '2580', actorId: people.adminId });

    const supervisors = await listSupervisors();
    expect(supervisors.map((entry) => entry.id)).toEqual([people.adminId]);
  });

  it('clears a PIN so the account can no longer approve', async () => {
    await setSupervisorPin({ userId: people.adminId, pin: '2580', actorId: people.adminId });
    await clearSupervisorPin({ userId: people.adminId, actorId: people.adminId });

    expect(await supervisorStatus(people.adminId)).toEqual({ hasPin: false, lockedUntil: null });
    expect(await listSupervisors()).toHaveLength(0);
  });
});

describe('checking a PIN', () => {
  beforeEach(async () => {
    await setSupervisorPin({ userId: people.adminId, pin: '2580', actorId: people.adminId });
  });

  it('accepts the right PIN', async () => {
    await expect(
      verifySupervisorPin({ supervisorId: people.adminId, pin: '2580' }),
    ).resolves.toEqual({ ok: true, supervisorId: people.adminId });
  });

  it('counts down the attempts without revealing which digit was wrong', async () => {
    for (let attempt = 1; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
      const result = await verifySupervisorPin({ supervisorId: people.adminId, pin: '9999' });
      expect(result).toEqual({
        ok: false,
        reason: 'wrong',
        attemptsRemaining: MAX_PIN_ATTEMPTS - attempt,
      });
    }
  });

  it('locks on the fifth wrong guess, and records exactly one lock', async () => {
    for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
      await verifySupervisorPin({ supervisorId: people.adminId, pin: '9999' });
    }

    // The correct PIN is refused while the lock stands — that is the whole point.
    const afterLock = await verifySupervisorPin({ supervisorId: people.adminId, pin: '2580' });
    expect(afterLock.ok).toBe(false);
    expect(afterLock).toMatchObject({ reason: 'locked' });

    const locks = await prisma.audit_logs.findMany({ where: { action: 'pin_locked' } });
    expect(locks).toHaveLength(1);
  });

  it('gives the holder five fresh attempts once the lock expires', async () => {
    for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
      await verifySupervisorPin({ supervisorId: people.adminId, pin: '9999' });
    }

    // Time passing, without sleeping five minutes for it.
    await prisma.users.update({
      where: { id: people.adminId },
      data: { pin_locked_until: new Date(Date.now() - 1_000) },
    });

    const result = await verifySupervisorPin({ supervisorId: people.adminId, pin: '9999' });
    expect(result).toEqual({
      ok: false,
      reason: 'wrong',
      attemptsRemaining: MAX_PIN_ATTEMPTS - 1,
    });
  });

  it('forgets the failures once the right PIN arrives', async () => {
    await verifySupervisorPin({ supervisorId: people.adminId, pin: '9999' });
    await verifySupervisorPin({ supervisorId: people.adminId, pin: '2580' });

    const result = await verifySupervisorPin({ supervisorId: people.adminId, pin: '9999' });
    expect(result).toEqual({
      ok: false,
      reason: 'wrong',
      attemptsRemaining: MAX_PIN_ATTEMPTS - 1,
    });
  });

  it('says so when the account has no PIN at all', async () => {
    await expect(
      verifySupervisorPin({ supervisorId: people.employeeId, pin: '2580' }),
    ).rejects.toThrow(/PIN/i);
  });
});

describe('the approval token', () => {
  beforeEach(async () => {
    await setSupervisorPin({ userId: people.adminId, pin: '2580', actorId: people.adminId });
  });

  it('carries who asked, who approved, what for, and which record', async () => {
    const grant = await requestApproval({
      actorId: people.employeeId,
      supervisorId: people.adminId,
      pin: '2580',
      action: 'void_order',
      targetId: 'order-1',
    });

    await expect(verifyApprovalToken(grant.token)).resolves.toEqual({
      actorId: people.employeeId,
      supervisorId: people.adminId,
      action: 'void_order',
      targetId: 'order-1',
    });
    // The dialog shows this, so it has to be the name rather than an id.
    expect(grant.approverName).toBeTruthy();
  });

  it('refuses to mint one for a wrong PIN, and says how many tries are left', async () => {
    const failure = requestApproval({
      actorId: people.employeeId,
      supervisorId: people.adminId,
      pin: '9999',
      action: 'void_order',
      targetId: 'order-1',
    });

    await expect(failure).rejects.toBeInstanceOf(ApprovalRejectedError);
    await failure.catch((error: ApprovalRejectedError) => {
      expect(error.code).toBe('PIN_WRONG');
      expect(error.context).toEqual({ reason: 'wrong', attemptsRemaining: MAX_PIN_ATTEMPTS - 1 });
    });
  });

  it('cannot be spent on a different action, record, or person', async () => {
    const claims = {
      actorId: people.employeeId,
      supervisorId: people.adminId,
      action: 'over_discount' as const,
      targetId: 'discount:60.00',
    };

    expect(() =>
      assertApprovalMatches(claims, {
        action: 'over_discount',
        targetId: 'discount:60.00',
        actorId: people.employeeId,
      }),
    ).not.toThrow();

    // A discount approval is not a void.
    expect(() =>
      assertApprovalMatches(claims, {
        action: 'void_order',
        targetId: 'discount:60.00',
        actorId: people.employeeId,
      }),
    ).toThrow(ForbiddenError);

    // An approval for ฿60 is not an approval for ฿600.
    expect(() =>
      assertApprovalMatches(claims, {
        action: 'over_discount',
        targetId: 'discount:600.00',
        actorId: people.employeeId,
      }),
    ).toThrow(ForbiddenError);

    // And it belongs to the cashier who asked for it.
    expect(() =>
      assertApprovalMatches(claims, {
        action: 'over_discount',
        targetId: 'discount:60.00',
        actorId: people.adminId,
      }),
    ).toThrow(ForbiddenError);
  });

  it('rejects a token that has expired', async () => {
    const expired = await new SignJWT({ act: 'void_order', tid: 'order-1', by: people.adminId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(people.employeeId)
      .setIssuedAt()
      .setIssuer('pos-realtime-approval')
      .setAudience('pos:supervisor-approval')
      .setExpirationTime('-1s')
      .sign(authSecretKey());

    await expect(verifyApprovalToken(expired)).rejects.toThrow(/approval/i);
  });

  it('rejects a session token presented as an approval', async () => {
    // Same key, different issuer and audience: the split exists so that the two
    // kinds of token cannot be swapped for each other.
    const sessionShaped = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(people.adminId)
      .setIssuedAt()
      .setIssuer('pos-realtime')
      .setExpirationTime('10m')
      .sign(authSecretKey());

    await expect(verifyApprovalToken(sessionShaped)).rejects.toThrow(/approval/i);
  });

  it('rejects a token signed with another key', async () => {
    const forged = await new SignJWT({ act: 'void_order', tid: 'order-1', by: people.adminId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(people.employeeId)
      .setIssuedAt()
      .setIssuer('pos-realtime-approval')
      .setAudience('pos:supervisor-approval')
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('a'.repeat(48)));

    await expect(verifyApprovalToken(forged)).rejects.toThrow(/approval/i);
  });

  it('binds the same action and target for a different caller', async () => {
    const grant = await issueApprovalToken({
      actorId: people.employeeId,
      supervisorId: people.adminId,
      action: 'drawer_open',
      targetId: '7',
    });

    const claims = await verifyApprovalToken(grant.token);
    expect(claims.targetId).toBe('7');
    expect(() =>
      assertApprovalMatches(claims, {
        action: 'drawer_open',
        targetId: '8',
        actorId: people.employeeId,
      }),
    ).toThrow(ForbiddenError);
  });
});
