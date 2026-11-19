import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { MockQPayClient } from './qpay.mock';
import { RealQPayClient } from './qpay.real';
import { createQPayClient } from './qpay.provider';

// Phase 5: production + real горимд QPay-ийн тохиргоог bootstrap-д шалгана; sandbox руу чимээгүй заахыг хориглоно.
const clock = { now: () => new Date('2026-11-19T00:00:00Z') };
const REAL_PROD = {
  NODE_ENV: 'production', INTEGRATION_MODE_QPAY: 'real',
  QPAY_USERNAME: 'merchant', QPAY_PASSWORD: 'pw-secret-value', QPAY_INVOICE_CODE: 'LOS_INVOICE',
  QPAY_CALLBACK_BASE_URL: 'https://los.example.mn/api', QPAY_BASE_URL: 'https://merchant.qpay.mn/v2',
};
const messageOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  throw new Error('expected a throw');
};

describe('createQPayClient — production startup validation', () => {
  it('builds the real client when production config is complete and points at the live host', () => {
    expect(createQPayClient(clock, REAL_PROD)).toBeInstanceOf(RealQPayClient);
  });

  it.each(['QPAY_USERNAME', 'QPAY_PASSWORD', 'QPAY_INVOICE_CODE', 'QPAY_CALLBACK_BASE_URL', 'QPAY_BASE_URL'])('refuses to start when %s is missing in production + real (name only, never a value)', (name) => {
    const env = { ...REAL_PROD, [name]: '' };
    expect(() => createQPayClient(clock, env)).toThrow(IntegrationNotConfiguredError);
    expect(messageOf(() => createQPayClient(clock, env))).toContain(name);
    expect(messageOf(() => createQPayClient(clock, env))).not.toContain('pw-secret-value');
  });

  it('refuses the sandbox host in production (the default must not leak into prod)', () => {
    const msg = messageOf(() => createQPayClient(clock, { ...REAL_PROD, QPAY_BASE_URL: 'https://merchant-sandbox.qpay.mn/v2' }));
    expect(msg).toMatch(/sandbox/i);
    expect(msg).toContain('QPAY_BASE_URL');
  });

  it.each([['QPAY_BASE_URL', 'http://merchant.qpay.mn/v2'], ['QPAY_CALLBACK_BASE_URL', 'http://los.example.mn/api']])('refuses a non-https %s in production', (name, value) => {
    expect(messageOf(() => createQPayClient(clock, { ...REAL_PROD, [name]: value }))).toContain(name);
  });

  it('refuses a malformed QPAY_BASE_URL in production', () => {
    expect(() => createQPayClient(clock, { ...REAL_PROD, QPAY_BASE_URL: 'not a url' })).toThrow(/QPAY_BASE_URL/);
  });
});

describe('createQPayClient — outside production nothing changes', () => {
  it('real mode with missing config still builds (per-call IntegrationNotConfiguredError)', () => {
    const client = createQPayClient(clock, { INTEGRATION_MODE_QPAY: 'real' });
    expect(client).toBeInstanceOf(RealQPayClient);
    expect(client.isAvailable()).toBe(false);
  });

  it('real mode may use the sandbox default outside production', () => {
    expect(() => createQPayClient(clock, { ...REAL_PROD, NODE_ENV: 'staging', QPAY_BASE_URL: 'https://merchant-sandbox.qpay.mn/v2' })).not.toThrow();
  });

  it('mock mode (explicit, even in production) ignores QPay variables', () => {
    expect(createQPayClient(clock, { NODE_ENV: 'production', INTEGRATION_MODE_QPAY: 'mock' })).toBeInstanceOf(MockQPayClient);
    expect(createQPayClient(clock, {})).toBeInstanceOf(MockQPayClient);
  });
});
