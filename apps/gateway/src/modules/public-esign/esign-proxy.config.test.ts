import { describe, expect, it } from 'vitest';
import { loadProxyConfig } from './esign-proxy.config';

describe('loadProxyConfig', () => {
  it('env-гүй үед dev default', () => {
    const c = loadProxyConfig({});
    expect(c.dmsBaseUrl).toBe('http://localhost:4005');
    expect(c.rateLimits).toEqual({ read: 60, poll: 60, action: 10, webhook: 600 });
    expect(c.bodyLimits).toEqual({ jsonBytes: 8192, webhookBytes: 65536 });
    expect(c.timeouts).toEqual({ headersMs: 15_000, jsonTotalMs: 15_000, pdfTotalMs: 120_000 });
  });

  it('DMS_URL-ийн төгсгөлийн "/"-ийг хасна; хоосон env нь default', () => {
    expect(loadProxyConfig({ DMS_URL: 'http://dms.internal:4005//' }).dmsBaseUrl).toBe('http://dms.internal:4005');
    expect(loadProxyConfig({ DMS_URL: '', ESIGN_RATE_LIMIT_PER_MIN: '' }).rateLimits.read).toBe(60);
  });

  it('ESIGN_RATE_LIMIT_PER_MIN нь read/poll-ийг тохируулна; action нь min(10, утга)', () => {
    expect(loadProxyConfig({ ESIGN_RATE_LIMIT_PER_MIN: '120' }).rateLimits).toMatchObject({ read: 120, poll: 120, action: 10 });
    expect(loadProxyConfig({ ESIGN_RATE_LIMIT_PER_MIN: '4' }).rateLimits).toMatchObject({ read: 4, action: 4 });
    expect(loadProxyConfig({ ESIGN_WEBHOOK_RATE_LIMIT_PER_MIN: '50' }).rateLimits.webhook).toBe(50);
  });

  it.each([
    { DMS_URL: 'ftp://dms' },
    { DMS_URL: 'not a url' },
    { ESIGN_RATE_LIMIT_PER_MIN: '0' },
    { ESIGN_RATE_LIMIT_PER_MIN: 'abc' },
    { ESIGN_RATE_LIMIT_PER_MIN: '1.5' },
    { ESIGN_WEBHOOK_RATE_LIMIT_PER_MIN: '-1' },
  ])('буруу env %j нь эхлэхэд алдаа', (env) => {
    expect(() => loadProxyConfig(env)).toThrow(/Invalid gateway proxy configuration/);
  });
});
