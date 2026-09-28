/**
 * PromptPay QR payloads, built here rather than fetched from a payment provider.
 *
 * A PromptPay QR is not an opaque token issued by a bank: it is a short string of
 * EMVCo tag-length-value fields with a checksum, and every Thai bank app reads it
 * offline. That means the shop can mint one itself, which is why this module
 * exists — no merchant onboarding, no per-transaction fee, no third party told how
 * much the shop sold.
 *
 * The format, in the order the fields must appear:
 *
 *   00  payload format indicator      "01"
 *   01  point of initiation            "12" for a one-time, amount-specific code
 *   29  merchant account information   AID A000000677010111 + the PromptPay id
 *   53  transaction currency           "764" (THB)
 *   54  transaction amount             present only when the amount is locked
 *   58  country code                   "TH"
 *   59  merchant name                  optional, and not the shop's legal name
 *   62  additional data                the bill reference, when there is one
 *   63  CRC                            four hex digits, uppercase
 *
 * Two details are easy to get wrong and both are asserted in the tests. The
 * **mobile number is not a Thai phone number**: it is `0066` followed by the nine
 * digits after the leading zero, which makes thirteen characters — the same
 * length as a national id, and the reason a payload with the wrong one is
 * rejected rather than misdirected. And the **checksum covers the whole payload
 * including the `6304` prefix of its own field**, so it cannot be computed after
 * the string is assembled without that prefix.
 */
import { ConflictError, ValidationError } from './errors';
import { roundThb } from './money';

/** What kind of account the shop receives PromptPay transfers on. */
export type PromptPayIdType = 'mobile' | 'national_id' | 'ewallet';

export const PROMPTPAY_ID_TYPES: readonly PromptPayIdType[] = [
  'mobile',
  'national_id',
  'ewallet',
];

/** The PromptPay AID. Fixed by the scheme; not the shop's. */
const PROMPTPAY_AID = 'A000000677010111';

/** ISO 4217 numeric for Thai baht. */
const CURRENCY_THB = '764';

const COUNTRY_TH = 'TH';

/** Fields whose value cannot exceed 99 characters, because the length is 2 digits. */
const MAX_FIELD_LENGTH = 99;

/** Where a reference is carried: bill number, in the additional-data template. */
const REFERENCE_TAG = '01';
const REFERENCE_TEMPLATE = '62';

export interface PromptPayInput {
  /** The phone number, national id, or e-wallet id the shop receives on. */
  id: string;
  idType: PromptPayIdType;
  /** The amount to lock the code to. Required: this builder never emits an open code. */
  amountThb: number;
  /**
   * A reference the shop can match the transfer against — our payment intent's
   * own short code. Optional, and stripped to what the field allows: alphanumeric
   * only, because the banks' readers are not reliably tolerant of punctuation.
   */
  reference?: string;
  /** Shown in the customer's banking app. Kept short; the shop's name fits. */
  merchantName?: string;
}

/**
 * Normalises an account identifier into the form the payload carries.
 *
 * Every one of these is length-sensitive in a different way, which is why the
 * three cases are separate rather than one "digits only" rule:
 *
 *   * a mobile becomes `0066` + the nine digits after the leading zero, and so is
 *     written without its leading zero and with the country code padded;
 *   * a national id is exactly thirteen digits, unchanged;
 *   * an e-wallet id is exactly fifteen digits, unchanged.
 *
 * A number that is the wrong length is refused here rather than emitted, because
 * a malformed PromptPay payload does not fail loudly at the customer's phone: it
 * either shows nothing or, worse, resolves to a different account.
 */
export function normalisePromptPayId(idType: PromptPayIdType, raw: string): string {
  const digits = raw.replace(/[\s-()]/g, '');

  if (idType === 'mobile') {
    // Already-normalised input is accepted, so a stored value can be re-saved.
    if (/^0066\d{9}$/.test(digits)) {
      return digits;
    }
    if (!/^0\d{9}$/.test(digits)) {
      throw new ValidationError(
        'เบอร์พร้อมเพย์ต้องเป็นตัวเลข 10 หลัก ขึ้นต้นด้วย 0 เช่น 0812345678',
      );
    }
    return `0066${digits.slice(1)}`;
  }

  if (idType === 'national_id') {
    if (!/^\d{13}$/.test(digits)) {
      throw new ValidationError('เลขบัตรประชาชน/เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก');
    }
    return digits;
  }

  if (!/^\d{15}$/.test(digits)) {
    throw new ValidationError('รหัส e-Wallet ต้องเป็นตัวเลข 15 หลัก');
  }
  return digits;
}

