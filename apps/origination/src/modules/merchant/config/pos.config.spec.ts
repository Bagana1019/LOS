import { describe, expect, it } from 'vitest';
import { MerchantModule } from '../merchant.module';
import { assertIntegrationSafe, DEV_OTP_SECRET, isProduction, loadPosConfig, parseKycBaseUrl, PosConfigError, readIntegrationMode } from './pos.config';

describe('loadPosConfig', () => {
  it('uses documented defaults in mock mode with a labelled dev secret', () => {
    const c = loadPosConfig({});
    expect(c).toMatchObject({
      integrationMode: 'mock', draftTtlMinutes: 60, referralTtlHours: 72, otpTtlSeconds: 300, otpMaxAttempts: 3, otpResendSeconds: 30, otpMaxSends: 5,
      kycBaseUrl: 'http://localhost:4002',
    });
    expect(c.otpSecret).toBe(DEV_OTP_SECRET);
    expect(DEV_OTP_SECRET).toMatch(/DEV-ONLY/);
  });
  it('reads overrides from the environment', () => {
    const c = loadPosConfig({
      POS_DRAFT_TTL_MINUTES: '15', POS_REFERRAL_TTL_HOURS: '24', POS_OTP_TTL_SECONDS: '120', POS_OTP_MAX_ATTEMPTS: '5', POS_OTP_RESEND_SECONDS: '10', POS_OTP_MAX_SENDS: '8',
      POS_OTP_SECRET: 'another-secret', KYC_BASE_URL: 'https://kyc.internal/', NODE_ENV: 'staging',
    });
    expect(c).toMatchObject({ draftTtlMinutes: 15, referralTtlHours: 24, otpTtlSeconds: 120, otpMaxAttempts: 5, otpResendSeconds: 10, otpMaxSends: 8, otpSecret: 'another-secret', kycBaseUrl: 'https://kyc.internal', nodeEnv: 'staging' });
  });
  it('rejects non-positive-integer numbers', () => {
    for (const v of ['0', '-1', 'abc', '1.5']) expect(() => loadPosConfig({ POS_OTP_TTL_SECONDS: v })).toThrow(PosConfigError);
    expect(loadPosConfig({ POS_OTP_TTL_SECONDS: '  ' }).otpTtlSeconds).toBe(300);
  });
  it('requires POS_OTP_SECRET (min 16 chars) in real mode', () => {
    expect(() => loadPosConfig({ INTEGRATION_MODE: 'real' })).toThrow(/POS_OTP_SECRET is required/);
    expect(() => loadPosConfig({ INTEGRATION_MODE: 'real', POS_OTP_SECRET: 'short' })).toThrow(/at least 16/);
    expect(loadPosConfig({ INTEGRATION_MODE: 'real', POS_OTP_SECRET: 'a-sufficiently-long-secret' })).toMatchObject({ integrationMode: 'real', otpSecret: 'a-sufficiently-long-secret' });
  });
  it('rejects unknown INTEGRATION_MODE values', () => {
    expect(() => readIntegrationMode({ INTEGRATION_MODE: 'live' })).toThrow(PosConfigError);
    expect(readIntegrationMode({})).toBe('mock');
    expect(readIntegrationMode({ INTEGRATION_MODE: ' REAL ' })).toBe('real');
  });
});

