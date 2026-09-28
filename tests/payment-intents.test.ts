// Seam under test: a PromptPay QR, and the display screens paired to the till.
//
// The money path is the reason this file exists. A confirmation can arrive twice,
// arrive late, or arrive after the cashier has already taken cash — and each of
// those has to end with one bill closed and one record of the transfer, not two.
// The pairing tests cover the other half: a screen that has been revoked must stop
// receiving, which is the only thing making a permanent token safe on a shop floor.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPairingCode, listDisplayDevices, redeemPairingCode, revokeDisplayDevice, verifyDisplayToken } from '@/lib/display-devices';
import { ConflictError, ValidationError } from '@/lib/errors';
import { openShift } from '@/lib/cash-shifts';
import { createPosSale } from '@/lib/orders';
import {
  cancelIntent,
  confirmIntent,
  consumeIntent,
  createIntent,
  findIntent,
  sweepExpiredIntents,
} from '@/lib/payment-intents';
import { createShop } from '@/lib/shop';
import { prisma, resetDatabase, seedPeople, seedProduct, type TestPeople } from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A configured shop that can take PromptPay, and an open drawer. */
async function shopWithPromptPay(): Promise<{ shiftId: number }> {
  await createShop({
    name: 'เหลี่ยมนอก มินิมาร์ท',
    isVatRegistered: false,
    vatRate: 0,
    receiptPrefix: 'SMK',
    promptpayId: '0812345678',
    promptpayType: 'mobile',
  });
  const shift = await openShift({ userId: people.employeeId, initialCash: 500 });
  return { shiftId: shift.id };
}

