// FieldCryptoPiiCipher / createPiiCipher (NFR-3) — foundation-ий `@los/database` crypto дээрх adapter. Бүх түлхүүр, регистр, нэр НЭЭЛТТЭЙ ХЭЛБЭРТЭЙ ХУУРМАГ (synthetic) утга.
import { blindIndex, createFieldCrypto, resetFieldCrypto, type FieldCryptoConfig } from '@los/database';
import { afterEach, describe, expect, it } from 'vitest';
import { createPiiCipher, FieldCryptoPiiCipher, PII_FIELD_AAD, PiiCipherError, type PiiCipherErrorCode } from './pii-cipher';

const keyBuf = (seed: number): Buffer => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 0xff));
const b64 = (seed: number): string => keyBuf(seed).toString('base64');
const INDEX = keyBuf(9);
const configOf = (current: string, ...ids: Array<[string, number]>): FieldCryptoConfig => ({
  keys: Object.fromEntries(ids.map(([id, seed]) => [id, keyBuf(seed)])),
  currentKeyId: current,
  indexKey: INDEX,
});
const configA = configOf('k1', ['k1', 1]);
const cipherA = new FieldCryptoPiiCipher(configA);

const codeOf = (fn: () => unknown): PiiCipherErrorCode | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PiiCipherError);
    return (e as PiiCipherError).code;
  }
  return undefined;
};