describe('KYC_BASE_URL validation (real mode)', () => {
  const real = { INTEGRATION_MODE: 'real', POS_OTP_SECRET: 'a-sufficiently-long-secret' };
  const load = (url: string) => loadPosConfig({ ...real, KYC_BASE_URL: url }).kycBaseUrl;

  it('accepts http/https origins (and an internal path prefix), normalising trailing slashes', () => {
    expect(load('http://kyc:4002')).toBe('http://kyc:4002');
    expect(load('  https://kyc.internal/  ')).toBe('https://kyc.internal');
    expect(load('http://kyc.internal:4002/internal//')).toBe('http://kyc.internal:4002/internal');
    expect(load('HTTP://KYC:4002')).toBe('http://kyc:4002');
  });
  it('rejects values that would only surface as SCREENING_UNAVAILABLE on every submit', () => {
    for (const bad of ['kyc:4002', 'localhost:4002', 'not a url', 'ftp://kyc', '//kyc:4002', 'http://kyc:4002/api', 'http://kyc:4002/api/', 'https://kyc/v1/API']) {
      expect(() => load(bad), bad).toThrow(PosConfigError);
    }
  });
  it('rejects credentials, queries and fragments, without echoing the value in the message', () => {
    for (const bad of ['http://user:secret-pass@kyc:4002', 'http://kyc:4002?x=1', 'http://kyc:4002/#frag']) {
      const err = (() => { try { load(bad); } catch (e) { return e as Error; } return null; })();
      expect(err, bad).toBeInstanceOf(PosConfigError);
      expect(err!.message).not.toContain('secret-pass');
      expect(err!.message).toContain('KYC_BASE_URL');
    }
  });
  it('is validated only where it is used: real mode (mock ignores a value meant for something else)', () => {
    expect(loadPosConfig({ KYC_BASE_URL: 'kyc:4002' }).kycBaseUrl).toBe('kyc:4002');
    expect(loadPosConfig({ KYC_BASE_URL: '' }).kycBaseUrl).toBe('http://localhost:4002');
  });
  it('parseKycBaseUrl is the shared validator', () => {
    expect(parseKycBaseUrl('http://kyc:4002/')).toBe('http://kyc:4002');
    expect(() => parseKycBaseUrl('')).toThrow(/absolute http/);
  });
});

describe('loadPosConfig(env, mode): the mode MerchantModule actually selects wins over the env', () => {
  it('an explicit mode overrides INTEGRATION_MODE so POS_CONFIG cannot diverge from the providers', () => {
    expect(loadPosConfig({ INTEGRATION_MODE: 'real', POS_OTP_SECRET: 'a-sufficiently-long-secret' }, 'mock').integrationMode).toBe('mock');
    expect(loadPosConfig({ POS_OTP_SECRET: 'a-sufficiently-long-secret' }, 'real').integrationMode).toBe('real');
    expect(loadPosConfig({ INTEGRATION_MODE: 'bogus' }, 'mock').integrationMode).toBe('mock'); // env-ийн утгыг огт уншихгүй
  });
  it('real-mode requirements and the production guard follow the explicit mode', () => {
    expect(() => loadPosConfig({}, 'real')).toThrow(/POS_OTP_SECRET is required/);
    expect(() => loadPosConfig({ NODE_ENV: 'production', INTEGRATION_MODE: 'real', POS_OTP_SECRET: 'a-sufficiently-long-secret', KYC_BASE_URL: 'http://kyc:4002' }, 'mock')).toThrow(/INTEGRATION_MODE=real/);
  });
});

describe('production guard (POS-sec)', () => {
  it('refuses NODE_ENV=production unless INTEGRATION_MODE=real', () => {
    expect(() => loadPosConfig({ NODE_ENV: 'production' })).toThrow(/INTEGRATION_MODE=real/);
    expect(() => loadPosConfig({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock' })).toThrow(PosConfigError);
    expect(() => assertIntegrationSafe({ nodeEnv: 'Production', integrationMode: 'mock' })).toThrow(PosConfigError);
    expect(() => assertIntegrationSafe({ nodeEnv: 'development', integrationMode: 'mock' })).not.toThrow();
    expect(() => assertIntegrationSafe({ nodeEnv: 'production', integrationMode: 'real' })).not.toThrow();
  });
  it('production + real still needs an explicit KYC_BASE_URL', () => {
    const env = { NODE_ENV: 'production', INTEGRATION_MODE: 'real', POS_OTP_SECRET: 'a-sufficiently-long-secret' };
    expect(() => loadPosConfig(env)).toThrow(/KYC_BASE_URL/);
    expect(loadPosConfig({ ...env, KYC_BASE_URL: 'https://kyc.internal' }).integrationMode).toBe('real');
  });
  it('isProduction reads NODE_ENV', () => {
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true);
    expect(isProduction({ NODE_ENV: 'test' })).toBe(false);
    expect(isProduction({})).toBe(false);
  });
  it('MerchantModule.register({ persistence: "memory" }) throws when NODE_ENV=production', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => MerchantModule.register({ persistence: 'memory' })).toThrow(/in-memory persistence is forbidden/);
      expect(() => MerchantModule.register({ persistence: 'prisma', integrationMode: 'real' })).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(() => MerchantModule.register({ persistence: 'memory' })).not.toThrow();
  });
});
