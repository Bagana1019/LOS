import { describe, expect, it } from 'vitest';
import { configFromEnv, createFieldCrypto, maskAccountNo, maskRegisterNo } from './crypto';

const k = (n: number) => Buffer.alloc(32, n);
const make = (id = 'k1') => createFieldCrypto({ keys: { k1: k(1), k2: k(2) }, currentKeyId: id, indexKey: k(9) });

describe('field encryption (NFR-5)', () => {
  it('round-trips and never stores plaintext', () => {
    const c = make();
    const enc = c.encrypt('УБ12345678');
    expect(enc).not.toContain('УБ12345678');
    expect(enc.startsWith('v1.k1.')).toBe(true);
    expect(c.decrypt(enc)).toBe('УБ12345678');
  });
  it('uses a fresh IV each time', () => {
    const c = make();
    expect(c.encrypt('x')).not.toBe(c.encrypt('x'));
  });
  it('detects tampering and wrong AAD (ciphertext swapped between columns)', () => {
    const c = make();
    const enc = c.encrypt('5000123456', 'customer_bank_account.account_no');
    expect(c.decrypt(enc, 'customer_bank_account.account_no')).toBe('5000123456');
    expect(() => c.decrypt(enc, 'customer.register_no')).toThrow();
    expect(() => c.decrypt(enc)).toThrow();
    const parts = enc.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => c.decrypt(parts.join('.'))).toThrow();
    expect(() => c.decrypt('garbage')).toThrow(/Malformed/);
  });
  it('old ciphertexts stay readable after key rotation', () => {
    const old = make('k1').encrypt('secret');
    expect(make('k2').decrypt(old)).toBe('secret');
    expect(make('k2').encrypt('secret').startsWith('v1.k2.')).toBe(true);
    expect(() => createFieldCrypto({ keys: { k2: k(2) }, currentKeyId: 'k2', indexKey: k(9) }).decrypt(old)).toThrow(/Unknown encryption key/);
  });
  it('blind index is stable, case/space-insensitive and key-dependent', () => {
    const c = make();
    expect(c.blindIndex('УБ12345678')).toBe(c.blindIndex(' уб 12345678 '));
    expect(c.blindIndex('УБ12345678')).not.toBe(c.blindIndex('УБ12345679'));
    expect(c.blindIndex('УБ12345678')).toMatch(/^[0-9a-f]{64}$/);
    expect(createFieldCrypto({ keys: { k1: k(1) }, currentKeyId: 'k1', indexKey: k(8) }).blindIndex('УБ12345678')).not.toBe(c.blindIndex('УБ12345678'));
  });
  it('masks identifiers for UI and logs', () => {
    expect(maskRegisterNo('УБ12345678')).toBe('УБ****5678');
    expect(maskAccountNo('5000123456')).toBe('******3456');
    expect(maskAccountNo('12')).toBe('**');
  });
});

describe('configFromEnv', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  it('requires keys outside tests and validates their length', () => {
    expect(() => configFromEnv({ NODE_ENV: 'production' })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => configFromEnv({ DATA_ENCRYPTION_KEY: 'c2hvcnQ=', DATA_INDEX_KEY: key })).toThrow(/32 bytes/);
    expect(() => configFromEnv({ DATA_ENCRYPTION_KEY: key })).toThrow(/DATA_INDEX_KEY/);
  });
  it('parses a keyring and a current key id', () => {
    const cfg = configFromEnv({ DATA_ENCRYPTION_KEYS: `a:${key},b:${key}`, DATA_ENCRYPTION_KEY_ID: 'b', DATA_INDEX_KEY: key });
    expect(Object.keys(cfg.keys)).toEqual(['a', 'b']);
    expect(cfg.currentKeyId).toBe('b');
    expect(() => configFromEnv({ DATA_ENCRYPTION_KEYS: `a:${key}`, DATA_ENCRYPTION_KEY_ID: 'zz', DATA_INDEX_KEY: key })).toThrow(/keyring/);
  });
  it('uses fixed keys only under NODE_ENV=test', () => {
    expect(configFromEnv({ NODE_ENV: 'test' }).currentKeyId).toBe('t1');
  });
});
