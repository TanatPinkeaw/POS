// Seam under test: the code that proves a phone, and the gateway that carries it.
//
// The checking half needs a database and lives in `customer-identity.test.ts`; what
// is pinned here needs no network and no server: the shape of a code, when it
// expires, which `.env` turns the door on, and what a shop sees when its gateway is
// misconfigured — without the gateway's URL leaking into the message.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DomainError } from '@/lib/errors';
import {
  OTP_CODE_LENGTH,
  OtpDeliveryError,
  OtpNotConfiguredError,
  deliverOtpCode,
  generateOtpCode,
  isOtpCodeShaped,
  otpCodeExpiry,
  otpTtlMinutes,
  readOtpChannelConfig,
} from '@/lib/otp';

describe('a generated code', () => {
  it('is exactly the promised length of digits', () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const code = generateOtpCode();
      expect(code).toHaveLength(OTP_CODE_LENGTH);
      expect(isOtpCodeShaped(code)).toBe(true);
    }
  });

  it('does not repeat itself', () => {
    // Not a randomness proof — a canary for a generator that got hardcoded.
    const seen = new Set(Array.from({ length: 50 }, () => generateOtpCode()));
    expect(seen.size).toBeGreaterThan(40);
  });

  it('keeps leading zeros, so the code is the length a person was read', () => {
    // A million values formatted as an integer would drop them; the pad is why
    // `isOtpCodeShaped` is length-exact rather than "at most six".
    expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });
});

describe('the shape of a code', () => {
  it('accepts six digits, and trims whitespace a paste leaves behind', () => {
    expect(isOtpCodeShaped('012345')).toBe(true);
    expect(isOtpCodeShaped(' 012345 ')).toBe(true);
  });

  it('refuses anything that is not six digits', () => {
    for (const value of ['12345', '1234567', '12345a', '', 'abcdef', '12 345']) {
      expect(isOtpCodeShaped(value), value).toBe(false);
    }
  });
});

describe('when a code expires', () => {
  it('is the configured number of minutes after it was issued', () => {
    const issuedAt = new Date('2026-10-02T07:00:00.000Z');
    expect(otpCodeExpiry(issuedAt, 5).getTime() - issuedAt.getTime()).toBe(5 * 60_000);
  });

  it('defaults to five minutes', () => {
    const saved = process.env.OTP_TTL_MINUTES;
    delete process.env.OTP_TTL_MINUTES;
    try {
      expect(otpTtlMinutes()).toBe(5);
    } finally {
      if (saved !== undefined) {
        process.env.OTP_TTL_MINUTES = saved;
      }
    }
  });
});

describe('reading the OTP transport configuration', () => {
  it('is nothing when no channel is named, or when the name is unknown', () => {
    expect(readOtpChannelConfig({})).toBeNull();
    expect(readOtpChannelConfig({ OTP_CHANNEL: 'sms' })).toBeNull();
  });

  it('picks up the URL and secret a webhook channel needs', () => {
    const config = readOtpChannelConfig({
      OTP_CHANNEL: 'webhook',
      OTP_WEBHOOK_URL: 'https://sms.example/otp',
      OTP_WEBHOOK_SECRET: 's3cret',
    });
    expect(config).toEqual({ channel: 'webhook', url: 'https://sms.example/otp', secret: 's3cret' });
  });

  it('names the channel but leaves the URL null when it is missing', () => {
    expect(readOtpChannelConfig({ OTP_CHANNEL: 'webhook' })).toEqual({
      channel: 'webhook',
      url: null,
      secret: null,
    });
  });
});

describe('delivering a code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses when no URL is configured, and does not crash', async () => {
    await expect(
      deliverOtpCode('0800000000', '123456', { channel: 'webhook', url: null, secret: null }),
    ).rejects.toBeInstanceOf(OtpDeliveryError);
    await expect(deliverOtpCode('0800000000', '123456', null)).rejects.toBeInstanceOf(OtpDeliveryError);
  });

  it('reports an unreachable gateway without leaking its secret', async () => {
    // Port 9 is the discard port: a refused connection with no network access.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = (await deliverOtpCode('0800000000', '123456', {
      channel: 'webhook',
      url: 'http://127.0.0.1:9/send?token=super-secret',
      secret: 's3cret',
    }).catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(OtpDeliveryError);
    expect(failure.message).not.toContain('super-secret');
    expect(failure.message).not.toContain('s3cret');
  });

  it('fails as a domain error with a status, so the door answers rather than throwing a 500', () => {
    const notConfigured = new OtpNotConfiguredError();
    expect(notConfigured).toBeInstanceOf(DomainError);
    expect(notConfigured.httpStatus).toBe(503);
    expect(notConfigured.code).toBe('OTP_NOT_CONFIGURED');

    const delivery = new OtpDeliveryError();
    expect(delivery.httpStatus).toBe(502);
    expect(delivery.code).toBe('OTP_DELIVERY_FAILED');
  });
});
