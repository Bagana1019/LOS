import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Энд зөвхөн delegation-ийг (encrypt → encryptedField, decrypt → decryptedField) mock-оор шалгана; бодит AES-GCM нь @los/database-ийн crypto.test.ts-д.
vi.mock('@los/database', () => ({
  encryptedField: vi.fn((plain: string) => `enc(${plain})`),
  decryptedField: vi.fn((cipher: string) => `dec(${cipher})`),
}));

import { decryptedField, encryptedField } from '@los/database';
import { DatabasePiiCipher, DEV_PII_HASH_KEY } from './database-pii-cipher';

const KEY = 'unit-test-hmac-key';
const hmac = (key: string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest('hex');

describe('DatabasePiiCipher', () => {
  beforeEach(() => {
    vi.stubEnv('PII_HASH_KEY', KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to start without PII_HASH_KEY in production or INTEGRATION_MODE=real (no default key)', () => {
    vi.stubEnv('INTEGRATION_MODE', 'real');
    for (const value of ['', '   ']) {
      vi.stubEnv('PII_HASH_KEY', value);
      expect(() => new DatabasePiiCipher()).toThrow(/PII_HASH_KEY/);
    }
    delete process.env.PII_HASH_KEY;
    expect(() => new DatabasePiiCipher()).toThrow(/PII_HASH_KEY.*no default key/);
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.PII_HASH_KEY;
    expect(() => new DatabasePiiCipher()).toThrow(/PII_HASH_KEY/);
  });

  it('requires at least 16 characters (after trimming) in real mode and in production, like POS_OTP_SECRET', () => {
    const short = ['a', 'x'.repeat(15), `  ${'y'.repeat(15)}  `]; // тасалгаа/хоосон зай урт болохгүй
    vi.stubEnv('INTEGRATION_MODE', 'real');
    for (const value of short) {
      vi.stubEnv('PII_HASH_KEY', value);
      expect(() => new DatabasePiiCipher(), JSON.stringify(value)).toThrow(/PII_HASH_KEY must be at least 16 characters/);
    }
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_MODE', 'real');
    for (const value of short) {
      vi.stubEnv('PII_HASH_KEY', value);
      expect(() => new DatabasePiiCipher()).toThrow(/at least 16/);
    }
    vi.stubEnv('PII_HASH_KEY', 'z'.repeat(16)); // яг доод хэмжээ зөвшөөрнө
    expect(new DatabasePiiCipher().hash('УЕ12345678')).toBe(hmac('z'.repeat(16), 'УЕ12345678'));
  });

  it('never echoes the key in the error', () => {
    vi.stubEnv('INTEGRATION_MODE', 'real');
    vi.stubEnv('PII_HASH_KEY', 'short-secret');
    expect(() => new DatabasePiiCipher()).toThrow(expect.objectContaining({ message: expect.not.stringContaining('short-secret') }));
  });

  it('allows a short key in dev/mock (the minimum applies to real/production only) and trims the key before use', () => {
    vi.stubEnv('PII_HASH_KEY', 'short');
    expect(new DatabasePiiCipher().hash('УЕ12345678')).toBe(hmac('short', 'УЕ12345678'));
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('INTEGRATION_MODE', 'mock');
    vi.stubEnv('PII_HASH_KEY', `  ${KEY}\n`);
    expect(new DatabasePiiCipher().hash('УЕ12345678')).toBe(hmac(KEY, 'УЕ12345678'));
  });

  it('falls back to the DEV key only in non-production mock mode', () => {
    delete process.env.PII_HASH_KEY;
    vi.stubEnv('INTEGRATION_MODE', 'mock');
    vi.stubEnv('NODE_ENV', 'development');
    expect(new DatabasePiiCipher().hash('УЕ12345678')).toBe(hmac(DEV_PII_HASH_KEY, 'УЕ12345678'));
  });

  it('delegates encrypt and decrypt to @los/database', () => {
    const cipher = new DatabasePiiCipher();
    expect(cipher.encrypt('УЕ12345678')).toBe('enc(УЕ12345678)');
    expect(cipher.decrypt('xyz')).toBe('dec(xyz)');
    expect(encryptedField).toHaveBeenCalledWith('УЕ12345678');
    expect(decryptedField).toHaveBeenCalledWith('xyz');
  });

  it('hashes with HMAC-SHA256 hex over the normalised value', () => {
    const cipher = new DatabasePiiCipher();
    const h = cipher.hash('УЕ12345678');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hmac(KEY, 'УЕ12345678'));
    expect(h).not.toContain('12345678');
  });

  it('normalises case, whitespace and Unicode form before hashing', () => {
    const cipher = new DatabasePiiCipher();
    const canonical = cipher.hash('УЕ12345678');
    expect(cipher.hash('уе12345678')).toBe(canonical);
    expect(cipher.hash('  УЕ 1234 5678\n')).toBe(canonical);
    expect(cipher.hash('Й'.normalize('NFD'))).toBe(cipher.hash('Й'.normalize('NFC')));
    expect(cipher.hash('УЕ12345679')).not.toBe(canonical);
  });

  it('depends on the key', () => {
    const a = new DatabasePiiCipher().hash('УЕ12345678');
    vi.stubEnv('PII_HASH_KEY', 'another-key');
    const b = new DatabasePiiCipher().hash('УЕ12345678');
    expect(a).not.toBe(b);
    expect(b).toBe(hmac('another-key', 'УЕ12345678'));
  });
});
