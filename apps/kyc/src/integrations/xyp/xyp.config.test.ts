import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from '../errors';
import { assertXypProductionConfig, loadXypConfig, XYP_DEFAULT_CITIZEN_WSDL, XYP_DEFAULT_META_WSDL, XYP_REQUIRED_ENV } from './xyp.config';

const keyPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const readOk = (): Buffer => Buffer.from(keyPem);
const ENV = { XYP_ACCESS_TOKEN: 'token-secret-value', XYP_PRIVATE_KEY_PATH: '/run/secrets/xyp.key' };
const PROD = { ...ENV, NODE_ENV: 'production', INTEGRATION_MODE: 'real' };
const messageOf = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } throw new Error('expected a throw'); };

describe('loadXypConfig', () => {
  it('утга, түлхүүр, анхдагч WSDL (gsb-ийн config.py-тай ижил), анхдагч timeout 15с', () => {
    const c = loadXypConfig(ENV, readOk);
    expect(c).toMatchObject({ accessToken: 'token-secret-value', citizenWsdlUrl: XYP_DEFAULT_CITIZEN_WSDL, timeoutMs: 15_000 });
    expect(c.privateKey.asymmetricKeyType).toBe('rsa');
    expect(XYP_DEFAULT_CITIZEN_WSDL).toBe('https://xyp.gov.mn/citizen-1.5.0/ws?WSDL');
  });

  it('WSDL URL болон timeout-ийг env-ээр дарна', () => {
    const c = loadXypConfig({ ...ENV, XYP_CITIZEN_WSDL_URL: 'https://x.example/ws?WSDL', XYP_TIMEOUT_MS: '5000' }, readOk);
    expect(c).toMatchObject({ citizenWsdlUrl: 'https://x.example/ws?WSDL', timeoutMs: 5000 });
  });

  it.each(XYP_REQUIRED_ENV)('%s дутуу/хоосон бол IntegrationNotConfiguredError (нэр л)', (name) => {
    for (const blank of [undefined, '', '  ']) {
      try {
        loadXypConfig({ ...ENV, [name]: blank }, readOk);
        throw new Error('expected a throw');
      } catch (e) {
        expect(e).toBeInstanceOf(IntegrationNotConfiguredError);
        expect((e as IntegrationNotConfiguredError).missing).toEqual([name]);
        expect((e as Error).message).not.toContain('token-secret-value');
      }
    }
  });

  it('түлхүүрийн файл уншигдахгүй → "(unreadable)"; хүчингүй түлхүүр → "(invalid)"; түлхүүрийн агуулгыг дурдахгүй', () => {
    const unreadable = messageOf(() => loadXypConfig(ENV, () => { throw new Error('ENOENT /secret/path'); }));
    expect(unreadable).toContain('XYP_PRIVATE_KEY_PATH (unreadable)');
    expect(unreadable).not.toContain('ENOENT');
    const invalid = messageOf(() => loadXypConfig(ENV, () => Buffer.from('NOT-A-KEY-CONTENT')));
    expect(invalid).toContain('XYP_PRIVATE_KEY_PATH (invalid)');
    expect(invalid).not.toContain('NOT-A-KEY-CONTENT');
  });

  it.each([['abc'], ['0'], ['-5'], ['Infinity']])('XYP_TIMEOUT_MS=%j буруу → "(invalid)"', (bad) => {
    expect(messageOf(() => loadXypConfig({ ...ENV, XYP_TIMEOUT_MS: bad }, readOk))).toContain('XYP_TIMEOUT_MS (invalid)');
  });
});

describe('XYP_CITIZEN_ENDPOINT_URL (SOAP endpoint-ийн тодорхой override)', () => {
  it('анхдагчаар байхгүй (undefined) — WSDL-ийн зарласан endpoint шалгагдана', () => {
    expect(loadXypConfig(ENV, readOk).endpointOverride).toBeUndefined();
  });
  it('тохируулсан бол уншигдана (төгсгөлийн хоосон зайг тайрна)', () => {
    expect(loadXypConfig({ ...ENV, XYP_CITIZEN_ENDPOINT_URL: ' https://xyp.example/citizen/ws ' }, readOk).endpointOverride).toBe('https://xyp.example/citizen/ws');
  });
  it.each([['not a url'], ['ftp://x.example/ws']])('буруу утга %j → "(invalid)"', (bad) => {
    expect(messageOf(() => loadXypConfig({ ...ENV, XYP_CITIZEN_ENDPOINT_URL: bad }, readOk))).toContain('XYP_CITIZEN_ENDPOINT_URL (invalid)');
  });
  it('production + real: override http бол эхлэхгүй; https бол зөвшөөрнө', () => {
    expect(() => assertXypProductionConfig({ ...PROD, XYP_CITIZEN_ENDPOINT_URL: 'http://xyp.example/ws' }, readOk)).toThrow(/XYP_CITIZEN_ENDPOINT_URL/);
    expect(() => assertXypProductionConfig({ ...PROD, XYP_CITIZEN_ENDPOINT_URL: 'https://xyp.example/ws' }, readOk)).not.toThrow();
  });
});