describe('FieldCryptoPiiCipher: encrypt / decrypt', () => {
  it.each([
    ['ascii', 'UA12345678'],
    ['mongolian cyrillic with Ө/Ү', 'Өлзийбат Үүрэнтуяа, УА12345678'],
    ['empty string', ''],
    ['emoji + newline', 'тест 🙂\nline2'],
    ['long text', 'а'.repeat(50_000)],
  ])('round-trips %s', (_n, plain) => {
    expect(cipherA.decrypt(cipherA.encrypt(plain))).toBe(plain);
  });

  it('emits the foundation field format v1.<keyId>.<iv>.<tag>.<ct> and hides the plaintext; fresh nonce per call', () => {
    const plain = 'MN12345678901234567890';
    const c1 = cipherA.encrypt(plain);
    expect(c1).toMatch(/^v1\.k1\.[\w-]+\.[\w-]+\.[\w-]*$/);
    expect(c1).not.toContain(plain);
    expect(cipherA.encrypt(plain)).not.toBe(c1);
  });

  it('is bound to the BSA field (AAD): a value sealed for another field does not decrypt here', () => {
    const other = createFieldCrypto(configA).encrypt('УА12345678', 'customer.register_no');
    expect(codeOf(() => cipherA.decrypt(other))).toBe('AUTH_FAILED');
    expect(createFieldCrypto(configA).decrypt(cipherA.encrypt('УА12345678'), PII_FIELD_AAD)).toBe('УА12345678');
  });

  it('rejects non-string input', () => {
    expect(() => cipherA.encrypt(123 as unknown as string)).toThrow(TypeError);
    expect(codeOf(() => cipherA.decrypt(undefined as unknown as string))).toBe('INVALID_FORMAT');
  });

  it('rejects malformed values with INVALID_FORMAT and tampered / foreign-key values with AUTH_FAILED — never garbage', () => {
    expect(codeOf(() => cipherA.decrypt('plain text'))).toBe('INVALID_FORMAT');
    expect(codeOf(() => cipherA.decrypt('v2.k1.a.b.c'))).toBe('INVALID_FORMAT');
    expect(codeOf(() => cipherA.decrypt('v1:legacy'))).toBe('INVALID_FORMAT');
    const sealed = cipherA.encrypt('Бат-Эрдэнэ');
    const parts = sealed.split('.');
    const tampered = [...parts.slice(0, 4), Buffer.from(Buffer.from(parts[4], 'base64url').map((b) => b ^ 1)).toString('base64url')].join('.');
    expect(codeOf(() => cipherA.decrypt(tampered))).toBe('AUTH_FAILED');
    expect(codeOf(() => cipherA.decrypt(sealed.replace('.k1.', '.k9.')))).toBe('AUTH_FAILED'); // үл мэдэгдэх keyId
    expect(codeOf(() => new FieldCryptoPiiCipher(configOf('k1', ['k1', 2])).decrypt(sealed))).toBe('AUTH_FAILED'); // өөр түлхүүр
  });

  it('never puts plaintext, ciphertext or key material into error messages', () => {
    const plain = 'СЕКРЕТ-УА12345678';
    const sealed = cipherA.encrypt(plain);
    const messages: string[] = [];
    for (const fn of [() => cipherA.decrypt(sealed.slice(0, -2)), () => cipherA.decrypt(sealed.replace('.k1.', '.zz.')), () => cipherA.hash('  ')]) {
      try {
        fn();
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(messages).toHaveLength(3);
    for (const m of messages) {
      expect(m).not.toContain(plain);
      expect(m).not.toContain(sealed);
      expect(m).not.toContain(keyBuf(1).toString('base64'));
    }
  });
});

describe('FieldCryptoPiiCipher: key rotation (foundation keyring)', () => {
  const oldCipher = new FieldCryptoPiiCipher(configOf('k1', ['k1', 1]));
  const rotated = new FieldCryptoPiiCipher(configOf('k2', ['k1', 1], ['k2', 2]));

  it('decrypts values written under a previous key and flags them for rotation; encrypts with the active key only', () => {
    const old = oldCipher.encrypt('УА12345678');
    expect(rotated.decrypt(old)).toBe('УА12345678');
    expect(rotated.needsRotation(old)).toBe(true);
    expect(rotated.encrypt('x')).toMatch(/^v1\.k2\./);
    expect(rotated.needsRotation(rotated.encrypt('x'))).toBe(false);
  });

  it('rotate() re-encrypts under the active key (readable without the previous key) and is a no-op for current values', () => {
    const fresh = rotated.rotate(oldCipher.encrypt('УА12345678'));
    expect(fresh).toMatch(/^v1\.k2\./);
    expect(new FieldCryptoPiiCipher(configOf('k2', ['k2', 2])).decrypt(fresh)).toBe('УА12345678');
    const current = rotated.encrypt('y');
    expect(rotated.rotate(current)).toBe(current);
  });

  it('still rejects values from a key that is not in the keyring', () => {
    expect(codeOf(() => rotated.decrypt(new FieldCryptoPiiCipher(configOf('k3', ['k3', 3])).encrypt('z')))).toBe('AUTH_FAILED');
  });
});

describe('FieldCryptoPiiCipher: hash', () => {
  it('is deterministic 64-char hex and equals the foundation blindIndex (origination register_no_hash)', () => {
    const h = cipherA.hash('УА12345678');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(cipherA.hash('УА12345678')).toBe(h);
    expect(h).toBe(createFieldCrypto(configA).blindIndex('УА12345678'));
  });

  it('normalises case (Cyrillic Ө/Ү included) and whitespace; differs for different values and index keys', () => {
    expect(cipherA.hash('уа 12345678')).toBe(cipherA.hash('УА12345678'));
    expect(cipherA.hash('өү12345678')).toBe(cipherA.hash('ӨҮ12345678'));
    expect(cipherA.hash('УА12345678')).not.toBe(cipherA.hash('УА12345679'));
    expect(new FieldCryptoPiiCipher({ ...configA, indexKey: keyBuf(8) }).hash('УА12345678')).not.toBe(cipherA.hash('УА12345678'));
  });

  it('refuses empty / whitespace-only input (would collapse all blanks into one dedupe key) and non-strings', () => {
    expect(codeOf(() => cipherA.hash(''))).toBe('EMPTY_INPUT');
    expect(codeOf(() => cipherA.hash(' \t\n'))).toBe('EMPTY_INPUT');
    expect(() => cipherA.hash(1 as unknown as string)).toThrow(TypeError);
  });
});

describe('FieldCryptoPiiCipher: bytes (statement files)', () => {
  it('round-trips binary data incl. empty, is not the identity, and uses a per-call random nonce', () => {
    const plain = Buffer.from([0, 1, 2, 255, 254, 37, 80, 68, 70]);
    const blob = cipherA.encryptBytes(plain, 'bsa/a/b.pdf');
    expect(blob.equals(plain)).toBe(false);
    expect(cipherA.decryptBytes(blob, 'bsa/a/b.pdf').equals(plain)).toBe(true);
    expect(cipherA.decryptBytes(cipherA.encryptBytes(Buffer.alloc(0), 'k'), 'k')).toHaveLength(0);
    expect(cipherA.encryptBytes(plain, 'k').equals(cipherA.encryptBytes(plain, 'k'))).toBe(false);
  });

  it('rejects a nonce source of the wrong size', () => {
    const bad = new FieldCryptoPiiCipher(configA, { randomBytes: () => Buffer.alloc(8) });
    expect(() => bad.encryptBytes(Buffer.from('x'), 'k')).toThrow(/nonce/);
  });

  it('binds the blob to its object key (AAD): moving it under another key fails', () => {
    const blob = cipherA.encryptBytes(Buffer.from('%PDF-synthetic'), 'bsa/org/1.pdf');
    expect(codeOf(() => cipherA.decryptBytes(blob, 'bsa/org/2.pdf'))).toBe('AUTH_FAILED');
  });

  it('detects tampering, truncation, wrong format byte, unknown key id and non-buffers', () => {
    const blob = cipherA.encryptBytes(Buffer.from('%PDF-synthetic'), 'k');
    const flipped = Buffer.from(blob);
    flipped[flipped.length - 20] ^= 1;
    expect(codeOf(() => cipherA.decryptBytes(flipped, 'k'))).toBe('AUTH_FAILED');
    expect(codeOf(() => cipherA.decryptBytes(blob.subarray(0, 10), 'k'))).toBe('INVALID_FORMAT');
    expect(codeOf(() => cipherA.decryptBytes(Buffer.from([1]), 'k'))).toBe('INVALID_FORMAT');
    expect(codeOf(() => cipherA.decryptBytes('x' as unknown as Buffer, 'k'))).toBe('INVALID_FORMAT');
    const wrongFormat = Buffer.from(blob);
    wrongFormat[0] = 0x01;
    expect(codeOf(() => cipherA.decryptBytes(wrongFormat, 'k'))).toBe('UNKNOWN_VERSION');
    expect(codeOf(() => new FieldCryptoPiiCipher(configOf('k2', ['k2', 2])).decryptBytes(blob, 'k'))).toBe('AUTH_FAILED');
    expect(() => cipherA.encryptBytes('x' as unknown as Buffer, 'k')).toThrow(TypeError);
  });

  it('files encrypted under a previous key stay readable after rotation', () => {
    const blob = new FieldCryptoPiiCipher(configOf('k1', ['k1', 1])).encryptBytes(Buffer.from('old file'), 'k');
    const rotated = new FieldCryptoPiiCipher(configOf('k2', ['k1', 1], ['k2', 2]));
    expect(rotated.decryptBytes(blob, 'k').toString()).toBe('old file');
    expect(rotated.encryptBytes(Buffer.from('new'), 'k').subarray(2, 4).toString()).toBe('k2');
  });
});

describe('createPiiCipher(env)', () => {
  afterEach(() => resetFieldCrypto());

  it('builds a cipher from DATA_ENCRYPTION_KEY + DATA_INDEX_KEY and matches the foundation blindIndex for the same env', () => {
    const env = { DATA_ENCRYPTION_KEY: b64(1), DATA_INDEX_KEY: b64(9) };
    const c = createPiiCipher(env);
    expect(c.decrypt(c.encrypt('УА12345678'))).toBe('УА12345678');
    Object.assign(process.env, env);
    resetFieldCrypto();
    try {
      expect(c.hash('УА12345678')).toBe(blindIndex('УА12345678'));
    } finally {
      delete process.env.DATA_ENCRYPTION_KEY;
      delete process.env.DATA_INDEX_KEY;
    }
  });

  it('reads the keyring DATA_ENCRYPTION_KEYS with DATA_ENCRYPTION_KEY_ID', () => {
    const env = { DATA_ENCRYPTION_KEYS: `k1:${b64(1)},k2:${b64(2)}`, DATA_ENCRYPTION_KEY_ID: 'k2', DATA_INDEX_KEY: b64(9) };
    expect(createPiiCipher(env).encrypt('x')).toMatch(/^v1\.k2\./);
  });

  it('falls back to the foundation test key only when NODE_ENV=test', () => {
    expect(createPiiCipher({ NODE_ENV: 'test' }).encrypt('x')).toMatch(/^v1\.t1\./);
    expect(codeOf(() => createPiiCipher({ NODE_ENV: 'production' }))).toBe('KEY_MISSING');
    expect(codeOf(() => createPiiCipher({}))).toBe('KEY_MISSING');
  });

  it('throws KEY_INVALID for a wrong-length key, a bad index key or an unknown current key id — without echoing the value', () => {
    const short = Buffer.alloc(16, 5).toString('base64');
    let message = '';
    try {
      createPiiCipher({ DATA_ENCRYPTION_KEY: short, DATA_INDEX_KEY: b64(9) });
    } catch (e) {
      expect((e as PiiCipherError).code).toBe('KEY_INVALID');
      message = (e as Error).message;
    }
    expect(message).not.toContain(short);
    expect(codeOf(() => createPiiCipher({ DATA_ENCRYPTION_KEY: b64(1), DATA_INDEX_KEY: short }))).toBe('KEY_INVALID');
    expect(codeOf(() => createPiiCipher({ DATA_ENCRYPTION_KEY: b64(1), DATA_ENCRYPTION_KEY_ID: 'zz', DATA_INDEX_KEY: b64(9) }))).toBe('KEY_INVALID');
  });
});
