// H9 — trusted provider source ranges (PAYMENT_CALLBACK_TRUSTED_CIDRS_<PROVIDER>), validated at startup.
import { describe, expect, it } from 'vitest';
import { loadTrustedSources, parseCidrList, trustedSourceWarnings } from './trusted-sources';

describe('parseCidrList', () => {
  it('accepts IPv4 and IPv6 CIDRs and bare addresses, comma-separated with spaces', () => {
    const list = parseCidrList('X', ' 203.0.113.0/24, 2001:db8::/32 ,198.51.100.7,2001:db8:ffff::1 ');
    for (const ip of ['203.0.113.0', '203.0.113.255', '2001:db8::1', '2001:db8:abcd::9', '198.51.100.7', '2001:db8:ffff::1']) expect(list(ip)).toBe(true);
    for (const ip of ['203.0.114.1', '198.51.100.8', '2001:db9::1', '10.0.0.1', '::1']) expect(list(ip)).toBe(false);
  });
  it('empty / unset → nothing trusted', () => {
    expect(parseCidrList('X', undefined)('203.0.113.1')).toBe(false);
    expect(parseCidrList('X', ' , ')('203.0.113.1')).toBe(false);
  });
  it('undefined or non-IP client address is never trusted', () => {
    const list = parseCidrList('X', '203.0.113.0/24');
    expect(list(undefined)).toBe(false);
    expect(list('not-an-ip')).toBe(false);
  });
  it('IPv4-mapped IPv6 client address matches the IPv4 range', () => {
    expect(parseCidrList('X', '203.0.113.0/24')('::ffff:203.0.113.4')).toBe(true);
  });
  it.each(['203.0.113.0/33', '2001:db8::/129', '203.0.113/24', '999.1.1.1', 'abc', '203.0.113.0/-1', '203.0.113.0/x', '203.0.113.0/24/1', '0.0.0.0/0', '::/0', '10.0.0.0/ 8'])(
    'rejects %s naming the variable (startup error)', (bad) => {
      expect(() => parseCidrList('PAYMENT_CALLBACK_TRUSTED_CIDRS_QPAY', `203.0.113.0/24,${bad}`)).toThrow(/PAYMENT_CALLBACK_TRUSTED_CIDRS_QPAY/);
    });
});

describe('loadTrustedSources', () => {
  it('ranges are per provider', () => {
    const t = loadTrustedSources({ PAYMENT_CALLBACK_TRUSTED_CIDRS_QPAY: '203.0.113.0/24', PAYMENT_CALLBACK_TRUSTED_CIDRS_SOCIALPAY: '198.51.100.0/24' });
    expect(t.isTrusted('QPAY', '203.0.113.9')).toBe(true);
    expect(t.isTrusted('QPAY', '198.51.100.9')).toBe(false);
    expect(t.isTrusted('SOCIALPAY', '198.51.100.9')).toBe(true);
    expect(t.isTrusted('SOCIALPAY', '203.0.113.9')).toBe(false);
    expect(t.unconfigured).toEqual([]);
  });
  it('reports providers without ranges', () => {
    expect(loadTrustedSources({ PAYMENT_CALLBACK_TRUSTED_CIDRS_QPAY: '203.0.113.0/24' }).unconfigured).toEqual(['SOCIALPAY']);
  });
  it('bad CIDR fails fast', () => {
    expect(() => loadTrustedSources({ PAYMENT_CALLBACK_TRUSTED_CIDRS_SOCIALPAY: '1.2.3.4/40' })).toThrow(/PAYMENT_CALLBACK_TRUSTED_CIDRS_SOCIALPAY/);
  });
});

describe('trustedSourceWarnings (production warns, never crashes)', () => {
  it('production + provider without ranges → one warning per provider', () => {
    const w = trustedSourceWarnings({ NODE_ENV: 'production', PAYMENT_CALLBACK_TRUSTED_CIDRS_QPAY: '203.0.113.0/24' });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/SOCIALPAY/);
    expect(w[0]).toMatch(/PAYMENT_CALLBACK_TRUSTED_CIDRS_SOCIALPAY/);
  });
  it('no warning outside production or when all providers are configured', () => {
    expect(trustedSourceWarnings({ NODE_ENV: 'development' })).toEqual([]);
    expect(trustedSourceWarnings({ NODE_ENV: 'production', PAYMENT_CALLBACK_TRUSTED_CIDRS_QPAY: '203.0.113.0/24', PAYMENT_CALLBACK_TRUSTED_CIDRS_SOCIALPAY: '2001:db8::/32' })).toEqual([]);
  });
});
