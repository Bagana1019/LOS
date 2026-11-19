import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from '../../errors';
import { DEFAULT_CIB_POLICY } from './cib.mapper';
import { assertSainScoreProductionConfig, loadSainScoreConfig, SAINSCORE_REQUIRED_ENV } from './sainscore.config';

const ENV = { SAINSCORE_BASE_URL: 'https://zms.example.mn/api/', SAINSCORE_USERNAME: 'lender', SAINSCORE_PASSWORD_HASH: 'hash-secret-value', SAINSCORE_PRODUCT_NO: '13611304' };
const PROD = { ...ENV, NODE_ENV: 'production', INTEGRATION_MODE: 'real' };
const messageOf = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } throw new Error('expected a throw'); };

describe('loadSainScoreConfig', () => {
  it('утгуудыг уншина; base URL-ийн төгсгөлийн / хасна; политик анхдагчаар', () => {
    expect(loadSainScoreConfig(ENV)).toEqual({ baseUrl: 'https://zms.example.mn/api', username: 'lender', passwordHash: 'hash-secret-value', productNo: '13611304', policy: DEFAULT_CIB_POLICY });
  });

  it.each(SAINSCORE_REQUIRED_ENV)('%s дутуу/хоосон бол IntegrationNotConfiguredError (нэр л, утга биш)', (name) => {
    for (const blank of [undefined, '', '   ']) {
      try {
        loadSainScoreConfig({ ...ENV, [name]: blank });
        throw new Error('expected a throw');
      } catch (e) {
        expect(e).toBeInstanceOf(IntegrationNotConfiguredError);
        expect((e as IntegrationNotConfiguredError).missing).toEqual([name]);
        expect((e as Error).message).not.toContain('hash-secret-value');
      }
    }
  });

  it('таамагласан хүү/босгыг env-ээр дарна (BR утгыг hardcode хийхгүй)', () => {
    const c = loadSainScoreConfig({ ...ENV, SAINSCORE_ASSUMED_MONTHLY_RATE_PCT: '3', SAINSCORE_ASSUMED_MONTHLY_RATE_LARGE_PCT: '2', SAINSCORE_LARGE_LOAN_THRESHOLD_MNT: '1000000' });
    expect(c.policy).toEqual({ assumedMonthlyRatePct: 3, largeLoanMonthlyRatePct: 2, largeLoanThresholdMnt: 1_000_000 });
  });

  it.each([['abc'], ['0'], ['-1'], ['NaN'], ['Infinity']])('политикийн утга %j буруу → IntegrationNotConfiguredError ("(invalid)", утгыг дурдахгүй)', (bad) => {
    const msg = messageOf(() => loadSainScoreConfig({ ...ENV, SAINSCORE_ASSUMED_MONTHLY_RATE_PCT: bad }));
    expect(msg).toContain('SAINSCORE_ASSUMED_MONTHLY_RATE_PCT (invalid)');
    expect(() => loadSainScoreConfig({ ...ENV, SAINSCORE_ASSUMED_MONTHLY_RATE_PCT: bad })).toThrow(IntegrationNotConfiguredError);
  });
});

describe('assertSainScoreProductionConfig', () => {
  it('production биш / mock үед юу ч шалгахгүй', () => {
    expect(() => assertSainScoreProductionConfig({ INTEGRATION_MODE: 'real' })).not.toThrow();
    expect(() => assertSainScoreProductionConfig({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock' })).not.toThrow();
  });
  it('production + real + бүрэн тохиргоо → алдаагүй', () => {
    expect(() => assertSainScoreProductionConfig(PROD)).not.toThrow();
  });
  it.each(SAINSCORE_REQUIRED_ENV)('production + real: %s дутуу бол апп эхлэхгүй', (name) => {
    expect(() => assertSainScoreProductionConfig({ ...PROD, [name]: '' })).toThrow(IntegrationNotConfiguredError);
  });
  it('production: SAINSCORE_BASE_URL нь https байх ёстой (Basic нууц hash, регистр, утас http-ээр явахгүй)', () => {
    expect(messageOf(() => assertSainScoreProductionConfig({ ...PROD, SAINSCORE_BASE_URL: 'http://zms.example.mn/api' }))).toContain('SAINSCORE_BASE_URL');
  });
  it('production: SAINSCORE_BASE_URL зөв URL биш бол апп эхлэхгүй', () => {
    expect(() => assertSainScoreProductionConfig({ ...PROD, SAINSCORE_BASE_URL: 'not a url' })).toThrow(/SAINSCORE_BASE_URL/);
  });
  it('production: буруу политикийн утга бас эхлэхээс сэргийлнэ (зөв тоцоололгүй хоцрогдлыг чимээгүй өнгөрөөхгүй)', () => {
    expect(() => assertSainScoreProductionConfig({ ...PROD, SAINSCORE_LARGE_LOAN_THRESHOLD_MNT: 'abc' })).toThrow(IntegrationNotConfiguredError);
  });
});
