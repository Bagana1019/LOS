import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOCK_APPROVE_AFTER_MS,
  DEV_MOCK_WEBHOOK_SECRET,
  IntegrationsConfigError,
  loadIntegrationsConfig,
  MAX_MOCK_APPROVE_AFTER_MS,
} from './integrations.config';

function failure(env: Record<string, string | undefined>): IntegrationsConfigError {
  try {
    loadIntegrationsConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(IntegrationsConfigError);
    return err as IntegrationsConfigError;
  }
  throw new Error('expected loadIntegrationsConfig to throw');
}

describe('loadIntegrationsConfig', () => {
  it('env хоосон → mock горим, default 3000мс, dev webhook нууц', () => {
    expect(loadIntegrationsConfig({})).toEqual({ mode: 'mock', approveAfterMs: DEFAULT_MOCK_APPROVE_AFTER_MS, webhookSecret: DEV_MOCK_WEBHOOK_SECRET });
    expect(DEFAULT_MOCK_APPROVE_AFTER_MS).toBe(3000);
  });

  it('docker-compose-ийн хоосон `VAR=` утгыг тохируулаагүй гэж үзнэ', () => {
    expect(loadIntegrationsConfig({ INTEGRATION_MODE: '', MOCK_ESIGN_APPROVE_AFTER_MS: ' ', MOCK_ESIGN_WEBHOOK_SECRET: '' })).toEqual({
      mode: 'mock',
      approveAfterMs: 3000,
      webhookSecret: DEV_MOCK_WEBHOOK_SECRET,
    });
  });

  it('mock тохиргоог env-ээс авна', () => {
    expect(loadIntegrationsConfig({ INTEGRATION_MODE: 'mock', MOCK_ESIGN_APPROVE_AFTER_MS: '250', MOCK_ESIGN_WEBHOOK_SECRET: 'a-sufficiently-long-secret' })).toEqual({
      mode: 'mock',
      approveAfterMs: 250,
      webhookSecret: 'a-sufficiently-long-secret',
    });
    expect(loadIntegrationsConfig({ MOCK_ESIGN_APPROVE_AFTER_MS: '0' })).toMatchObject({ approveAfterMs: 0 });
  });

  it('real горим; mock хувьсагчуудыг (буруу байсан ч) үл тоомсорлоно', () => {
    expect(loadIntegrationsConfig({ INTEGRATION_MODE: 'real', MOCK_ESIGN_APPROVE_AFTER_MS: 'abc', MOCK_ESIGN_WEBHOOK_SECRET: 'x' })).toEqual({ mode: 'real' });
  });

  it.each(['sandbox', 'MOCK', 'Real', 'true'])('буруу INTEGRATION_MODE="%s" → эхлэхэд алдаа', (mode) => {
    const err = failure({ INTEGRATION_MODE: mode });
    expect(err.message).toMatch(/Invalid INTEGRATION_MODE/);
    expect(err.message).toMatch(/mock, real/);
  });

  it('NODE_ENV=production + mock (тодорхой) → алдаа', () => {
    expect(failure({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock' }).message).toMatch(/not allowed when NODE_ENV=production/);
  });

  it('NODE_ENV=production + INTEGRATION_MODE тохируулаагүй (default mock) → алдаа, real болгохыг зөвлөнө', () => {
    const err = failure({ NODE_ENV: 'production' });
    expect(err.message).toMatch(/defaults to mock/);
    expect(err.message).toMatch(/INTEGRATION_MODE=real/);
  });

  it('NODE_ENV=production + real → зөвшөөрнө; development/test + mock → зөвшөөрнө', () => {
    expect(loadIntegrationsConfig({ NODE_ENV: 'production', INTEGRATION_MODE: 'real' })).toEqual({ mode: 'real' });
    expect(loadIntegrationsConfig({ NODE_ENV: 'development' }).mode).toBe('mock');
    expect(loadIntegrationsConfig({ NODE_ENV: 'test' }).mode).toBe('mock');
  });

  it.each(['abc', '-1', '1.5', String(MAX_MOCK_APPROVE_AFTER_MS + 1), 'Infinity'])('буруу MOCK_ESIGN_APPROVE_AFTER_MS="%s" → алдаа', (value) => {
    expect(failure({ MOCK_ESIGN_APPROVE_AFTER_MS: value }).message).toMatch(/MOCK_ESIGN_APPROVE_AFTER_MS/);
  });

  it('богино MOCK_ESIGN_WEBHOOK_SECRET → алдаа, мессежид нууцын утга орохгүй', () => {
    const err = failure({ MOCK_ESIGN_WEBHOOK_SECRET: 'short-secret' });
    expect(err.message).toMatch(/MOCK_ESIGN_WEBHOOK_SECRET/);
    expect(err.message).not.toContain('short-secret');
  });
});
