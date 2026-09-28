// Seam under test: the PromptPay QR a customer scans.
//
// This is money leaving a customer's account, and the failure mode is silent: a
// malformed payload does not throw in the bank's app, it either shows nothing or
// resolves to the wrong account. So the tests are about the parts that are
// length-sensitive or order-sensitive — the checksum, the normalised identifier,
// and the tag structure — rather than about the happy path.
import { describe, expect, it } from 'vitest';

import { ConflictError, ValidationError } from '@/lib/errors';
import { buildPromptPayPayload, crc16, normalisePromptPayId } from '@/lib/promptpay';

/** Splits a payload into its top-level TLVs, so the shape can be asserted. */
function readTlv(payload: string): Map<string, string> {
  const fields = new Map<string, string>();
  let index = 0;
  while (index < payload.length) {
    const id = payload.slice(index, index + 2);
    const length = Number(payload.slice(index + 2, index + 4));
    fields.set(id, payload.slice(index + 4, index + 4 + length));
    index += 4 + length;
  }
  return fields;
}

describe('the checksum', () => {
  it('matches the published check value for CRC-16/CCITT-FALSE', () => {
    // The canonical test vector for this variant: "123456789" → 0x29B1. Without
    // an external anchor, a checksum implementation is only self-consistent.
    expect(crc16('123456789')).toBe('29B1');
  });

  it('is four uppercase hex digits', () => {
    expect(crc16('')).toMatch(/^[0-9A-F]{4}$/);
    expect(crc16('0002010102')).toMatch(/^[0-9A-F]{4}$/);
  });
});

describe('normalising the account id', () => {
  it('turns a Thai mobile number into the scheme\u2019s 0066 form', () => {
    expect(normalisePromptPayId('mobile', '0812345678')).toBe('0066812345678');
    expect(normalisePromptPayId('mobile', '081-234-5678')).toBe('0066812345678');
  });

  it('accepts an id that is already normalised, so a saved value can be re-saved', () => {
    expect(normalisePromptPayId('mobile', '0066812345678')).toBe('0066812345678');
  });

  it('keeps a national id as thirteen digits', () => {
    expect(normalisePromptPayId('national_id', '1234567890123')).toBe('1234567890123');
  });

  it('refuses a number of the wrong length rather than misdirecting the transfer', () => {
    expect(() => normalisePromptPayId('mobile', '081234567')).toThrow(ValidationError);
    expect(() => normalisePromptPayId('mobile', '08123456789')).toThrow(ValidationError);
    expect(() => normalisePromptPayId('national_id', '123456789012')).toThrow(ValidationError);
    expect(() => normalisePromptPayId('ewallet', '1234567890')).toThrow(ValidationError);
  });

  it('makes a mobile and a national id the same length, which is why the tag differs', () => {
    expect(normalisePromptPayId('mobile', '0812345678')).toHaveLength(13);
    expect(normalisePromptPayId('national_id', '1234567890123')).toHaveLength(13);
  });
});

describe('the payload', () => {
  const payload = buildPromptPayPayload({
    id: '0812345678',
    idType: 'mobile',
    amountThb: 155,
  });

  it('starts with the payload format indicator and ends with the checksum', () => {
    expect(payload.startsWith('000201')).toBe(true);
    expect(payload.slice(-8, -4)).toBe('6304');
    expect(payload.slice(-4)).toBe(crc16(payload.slice(0, -4)));
  });

  it('declares a one-time, amount-locked code', () => {
    const fields = readTlv(payload);
    expect(fields.get('00')).toBe('01');
    expect(fields.get('01')).toBe('12');
    expect(fields.get('54')).toBe('155.00');
    expect(fields.get('53')).toBe('764');
    expect(fields.get('58')).toBe('TH');
  });

  it('carries the PromptPay AID and the normalised id inside tag 29', () => {
    const merchant = readTlv(payload).get('29') ?? '';
    expect(merchant.startsWith('0016A000000677010111')).toBe(true);
    expect(merchant.slice(-17)).toBe('01130066812345678');
  });

  it('carries a reference, so a transfer can be matched to a bill', () => {
    const withReference = buildPromptPayPayload({
      id: '0812345678',
      idType: 'mobile',
      amountThb: 20,
      reference: 'INT-4F2A',
    });

    // Seven characters, so the inner field is `0107`, inside a `62` field of ten.
    const additional = readTlv(withReference).get('62') ?? '';
    expect(additional).toBe('0107INT4F2A');
  });

  it('strips punctuation out of a reference rather than emitting it', () => {
    const withPunctuation = buildPromptPayPayload({
      id: '0812345678',
      idType: 'mobile',
      amountThb: 20,
      reference: '4F-2A/99',
    });

    expect(readTlv(withPunctuation).get('62')).toBe('01064F2A99');
  });

  it('is stable: the same bill produces the same payload', () => {
    const again = buildPromptPayPayload({ id: '0812345678', idType: 'mobile', amountThb: 155 });
    expect(again).toBe(payload);
  });

  it('changes when the amount changes, so one code cannot pay another bill', () => {
    const other = buildPromptPayPayload({ id: '0812345678', idType: 'mobile', amountThb: 156 });
    expect(other).not.toBe(payload);
    expect(readTlv(other).get('54')).toBe('156.00');
  });

  it('locks to two decimal places, because the field is a string', () => {
    const rounded = buildPromptPayPayload({
      id: '0812345678',
      idType: 'mobile',
      amountThb: 35.5,
    });
    expect(readTlv(rounded).get('54')).toBe('35.50');
  });

  it('refuses a non-positive amount', () => {
    expect(() =>
      buildPromptPayPayload({ id: '0812345678', idType: 'mobile', amountThb: 0 }),
    ).toThrow(ConflictError);
    expect(() =>
      buildPromptPayPayload({ id: '0812345678', idType: 'mobile', amountThb: -5 }),
    ).toThrow(ConflictError);
  });

  it('refuses an id that would make the payload unresolvable', () => {
    expect(() =>
      buildPromptPayPayload({ id: '1234', idType: 'national_id', amountThb: 10 }),
    ).toThrow(ValidationError);
  });

  it('omits the merchant name when none is given, and includes it when it is', () => {
    expect(readTlv(payload).has('59')).toBe(false);

    const named = buildPromptPayPayload({
      id: '0812345678',
      idType: 'mobile',
      amountThb: 10,
      merchantName: 'เหลี่ยมนอก มินิมาร์ท',
    });
    expect(readTlv(named).get('59')).toBe('เหลี่ยมนอก มินิมาร์ท');
  });

  it('writes a field length as two digits even when the value is short', () => {
    // Tag 58 is "TH", so its length byte must read 02 and not "2" — a single
    // digit here shifts every following field by one and breaks the checksum.
    expect(payload).toContain('5802TH');
  });
});