/** The sub-tag that carries each kind of identifier inside tag 29. */
function idSubTag(idType: PromptPayIdType): string {
  switch (idType) {
    case 'mobile':
      return '01';
    case 'national_id':
      return '02';
    case 'ewallet':
      return '03';
  }
}

/**
 * Builds the payload string for one amount-specific QR code.
 *
 * The amount is locked (`53` currency, `54` amount) rather than left open, and the
 * point of initiation is set to `12` to say so. An open QR would let a customer
 * type any figure they liked into their banking app, which is the failure mode
 * this whole feature exists to prevent: the till generates a code for the bill,
 * and the code cannot be used for anything else.
 */
export function buildPromptPayPayload(input: PromptPayInput): string {
  const id = normalisePromptPayId(input.idType, input.id);

  if (!Number.isFinite(input.amountThb) || input.amountThb <= 0) {
    throw new ConflictError(
      'A PromptPay QR must be for a positive amount, so that the code cannot be reused for another bill',
      'INVALID_PROMPTPAY_AMOUNT',
    );
  }

  const amount = roundThb(input.amountThb).toFixed(2);
  if (amount.length > 13) {
    throw new ValidationError('ยอดเงินสำหรับ QR ยาวเกินไป');
  }

  const merchantAccount = tlv(
    '00',
    PROMPTPAY_AID,
  ) + tlv(idSubTag(input.idType), id);

  const fields = [
    tlv('00', '01'),
    tlv('01', '12'),
    tlv('29', merchantAccount),
    tlv('53', CURRENCY_THB),
    tlv('54', amount),
    tlv('58', COUNTRY_TH),
    ...(input.merchantName ? [tlv('59', sanitiseText(input.merchantName, 25))] : []),
    ...(input.reference ? [tlv(REFERENCE_TEMPLATE, tlv(REFERENCE_TAG, sanitiseReference(input.reference)))] : []),
  ];

  const withoutChecksum = fields.join('');
  // The CRC field's own id and length are part of what is checksummed, which is
  // why the string is extended before the digest rather than after it.
  return `${withoutChecksum}6304${crc16(`${withoutChecksum}6304`)}`;
}

/** `id + two-digit length + value`, and a refusal when the value cannot fit. */
function tlv(id: string, value: string): string {
  if (value.length > MAX_FIELD_LENGTH) {
    throw new ValidationError(`ช่อง ${id} ของ QR ยาวเกิน ${MAX_FIELD_LENGTH} ตัวอักษร`);
  }
  return `${id}${value.length.toString().padStart(2, '0')}${value}`;
}

/**
 * CRC-16/CCITT-FALSE over the ASCII bytes of the payload.
 *
 * Polynomial 0x1021, initial value 0xFFFF, no reflection, no final xor. The
 * canonical check value for this variant is that `"123456789"` hashes to 0x29B1,
 * which `tests/promptpay.test.ts` asserts — the one external anchor available for
 * a checksum nobody can eyeball.
 */
export function crc16(payload: string): string {
  let crc = 0xffff;

  for (const character of payload) {
    crc ^= character.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Stripped to letters, marks, digits and spaces.
 *
 * `\p{M}` is not decoration: Thai vowels and tone marks are combining marks
 * rather than letters, so a class of `\p{L}\p{N}` turns เหลี่ยมนอก into
 * เหลยมนอก — which is what the customer sees in their banking app.
 */
function sanitiseText(value: string, max: number): string {
  return value
    .replace(/[^\p{L}\p{M}\p{N} ]/gu, '')
    .trim()
    .slice(0, max);
}

/** The reference field is alphanumeric by convention; ours is a short code. */
function sanitiseReference(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').slice(0, 25);
}

/**
 * A QR is only useful if the shop can point a customer at a working one, so the
 * settings screen shows a preview. It is built from the same function the till
 * uses: a preview generated any other way could disagree with what the till
 * prints, which is exactly the class of bug a preview is supposed to catch.
 */
export function previewPromptPayPayload(input: {
  id: string;
  idType: PromptPayIdType;
  amountThb?: number;
}): string {
  return buildPromptPayPayload({
    id: input.id,
    idType: input.idType,
    amountThb: input.amountThb ?? 1,
    reference: 'TEST',
  });
}

/** What the settings screen says a given id type wants typed into it. */
export const PROMPTPAY_ID_LABELS: Record<PromptPayIdType, string> = {
  mobile: 'เบอร์มือถือที่ผูกพร้อมเพย์',
  national_id: 'เลขบัตรประชาชน / เลขประจำตัวผู้เสียภาษี',
  ewallet: 'รหัส e-Wallet (15 หลัก)',
};
