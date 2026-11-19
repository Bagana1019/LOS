import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadXypPrivateKey, signXypRequest } from './xyp-signer';

// ХУР-ын хүсэлтийн гарын үсэг (gsb: mini_service/xyp_service/xyp_sign.py + xyp_client.py-аар баталгаажсан):
// signature = base64( RSASSA-PKCS1-v1_5 · SHA-256 ( "<accessToken>.<timeStamp>" ) ), timeStamp = epoch секунд (бүхэл, string).
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8Pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const pkcs1Pem = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const pkcs8Der = rsa.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
const pkcs1Der = rsa.privateKey.export({ type: 'pkcs1', format: 'der' }) as Buffer;
const verifies = (token: string, ts: string, sig: string): boolean => createVerify('RSA-SHA256').update(`${token}.${ts}`).verify(rsa.publicKey, sig, 'base64');
const key = loadXypPrivateKey(Buffer.from(pkcs8Pem));

describe('signXypRequest', () => {
  it('зөвхөн accessToken, timeStamp, signature гурван header-ийг буцаана', () => {
    expect(Object.keys(signXypRequest({ accessToken: 'TOKEN', privateKey: key, nowMs: 1_700_000_000_000 })).sort()).toEqual(['accessToken', 'signature', 'timeStamp']);
  });

  it('timeStamp = epoch секунд (бүхэл, string; миллисекундгүй, дугуйруулахгүй зөвхөн доош)', () => {
    expect(signXypRequest({ accessToken: 'T', privateKey: key, nowMs: 1_700_000_000_999 }).timeStamp).toBe('1700000000');
  });

  it('гарын үсэг "<accessToken>.<timeStamp>"-ийг RSA-SHA256 (PKCS1 v1.5)-ээр зурсан: нийтийн түлхүүрээр баталгаажна', () => {
    const s = signXypRequest({ accessToken: 'TOKEN', privateKey: key, nowMs: 1_700_000_000_000 });
    expect(s.accessToken).toBe('TOKEN');
    expect(verifies('TOKEN', s.timeStamp, s.signature)).toBe(true);
  });

  it('стандарт base64 (padding-тэй), 2048 битийн түлхүүрт 344 тэмдэгт', () => {
    const { signature } = signXypRequest({ accessToken: 'T', privateKey: key, nowMs: 1_700_000_000_000 });
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(signature).toHaveLength(344);
  });

  it('PKCS1 v1.5 тодорхойлогдох (deterministic): ижил оролт → ижил гарын үсэг; өөр хугацаа → өөр, мөн хуучнаар баталгаажихгүй', () => {
    const a = signXypRequest({ accessToken: 'T', privateKey: key, nowMs: 1_700_000_000_000 });
    expect(signXypRequest({ accessToken: 'T', privateKey: key, nowMs: 1_700_000_000_000 }).signature).toBe(a.signature);
    const b = signXypRequest({ accessToken: 'T', privateKey: key, nowMs: 1_700_000_001_000 });
    expect(b.signature).not.toBe(a.signature);
    expect(verifies('T', a.timeStamp, b.signature)).toBe(false);
  });

  it('өөр token-ий гарын үсгийг баталгаажуулахгүй', () => {
    const s = signXypRequest({ accessToken: 'T1', privateKey: key, nowMs: 1_700_000_000_000 });
    expect(verifies('T2', s.timeStamp, s.signature)).toBe(false);
  });
});

describe('loadXypPrivateKey (Python RSA.importKey-тэй адил: PEM/DER, PKCS#1/PKCS#8)', () => {
  it.each([['PKCS#8 PEM', Buffer.from(pkcs8Pem)], ['PKCS#1 PEM', Buffer.from(pkcs1Pem)], ['PKCS#8 DER', pkcs8Der], ['PKCS#1 DER', pkcs1Der]])('%s-ийг хүлээн авна', (_l, buf) => {
    const s = signXypRequest({ accessToken: 'T', privateKey: loadXypPrivateKey(buf), nowMs: 1_700_000_000_000 });
    expect(verifies('T', s.timeStamp, s.signature)).toBe(true);
  });

  it('хог/хоосон өгөгдлийг татгалзаж, өгөгдлийг алдаанд оруулахгүй', () => {
    const garbage = Buffer.from('SECRET-GARBAGE-NOT-A-KEY');
    try {
      loadXypPrivateKey(garbage);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/RSA/);
      expect((e as Error).message).not.toContain('SECRET-GARBAGE');
    }
    expect(() => loadXypPrivateKey(Buffer.alloc(0))).toThrow(/RSA/);
  });

  it('RSA биш түлхүүр (EC) татгалзана', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => loadXypPrivateKey(Buffer.from(ec))).toThrow(/RSA/);
  });
});
