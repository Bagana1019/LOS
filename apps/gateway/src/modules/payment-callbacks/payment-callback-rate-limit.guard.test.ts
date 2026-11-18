import { describe, expect, it } from 'vitest';
import { callbackRateLimits } from './payment-callback-rate-limit.guard';

describe('callbackRateLimits (H9)', () => {
  it('defaults: 1200/min per provider bucket, 600/min per-IP abuse ceiling', () => {
    expect(callbackRateLimits({})).toEqual({ perProvider: 1200, perIp: 600 });
    expect(callbackRateLimits({ PAYMENT_CALLBACK_RATE_LIMIT: '', PAYMENT_CALLBACK_IP_RATE_LIMIT: '' })).toEqual({ perProvider: 1200, perIp: 600 });
  });

  it('reads both from env', () => {
    expect(callbackRateLimits({ PAYMENT_CALLBACK_RATE_LIMIT: '5000', PAYMENT_CALLBACK_IP_RATE_LIMIT: '50' })).toEqual({ perProvider: 5000, perIp: 50 });
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects invalid value %s (no silent unlimited)', (v) => {
    expect(() => callbackRateLimits({ PAYMENT_CALLBACK_RATE_LIMIT: v })).toThrow(/PAYMENT_CALLBACK_RATE_LIMIT/);
    expect(() => callbackRateLimits({ PAYMENT_CALLBACK_IP_RATE_LIMIT: v })).toThrow(/PAYMENT_CALLBACK_IP_RATE_LIMIT/);
  });
});
