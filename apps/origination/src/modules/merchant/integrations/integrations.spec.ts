import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapturingLogger } from '../testing/capturing-logger';
import { DomainError } from '../domain/errors';
import { makePlanRecord } from '../testing/records';
import { BuyerScreeningPort, OtpGenerator, PricingProvider, SmsGateway } from '../ports';
import { DemoPiiCipher } from './demo-pii-cipher';
import { integrationProviders } from './integration.providers';
import { FixedOtpGenerator } from './otp/fixed-otp.generator';
import { RandomOtpGenerator } from './otp/random-otp.generator';
import { PlanPricingProvider } from './pricing/plan-pricing.provider';
import { MockSmsGateway } from './sms/mock-sms.gateway';
import { RealSmsGateway } from './sms/real-sms.gateway';
import { HttpBuyerScreening } from './screening/http-buyer-screening';
import { MockBuyerScreening } from './screening/mock-buyer-screening';
import { POS_CONFIG, loadPosConfig } from '../config/pos.config';
import { Clock } from '../ports';
import { FakeClock } from '../testing/fake-clock';

afterEach(() => vi.restoreAllMocks());

describe('MockSmsGateway', () => {
  it('records messages and logs only the masked phone, never the text or code', async () => {
    const logger = new CapturingLogger();
    Logger.overrideLogger(logger);
    const sms = new MockSmsGateway();
    await sms.send('99112212', 'Баталгаажуулах код 654321.');
    expect(sms.sent).toEqual([{ to: '99112212', text: 'Баталгаажуулах код 654321.' }]);
    expect(sms.lastCodeFor('99112212')).toBe('654321');
    expect(sms.lastCodeFor('88000000')).toBeNull();
    expect(logger.text).toContain('99****12');
    expect(logger.text).not.toContain('654321');
    expect(logger.text).not.toContain('99112212');
    expect(logger.text).not.toContain('Баталгаажуулах');
  });
  it('keeps a bounded history', async () => {
    const sms = new MockSmsGateway();
    for (let i = 0; i < 520; i++) await sms.send('99112212', `m${i}`);
    expect(sms.sent.length).toBe(500);
    expect(sms.sent.at(-1)?.text).toBe('m519');
  });
});

describe('RealSmsGateway', () => {
  it('is not configured yet: always SMS_UNAVAILABLE', async () => {
    const err = await new RealSmsGateway().send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('SMS_UNAVAILABLE');
    expect((err as DomainError).message).toBe('SMS operator is not configured');
  });
});

describe('OTP generators', () => {
  it('FixedOtpGenerator returns 123456', () => {
    expect(new FixedOtpGenerator().next()).toBe('123456');
    expect(new FixedOtpGenerator().next()).toBe('123456');
  });
  it('RandomOtpGenerator returns zero padded 6 digit codes', () => {
    const g = new RandomOtpGenerator();
    for (let i = 0; i < 200; i++) expect(g.next()).toMatch(/^\d{6}$/);
    const codes = new Set(Array.from({ length: 50 }, () => g.next()));
    expect(codes.size).toBeGreaterThan(40);
  });
});

describe('PlanPricingProvider', () => {
  it('uses the plan annual rate and fee rate', () => {
    expect(new PlanPricingProvider().resolve(makePlanRecord({ annualRate: 0.18, feeRate: 0.02 }))).toEqual({ annualRate: 0.18, feeRate: 0.02 });
  });
});

describe('DemoPiiCipher (DEMO ONLY)', () => {
  const c = new DemoPiiCipher();
  it('round trips and hashes deterministically', () => {
    const enc = c.encrypt('УЕ90051500');
    expect(enc).not.toContain('УЕ90051500');
    expect(c.decrypt(enc)).toBe('УЕ90051500');
    expect(c.hash('УЕ90051500')).toBe(c.hash('УЕ90051500'));
    expect(c.hash('УЕ90051500')).toMatch(/^[0-9a-f]{64}$/);
    expect(c.hash('УЕ90051500')).not.toBe(c.hash('УЕ90051501'));
  });
  it('refuses foreign ciphertext', () => {
    expect(() => c.decrypt('not-demo')).toThrow();
  });
});

describe('integrationProviders', () => {
  const clock = new FakeClock();
  const build = (mode: 'mock' | 'real') => {
    const cfg = loadPosConfig({ INTEGRATION_MODE: mode, POS_OTP_SECRET: 'a-sufficiently-long-secret' });
    const byToken = new Map<unknown, { useClass?: new () => unknown; useFactory?: (...a: unknown[]) => unknown; inject?: unknown[] }>();
    for (const p of integrationProviders(mode) as { provide: unknown; useClass?: new () => unknown; useFactory?: (...a: unknown[]) => unknown; inject?: unknown[] }[]) byToken.set(p.provide, p);
    const make = (token: unknown) => {
      const p = byToken.get(token)!;
      if (p.useClass) return new p.useClass();
      return p.useFactory!(...(p.inject ?? []).map((t) => (t === POS_CONFIG ? cfg : t === Clock ? clock : undefined)));
    };
    return make;
  };
  it('mock mode (default)', () => {
    const make = build('mock');
    expect(make(BuyerScreeningPort)).toBeInstanceOf(MockBuyerScreening);
    expect(make(SmsGateway)).toBeInstanceOf(MockSmsGateway);
    expect(make(OtpGenerator)).toBeInstanceOf(FixedOtpGenerator);
    expect(make(PricingProvider)).toBeInstanceOf(PlanPricingProvider);
  });
  it('real mode', () => {
    const make = build('real');
    expect(make(BuyerScreeningPort)).toBeInstanceOf(HttpBuyerScreening);
    expect(make(SmsGateway)).toBeInstanceOf(RealSmsGateway);
    expect(make(OtpGenerator)).toBeInstanceOf(RandomOtpGenerator);
  });
});
