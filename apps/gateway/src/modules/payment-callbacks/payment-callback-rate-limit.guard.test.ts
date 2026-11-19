import { describe, expect, it } from 'vitest';
import { callbackRateLimits } from './payment-callback-rate-limit.guard';

describe('callbackRateLimits (H9)', () => {
  const DEFAULTS = { perProvider: 1200, perIp: 600, untrustedPerIp: 30, untrustedShared: 300 };
  it('defaults: 1200/min trusted provider bucket, 600/min trusted per-IP ceiling, 30/min untrusted per IP, 300/min untrusted shared', () => {
    expect(callbackRateLimits({})).toEqual(DEFAULTS);
    expect(callbackRateLimits({ PAYMENT_CALLBACK_RATE_LIMIT: '', PAYMENT_CALLBACK_IP_RATE_LIMIT: '', PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT: '', PAYMENT_CALLBACK_UNTRUSTED_RATE_LIMIT: '' })).toEqual(DEFAULTS);
  });

  it('reads all from env', () => {
    expect(callbackRateLimits({ PAYMENT_CALLBACK_RATE_LIMIT: '5000', PAYMENT_CALLBACK_IP_RATE_LIMIT: '50', PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT: '5', PAYMENT_CALLBACK_UNTRUSTED_RATE_LIMIT: '77' }))
      .toEqual({ perProvider: 5000, perIp: 50, untrustedPerIp: 5, untrustedShared: 77 });
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects invalid value %s (no silent unlimited)', (v) => {
    expect(() => callbackRateLimits({ PAYMENT_CALLBACK_RATE_LIMIT: v })).toThrow(/PAYMENT_CALLBACK_RATE_LIMIT/);
    expect(() => callbackRateLimits({ PAYMENT_CALLBACK_IP_RATE_LIMIT: v })).toThrow(/PAYMENT_CALLBACK_IP_RATE_LIMIT/);
    expect(() => callbackRateLimits({ PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT: v })).toThrow(/PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT/);
    expect(() => callbackRateLimits({ PAYMENT_CALLBACK_UNTRUSTED_RATE_LIMIT: v })).toThrow(/PAYMENT_CALLBACK_UNTRUSTED_RATE_LIMIT/);
  });
});
