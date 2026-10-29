import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POS_CONFIG, PosConfigError, type PosConfig } from './config/pos.config';
import { FixedOtpGenerator } from './integrations/otp/fixed-otp.generator';
import { RandomOtpGenerator } from './integrations/otp/random-otp.generator';
import { HttpBuyerScreening } from './integrations/screening/http-buyer-screening';
import { MockBuyerScreening } from './integrations/screening/mock-buyer-screening';
import { MockSmsGateway } from './integrations/sms/mock-sms.gateway';
import { RealSmsGateway } from './integrations/sms/real-sms.gateway';
import { MerchantModule } from './merchant.module';
import { BuyerScreeningPort, Clock, OtpGenerator, SmsGateway } from './ports';
import { FakeClock } from './testing/fake-clock';

afterEach(() => vi.unstubAllEnvs());

const SECRET = 'a-sufficiently-long-secret';

describe('MerchantModule.register: production guard follows the mode that actually selects providers', () => {
  it('refuses register({ integrationMode: "mock" }) under NODE_ENV=production, even when the env says real', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_MODE', 'real');
    vi.stubEnv('POS_OTP_SECRET', SECRET);
    expect(() => MerchantModule.register({ persistence: 'prisma', integrationMode: 'mock' })).toThrow(/NODE_ENV=production requires INTEGRATION_MODE=real/);
    expect(() => MerchantModule.register({ persistence: 'prisma', integrationMode: 'mock' })).toThrow(PosConfigError);
  });

  it('refuses the env-derived mock mode in production (INTEGRATION_MODE unset or mock)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_MODE', '');
    expect(() => MerchantModule.register({ persistence: 'prisma' })).toThrow(PosConfigError);
    vi.stubEnv('INTEGRATION_MODE', 'mock');
    expect(() => MerchantModule.register({ persistence: 'prisma' })).toThrow(PosConfigError);
  });

  it('refuses provider overrides in production (they could swap OTP / screening / SMS safeguards)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_MODE', 'real');
    const fixed = { provide: OtpGenerator, useClass: FixedOtpGenerator };
    expect(() => MerchantModule.register({ persistence: 'prisma', overrides: [fixed] })).toThrow(/overrides are forbidden/);
    expect(() => MerchantModule.register({ persistence: 'prisma', integrationMode: 'real', overrides: [{ provide: SmsGateway, useClass: MockSmsGateway }] })).toThrow(PosConfigError);
  });

  it('still registers a real-mode production module without overrides (empty overrides are fine)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_MODE', 'real');
    expect(() => MerchantModule.register({ persistence: 'prisma' })).not.toThrow();
    expect(() => MerchantModule.register({ persistence: 'prisma', integrationMode: 'real', overrides: [] })).not.toThrow();
  });

  it('allows overrides and mock mode outside production (tests, demo)', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(() => MerchantModule.register({ persistence: 'memory', integrationMode: 'mock', overrides: [{ provide: Clock, useValue: new FakeClock() }] })).not.toThrow();
  });
});

describe('MerchantModule.register: POS_CONFIG and the providers use the same mode', () => {
  async function resolve(opts: Parameters<typeof MerchantModule.register>[0]) {
    const moduleRef = await Test.createTestingModule({ imports: [MerchantModule.register({ persistence: 'memory', ...opts })] }).compile();
    const get = <T>(token: abstract new (...args: never[]) => T | symbol) => moduleRef.get(token as never, { strict: false }) as T;
    return { cfg: moduleRef.get<PosConfig>(POS_CONFIG, { strict: false }), screening: get(BuyerScreeningPort), sms: get(SmsGateway), otp: get(OtpGenerator) };
  }

  it('explicit "real" with an env that says mock: config is real (and demands the real secret) and providers are real', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('INTEGRATION_MODE', 'mock');
    await expect(resolve({ integrationMode: 'real' })).rejects.toThrow(/POS_OTP_SECRET is required/); // POS_CONFIG env-ийн mock-оор "амжилттай" болохгүй
    vi.stubEnv('POS_OTP_SECRET', SECRET);
    const r = await resolve({ integrationMode: 'real' });
    expect(r.cfg.integrationMode).toBe('real');
    expect(r.screening).toBeInstanceOf(HttpBuyerScreening);
    expect(r.sms).toBeInstanceOf(RealSmsGateway);
    expect(r.otp).toBeInstanceOf(RandomOtpGenerator);
  });

  it('explicit "mock" with an env that says real: config is mock and providers are mock', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('INTEGRATION_MODE', 'real');
    vi.stubEnv('POS_OTP_SECRET', SECRET);
    const r = await resolve({ integrationMode: 'mock' });
    expect(r.cfg.integrationMode).toBe('mock');
    expect(r.screening).toBeInstanceOf(MockBuyerScreening);
    expect(r.sms).toBeInstanceOf(MockSmsGateway);
    expect(r.otp).toBeInstanceOf(FixedOtpGenerator);
  });

  it('without an explicit mode both follow INTEGRATION_MODE', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('INTEGRATION_MODE', 'mock');
    const r = await resolve({});
    expect([r.cfg.integrationMode, r.otp instanceof FixedOtpGenerator]).toEqual(['mock', true]);
  });
});