// WS100008 (иргэний кодыг илгээх) нь `meta` WSDL-д (vendor demo OTPApprove.py: https://xyp.gov.mn/meta-1.5.0/ws?WSDL); citizen-ээс тусдаа WSDL, endpoint.
describe('XYP_META_WSDL_URL / XYP_META_ENDPOINT_URL (иргэний код хүсэх)', () => {
  it('анхдагч meta WSDL (vendor demo), endpoint override байхгүй', () => {
    expect(XYP_DEFAULT_META_WSDL).toBe('https://xyp.gov.mn/meta-1.5.0/ws?WSDL');
    expect(loadXypConfig(ENV, readOk)).toMatchObject({ metaWsdlUrl: XYP_DEFAULT_META_WSDL, metaEndpointOverride: undefined });
  });
  it('env-ээр дарна (trim)', () => {
    const c = loadXypConfig({ ...ENV, XYP_META_WSDL_URL: ' https://m.example/ws?WSDL ', XYP_META_ENDPOINT_URL: ' https://m.example/meta/ws ' }, readOk);
    expect(c).toMatchObject({ metaWsdlUrl: 'https://m.example/ws?WSDL', metaEndpointOverride: 'https://m.example/meta/ws' });
  });
  it('XYP_META_ENDPOINT_URL буруу → "(invalid)"', () => {
    expect(messageOf(() => loadXypConfig({ ...ENV, XYP_META_ENDPOINT_URL: 'ftp://x.example/ws' }, readOk))).toContain('XYP_META_ENDPOINT_URL (invalid)');
  });
  it('production + real: meta WSDL / endpoint http бол эхлэхгүй (иргэний регистр, гарын үсэг http-ээр явахгүй); https бол зөвшөөрнө', () => {
    expect(() => assertXypProductionConfig({ ...PROD, XYP_META_WSDL_URL: 'http://xyp.gov.mn/meta?WSDL' }, readOk)).toThrow(/XYP_META_WSDL_URL/);
    expect(() => assertXypProductionConfig({ ...PROD, XYP_META_WSDL_URL: 'nope' }, readOk)).toThrow(/XYP_META_WSDL_URL/);
    expect(() => assertXypProductionConfig({ ...PROD, XYP_META_ENDPOINT_URL: 'http://xyp.example/meta' }, readOk)).toThrow(/XYP_META_ENDPOINT_URL/);
    expect(() => assertXypProductionConfig({ ...PROD, XYP_META_WSDL_URL: 'https://m.example/ws?WSDL', XYP_META_ENDPOINT_URL: 'https://m.example/meta' }, readOk)).not.toThrow();
  });
});

describe('assertXypProductionConfig (phase 5: production + real-д эхлэхээс сэргийлнэ)', () => {
  it('production биш / mock үед юу ч шалгахгүй (түлхүүрийн файл унших ч үгүй)', () => {
    const boom = (): Buffer => { throw new Error('must not read'); };
    expect(() => assertXypProductionConfig({ INTEGRATION_MODE: 'real' }, boom)).not.toThrow();
    expect(() => assertXypProductionConfig({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock' }, boom)).not.toThrow();
  });
  it('production + real + бүрэн тохиргоо → алдаагүй', () => {
    expect(() => assertXypProductionConfig(PROD, readOk)).not.toThrow();
  });
  it.each(XYP_REQUIRED_ENV)('production + real: %s дутуу бол эхлэхгүй', (name) => {
    expect(() => assertXypProductionConfig({ ...PROD, [name]: '' }, readOk)).toThrow(IntegrationNotConfiguredError);
  });
  it('production: түлхүүр хүчингүй / уншигдахгүй бол эхлэхгүй', () => {
    expect(() => assertXypProductionConfig(PROD, () => Buffer.from('junk'))).toThrow(/XYP_PRIVATE_KEY_PATH \(invalid\)/);
    expect(() => assertXypProductionConfig(PROD, () => { throw new Error('x'); })).toThrow(/XYP_PRIVATE_KEY_PATH \(unreadable\)/);
  });
  it('production: XYP_CITIZEN_WSDL_URL нь https байх ёстой (нууц гарын үсэг http-ээр явахгүй)', () => {
    expect(() => assertXypProductionConfig({ ...PROD, XYP_CITIZEN_WSDL_URL: 'http://xyp.gov.mn/ws?WSDL' }, readOk)).toThrow(/XYP_CITIZEN_WSDL_URL/);
    expect(() => assertXypProductionConfig({ ...PROD, XYP_CITIZEN_WSDL_URL: 'nope' }, readOk)).toThrow(/XYP_CITIZEN_WSDL_URL/);
  });
  it('production биш үед http WSDL (локал тест сервер) зөвшөөрөгдөнө', () => {
    expect(() => assertXypProductionConfig({ ...PROD, NODE_ENV: 'staging', XYP_CITIZEN_WSDL_URL: 'http://127.0.0.1:1/ws?WSDL' }, readOk)).not.toThrow();
  });
});