describe('issuing a QR', () => {
  it('locks the code to the amount and carries a reference', async () => {
    const { shiftId } = await shopWithPromptPay();

    const intent = await createIntent({
      shiftId,
      cashierId: people.employeeId,
      amountThb: 155,
    });

    expect(intent.status).toBe('pending');
    expect(intent.amountThb).toBe(155);
    // The reference is the field a webhook quotes back, so it must be in the
    // payload and in the row — derived from the payload, not chosen separately.
    expect(intent.qrPayload).toContain(intent.ref);
    expect(intent.ref).toHaveLength(6);
    expect(new Date(intent.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to issue one before the shop has a PromptPay id', async () => {
    await createShop({
      name: 'ร้านยังไม่ตั้งพร้อมเพย์',
      isVatRegistered: false,
      vatRate: 0,
      receiptPrefix: 'RC',
    });
    const shift = await openShift({ userId: people.employeeId, initialCash: 100 });

    await expect(
      createIntent({ shiftId: shift.id, cashierId: people.employeeId, amountThb: 50 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a non-positive amount rather than emitting a QR for anything', async () => {
    const { shiftId } = await shopWithPromptPay();

    await expect(
      createIntent({ shiftId, cashierId: people.employeeId, amountThb: 0 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a QR for a drawer that is not open', async () => {
    await shopWithPromptPay();

    await expect(
      createIntent({ shiftId: 9999, cashierId: people.employeeId, amountThb: 50 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('confirming a transfer', () => {
  it('records the amount and the time, and names the confirmer', async () => {
    const { shiftId } = await shopWithPromptPay();
    const intent = await createIntent({ shiftId, cashierId: people.employeeId, amountThb: 80 });

    const paid = await confirmIntent({
      ref: intent.ref,
      confirmedByUserId: people.adminId,
      actorUserId: people.employeeId,
      authorizedByUserId: people.adminId,
      shiftId,
    });

    expect(paid.status).toBe('paid');
    expect(paid.paidAt).not.toBeNull();

    const trail = await prisma.audit_logs.findMany({ where: { action: 'manual_payment_confirm' } });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.actor_user_id).toBe(people.employeeId);
    expect(trail[0]?.authorized_by_user_id).toBe(people.adminId);
    expect(trail[0]?.detail).toMatchObject({ amountThb: 80 });
  });

  it('is idempotent: a second confirmation does not error and does not double-count', async () => {
    const { shiftId } = await shopWithPromptPay();
    const intent = await createIntent({ shiftId, cashierId: people.employeeId, amountThb: 80 });

    await confirmIntent({ ref: intent.ref, confirmedByUserId: null });
    const again = await confirmIntent({ ref: intent.ref, confirmedByUserId: null });

    expect(again.status).toBe('paid');
    // The "money arrived by hand" rows stay at zero: a webhook has no user.
    expect(await prisma.audit_logs.count({ where: { action: 'manual_payment_confirm' } })).toBe(0);
  });

  it('refuses to confirm an expired QR, leaving it expired', async () => {
    const { shiftId } = await shopWithPromptPay();
    const intent = await createIntent({ shiftId, cashierId: people.employeeId, amountThb: 80 });

    await prisma.payment_intents.update({
      where: { ref: intent.ref },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const result = await confirmIntent({ ref: intent.ref, confirmedByUserId: null });
    expect(result.status).toBe('expired');
  });

  it('sweeps an expired QR out of the payable state', async () => {
    const { shiftId } = await shopWithPromptPay();
    const intent = await createIntent({ shiftId, cashierId: people.employeeId, amountThb: 80 });

    await prisma.payment_intents.update({
      where: { ref: intent.ref },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    expect(await sweepExpiredIntents()).toBe(1);
    expect((await findIntent(intent.ref))?.status).toBe('expired');
    // And the second sweep has nothing to do, so it is safe to run on every read.
    expect(await sweepExpiredIntents()).toBe(0);
  });
});

describe('settling a bill with a paid QR', () => {
  it('consumes the intent exactly once, and the second attempt fails', async () => {
    const { shiftId } = await shopWithPromptPay();
    const product = await seedProduct({ name: 'นมสด', stockQty: 10, salePrice: 80 });
    const intent = await createIntent({ shiftId, cashierId: people.employeeId, amountThb: 80 });
    await confirmIntent({ ref: intent.ref, confirmedByUserId: null });

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [{ productId: product.id, quantity: 1 }],
      customerId: null,
      settlement: { promptpay: 80 },
      intentRef: intent.ref,
    });

    expect(sale.finalAmountThb).toBe(80);

    const consumed = await findIntent(intent.ref);
    expect(consumed?.status).toBe('consumed');

    // One transfer, one bill: a second submission finds nothing left to consume.
    await expect(
      consumeIntent(prisma, { ref: intent.ref, orderId: sale.orderId }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses to settle against an intent that was never paid', async () => {
    const { shiftId } = await shopWithPromptPay();
    const product = await seedProduct({ stockQty: 10, salePrice: 80 });
    const intent = await createIntent({ shiftId, cashierId: people.employeeId, amountThb: 80 });

    await expect(
      createPosSale({
        cashierId: people.employeeId,
        shiftId,
        lines: [{ productId: product.id, quantity: 1 }],
        customerId: null,
        settlement: { promptpay: 80 },
        intentRef: intent.ref,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Nothing was sold, so nothing should have left the stock either.
    const after = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stock_qty).toBe(10);
  });

  it('leaves a cancelled QR unusable', async () => {
    const { shiftId } = await shopWithPromptPay();
    const intent = await createIntent({ shiftId, cashierId: people.employeeId, amountThb: 80 });

    const cancelled = await cancelIntent({ ref: intent.ref, actorId: people.employeeId });
    expect(cancelled.status).toBe('cancelled');

    // Confirming after a cancellation records nothing: the customer's money may
    // well have arrived, but the till has moved on and a human has to look.
    const late = await confirmIntent({ ref: intent.ref, confirmedByUserId: null });
    expect(late.status).toBe('cancelled');

    await expect(
      cancelIntent({ ref: intent.ref, actorId: people.employeeId }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('pairing a customer display', () => {
  it('redeems a code once and hands back a token', async () => {
    const { code } = await createPairingCode({ label: 'จอหน้าเคาน์เตอร์', actorId: people.adminId });

    const paired = await redeemPairingCode(code);
    expect(paired.label).toBe('จอหน้าเคาน์เตอร์');
    expect(paired.token).toMatch(/^[0-9a-f]{64}$/);

    // The device is recognisable by its token, and the token is all that is kept.
    const device = await verifyDisplayToken(paired.token);
    expect(device?.label).toBe('จอหน้าเคาน์เตอร์');

    // The code is spent: a second screen cannot pair with it.
    await expect(redeemPairingCode(code)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses an expired code', async () => {
    const { code } = await createPairingCode({ label: 'จอเก่า', actorId: people.adminId });
    await prisma.display_devices.updateMany({ data: { pairing_expires_at: new Date(Date.now() - 1000) } });

    await expect(redeemPairingCode(code)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a code that is not six digits', async () => {
    await expect(redeemPairingCode('123')).rejects.toBeInstanceOf(ValidationError);
  });

  it('stops recognising a token once the screen is revoked', async () => {
    const { id, code } = await createPairingCode({ label: 'จอทีวี', actorId: people.adminId });
    const { token } = await redeemPairingCode(code);

    await revokeDisplayDevice({ id, actorId: people.adminId });

    expect(await verifyDisplayToken(token)).toBeNull();
    await expect(
      revokeDisplayDevice({ id, actorId: people.adminId }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('records pairing and revocation in the trail', async () => {
    const { id, code } = await createPairingCode({ label: 'จอหลังร้าน', actorId: people.adminId });
    await redeemPairingCode(code);
    await revokeDisplayDevice({ id, actorId: people.adminId });

    const actions = (await prisma.audit_logs.findMany({ orderBy: { id: 'asc' } })).map(
      (row) => row.action,
    );
    expect(actions).toEqual(['display_paired', 'display_revoked']);
  });

  it('lists every screen, including one that was never paired', async () => {
    await createPairingCode({ label: 'จอที่ยังไม่จับคู่', actorId: people.adminId });

    const devices = await listDisplayDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.label).toBe('จอที่ยังไม่จับคู่');
    expect(devices[0]?.lastSeenAt).toBeNull();
  });

  it('never stores a token in the clear', async () => {
    const { id, code } = await createPairingCode({ label: 'จอตรวจ', actorId: people.adminId });
    const { token } = await redeemPairingCode(code);

    const row = await prisma.display_devices.findUniqueOrThrow({ where: { id: BigInt(id) } });
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toHaveLength(64);
  });
});
