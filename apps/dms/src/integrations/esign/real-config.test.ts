import { describe, expect, it } from 'vitest';
import { ESignProviderError } from './esign-provider.port';
import { loadRealProviderConfig, notImplemented, type RealProviderEnv } from './real-config';

const FULL: RealProviderEnv = {
  TRIDUM_BASE_URL: 'https://sandbox.tridum.example.test/',
  TRIDUM_CLIENT_ID: 'client-id-value',
  TRIDUM_CLIENT_SECRET: 'client-secret-value',
  TRIDUM_WEBHOOK_SECRET: 'webhook-secret-value',
};

function failure(prefix: 'TRIDUM' | 'MONPASS', env: RealProviderEnv): ESignProviderError {
  try {
    loadRealProviderConfig(prefix, env);
  } catch (err) {
    expect(err).toBeInstanceOf(ESignProviderError);
    return err as ESignProviderError;
  }
  throw new Error('expected loadRealProviderConfig to throw');
}

describe('loadRealProviderConfig', () => {
  it('бүрэн тохиргоог уншиж, baseUrl-ийн төгсгөлийн "/"-ийг хасна', () => {
    expect(loadRealProviderConfig('TRIDUM', FULL)).toEqual({
      baseUrl: 'https://sandbox.tridum.example.test',
      clientId: 'client-id-value',
      clientSecret: 'client-secret-value',
      webhookSecret: 'webhook-secret-value',
    });
  });

  it('MONPASS_ угтвартай хувьсагчуудыг уншина; TRIDUM_-ыг огт харахгүй', () => {
    const env = { ...FULL, MONPASS_BASE_URL: 'https://api.monpass.example.test/v1', MONPASS_CLIENT_ID: 'm-id', MONPASS_CLIENT_SECRET: 'm-secret', MONPASS_WEBHOOK_SECRET: 'm-hook' };
    expect(loadRealProviderConfig('MONPASS', env)).toMatchObject({ baseUrl: 'https://api.monpass.example.test/v1', clientId: 'm-id' });
    expect(failure('MONPASS', FULL).message).toMatch(/MONPASS_BASE_URL.*MONPASS_CLIENT_ID.*MONPASS_CLIENT_SECRET.*MONPASS_WEBHOOK_SECRET/);
  });

  it('юу ч байхгүй → NOT_CONFIGURED, дутуу бүх хувьсагчийн НЭР-ийг дурдана', () => {
    const err = failure('TRIDUM', {});
    expect(err).toMatchObject({ code: 'NOT_CONFIGURED', retryable: false });
    for (const name of ['TRIDUM_BASE_URL', 'TRIDUM_CLIENT_ID', 'TRIDUM_CLIENT_SECRET', 'TRIDUM_WEBHOOK_SECRET']) expect(err.message).toContain(name);
    expect(err.message).not.toContain('MONPASS');
  });

  it('зөвхөн дутуу хувьсагчийг нэрлэнэ; тохируулсан утгыг ХЭЗЭЭ Ч гаргахгүй', () => {
    const err = failure('TRIDUM', { ...FULL, TRIDUM_CLIENT_SECRET: undefined, TRIDUM_WEBHOOK_SECRET: '' });

    expect(err.message).toContain('TRIDUM_CLIENT_SECRET');
    expect(err.message).toContain('TRIDUM_WEBHOOK_SECRET');
    expect(err.message).not.toContain('TRIDUM_BASE_URL');
    expect(err.message).not.toContain('TRIDUM_CLIENT_ID');
    for (const value of ['client-id-value', 'sandbox.tridum', 'webhook-secret-value']) expect(err.message).not.toContain(value);
  });

  it('зөвхөн зайтай утга = дутуу', () => {
    const err = failure('TRIDUM', { ...FULL, TRIDUM_CLIENT_ID: '   ' });
    expect(err.message).toMatch(/missing TRIDUM_CLIENT_ID/);
  });

  it.each([
    ['URL биш', 'not a url'],
    ['http (loopback биш)', 'http://sandbox.tridum.example.test'],
    ['нэвтрэх мэдээлэлтэй URL', 'https://admin:hunter2@sandbox.tridum.example.test'],
    ['өөр протокол', 'ftp://sandbox.tridum.example.test'],
  ])('буруу BASE_URL (%s) → invalid, утгыг мессежид гаргахгүй', (_title, value) => {
    const err = failure('TRIDUM', { ...FULL, TRIDUM_BASE_URL: value });

    expect(err.code).toBe('NOT_CONFIGURED');
    expect(err.message).toMatch(/invalid TRIDUM_BASE_URL/);
    expect(err.message).not.toMatch(/missing/);
    expect(err.message).not.toContain('hunter2');
    expect(err.message).not.toContain(value);
  });

  it.each(['http://localhost:8080', 'http://127.0.0.1:9000/api'])('loopback дээрх http (%s) dev симуляторт зөвшөөрөгдөнө', (baseUrl) => {
    expect(loadRealProviderConfig('TRIDUM', { ...FULL, TRIDUM_BASE_URL: baseUrl }).baseUrl).toBe(baseUrl);
  });

  it('notImplemented: NOT_IMPLEMENTED, retryable биш, provider + method нэртэй', () => {
    const err = notImplemented('Tridum', 'createSession');
    expect(err).toMatchObject({ name: 'ESignProviderError', code: 'NOT_IMPLEMENTED', retryable: false });
    expect(err.message).toContain('Tridum');
    expect(err.message).toContain('createSession');
  });
});
