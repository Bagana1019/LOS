// AesGcmPiiCipher / createPiiCipher (NFR-3). Бүх түлхүүр, регистр, нэр НЭЭЛТТЭЙ ХЭЛБЭРТЭЙ ХУУРМАГ (synthetic) утга.
import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesGcmPiiCipher, createPiiCipher, PiiCipherError, type PiiCipherErrorCode } from './pii-cipher';

const keyOf = (seed: number): string => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 0xff)).toString('base64');
const KEY_A = keyOf(1);
const KEY_B = keyOf(2);
const KEY_C = keyOf(3);
const cipherA = new AesGcmPiiCipher({ key: KEY_A });

const codeOf = (fn: () => unknown): PiiCipherErrorCode | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PiiCipherError);
    return (e as PiiCipherError).code;
  }
  return undefined;
};
/** base64url мөрийн `index` дахь тэмдэгтийн нэг битийг эргүүлнэ (байт түвшний өөрчлөлт) */
function flipByte(cipherText: string, byteIndex: number): string {
  const raw = Buffer.from(cipherText.slice(3), 'base64url');
  raw[byteIndex] ^= 0x01;
  return `v1:${raw.toString('base64url')}`;
}

describe('AesGcmPiiCipher: encrypt / decrypt', () => {
  it.each([
    ['ascii', 'UA12345678'],
    ['mongolian cyrillic with Ө/Ү', 'Өлзийбат Үүрэнтуяа, УА12345678'],
    ['empty string', ''],
    ['emoji + newline', 'тест 🙂\nline2'],
    ['long text', 'а'.repeat(50_000)],
  ])('round-trips %s', (_n, plain) => {
    expect(cipherA.decrypt(cipherA.encrypt(plain))).toBe(plain);
  });

  it("emits 'v1:' + base64url(nonce12 | ciphertext | tag16) and hides the plaintext", () => {
    const plain = 'MN12345678901234567890';
    const out = cipherA.encrypt(plain);
    expect(out).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    const raw = Buffer.from(out.slice(3), 'base64url');
    expect(raw.length).toBe(12 + Buffer.byteLength(plain) + 16);
    expect(out).not.toContain(plain);
    expect(raw.toString('utf8')).not.toContain(plain);
  });

  it('uses a fresh random nonce per call (same plaintext -> different output)', () => {
    const outs = new Set(Array.from({ length: 50 }, () => cipherA.encrypt('same')));
    expect(outs.size).toBe(50);
  });

  it('puts the injected nonce at the front and rejects a nonce source of the wrong size', () => {
    const nonce = Buffer.from(Array.from({ length: 12 }, (_, i) => 0xa0 + i));
    const fixed = new AesGcmPiiCipher({ key: KEY_A, randomBytes: () => nonce });
    expect(Buffer.from(fixed.encrypt('x').slice(3), 'base64url').subarray(0, 12)).toEqual(nonce);
    const bad = new AesGcmPiiCipher({ key: KEY_A, randomBytes: () => Buffer.alloc(8) });
    expect(() => bad.encrypt('x')).toThrow(/nonce/);
  });

  it('is compatible with the pinned format vector (guards HKDF salt/info, AAD and layout against accidental change)', () => {
    // Үүсгэсэн: key = bytes 1..32, nonce = 0xa0..0xab. Python `cryptography` (AESGCM + HKDF)-ээр бие даан баталгаажсан.
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
    const c = new AesGcmPiiCipher({ key });
    expect(c.decrypt('v1:oKGio6SlpqeoqaqrLcyo9DJNDkhP3g0D7NVRNmuBWSkLQ18hUwSVLw')).toBe('УА12345678');
    expect(c.hash('УА12345678')).toBe('bcb6e8ac5fe2b23a4343c9ecbc044a8e095f32549ecb3084317fbedbe258ac73');
    expect(c.decryptBytes(Buffer.from('AaChoqOkpaanqKmqqzyu8ZLRL7lywKr58ee4YBhVhny3+7YmnffIoofa1Q==', 'base64'), 'bsa/a/b.pdf').toString()).toBe(
      '%PDF-synthetic',
    );
  });

  it('rejects non-string input with TypeError', () => {
    expect(() => cipherA.encrypt(123 as unknown as string)).toThrow(TypeError);
    expect(codeOf(() => cipherA.decrypt(undefined as unknown as string))).toBe('INVALID_FORMAT');
  });
});

describe('AesGcmPiiCipher: tampering and malformed input (typed errors)', () => {
  const good = cipherA.encrypt('secret value');
  const total = Buffer.from(good.slice(3), 'base64url').length;

  it.each([
    ['nonce', 0],
    ['ciphertext body', 12],
    ['auth tag', total - 1],
  ])('rejects a flipped bit in the %s with AUTH_FAILED', (_n, idx) => {
    expect(codeOf(() => cipherA.decrypt(flipByte(good, idx)))).toBe('AUTH_FAILED');
  });

  it('rejects a ciphertext from another key with AUTH_FAILED', () => {
    expect(codeOf(() => new AesGcmPiiCipher({ key: KEY_B }).decrypt(good))).toBe('AUTH_FAILED');
  });

  it('rejects truncated input (shorter than nonce + tag) with INVALID_FORMAT', () => {
    expect(codeOf(() => cipherA.decrypt(`v1:${Buffer.alloc(27).toString('base64url')}`))).toBe('INVALID_FORMAT');
    expect(codeOf(() => cipherA.decrypt('v1:'))).toBe('INVALID_FORMAT');
  });

  it('rejects a payload cut in the middle: AUTH_FAILED (still long enough) — never returns garbage', () => {
    const cut = `v1:${Buffer.from(good.slice(3), 'base64url').subarray(0, total - 3).toString('base64url')}`;
    expect(codeOf(() => cipherA.decrypt(cut))).toBe('AUTH_FAILED');
  });

  it('rejects unknown versions with UNKNOWN_VERSION', () => {
    expect(codeOf(() => cipherA.decrypt(good.replace('v1:', 'v2:')))).toBe('UNKNOWN_VERSION');
    expect(codeOf(() => cipherA.decrypt(good.replace('v1:', 'v0:')))).toBe('UNKNOWN_VERSION');
  });

  it.each([
    ['plaintext leaked into storage', 'UA12345678'],
    ['empty string', ''],
    ['wrong prefix', 'x1:AAAA'],
    ['test cipher prefix', 't1:AAAA'],
    ['non base64url characters', 'v1:abc+/='],
    ['whitespace inside', 'v1:abc def'],
  ])('rejects %s with INVALID_FORMAT', (_n, value) => {
    expect(codeOf(() => cipherA.decrypt(value))).toBe('INVALID_FORMAT');
  });

  it('rejects non-canonical base64url (malleable trailing bits)', () => {
    // Сүүлийн тэмдэгтийн ашиглагдаагүй бит өөрчлөгдсөн ч ижил байт болох хувилбар
    const last = good.slice(-1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const variant = [...alphabet].find((ch) => ch !== last && Buffer.from(good.slice(3, -1) + ch, 'base64url').equals(Buffer.from(good.slice(3), 'base64url')));
    expect(variant).toBeDefined();
    expect(codeOf(() => cipherA.decrypt(good.slice(0, -1) + variant))).toBe('INVALID_FORMAT');
  });

  it('never puts plaintext, ciphertext or key material into error messages', () => {
    const msgs: string[] = [];
    for (const bad of [flipByte(good, 13), good.replace('v1:', 'v9:'), 'secret value']) {
      try {
        cipherA.decrypt(bad);
      } catch (e) {
        msgs.push((e as Error).message);
      }
    }
    expect(msgs).toHaveLength(3);
    for (const m of msgs) {
      expect(m).not.toContain('secret value');
      expect(m).not.toContain(good.slice(3, 20));
      expect(m).not.toContain(KEY_A);
    }
  });
});

describe('AesGcmPiiCipher: key validation', () => {
  const code = (key: string, prev?: string[]) => codeOf(() => new AesGcmPiiCipher({ key, previousKeys: prev }));
  it('accepts exactly 32 base64 bytes (surrounding whitespace trimmed)', () => {
    expect(code(KEY_A)).toBeUndefined();
    expect(code(`  ${KEY_A}\n`)).toBeUndefined();
  });
  it.each([
    ['16 bytes', Buffer.alloc(16, 1).toString('base64')],
    ['31 bytes', Buffer.alloc(31, 1).toString('base64')],
    ['33 bytes', Buffer.alloc(33, 1).toString('base64')],
    ['64 bytes', Buffer.alloc(64, 1).toString('base64')],
    ['hex string of 32 bytes', Buffer.alloc(32, 1).toString('hex')],
    ['base64url alphabet (-/_)', Buffer.from(Array.from({ length: 32 }, () => 0xfb)).toString('base64url') + '='],
    ['missing padding', KEY_A.replace(/=+$/, '')],
    ['not base64', '!!!not-base64!!!'],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('rejects %s with KEY_INVALID', (_n, key) => {
    expect(code(key)).toBe('KEY_INVALID');
  });
  it('reports which previous key is bad without echoing its value', () => {
    let msg = '';
    try {
      new AesGcmPiiCipher({ key: KEY_A, previousKeys: [KEY_B, 'c2hvcnQ='] });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('PII_ENCRYPTION_KEY_PREVIOUS[1]');
    expect(msg).not.toContain('c2hvcnQ=');
  });
});

describe('AesGcmPiiCipher: key rotation', () => {
  const oldCipher = new AesGcmPiiCipher({ key: KEY_B });
  const rotating = new AesGcmPiiCipher({ key: KEY_A, previousKeys: [KEY_B, KEY_C] });

  it('decrypts values written under a previous key and flags them for rotation', () => {
    const legacy = oldCipher.encrypt('legacy secret');
    expect(rotating.decrypt(legacy)).toBe('legacy secret');
    expect(rotating.needsRotation(legacy)).toBe(true);
    expect(rotating.needsRotation(rotating.encrypt('x'))).toBe(false);
    expect(rotating.previousKeyCount).toBe(2);
  });

  it('rotate() re-encrypts under the active key (readable without previous keys) and is a no-op for current values', () => {
    const legacy = oldCipher.encrypt('legacy secret');
    const rotated = rotating.rotate(legacy);
    expect(rotated).not.toBe(legacy);
    expect(cipherA.decrypt(rotated)).toBe('legacy secret');
    expect(rotating.needsRotation(rotated)).toBe(false);
    const current = rotating.encrypt('fresh');
    expect(rotating.rotate(current)).toBe(current);
  });

  it('always encrypts with the active key only', () => {
    expect(codeOf(() => oldCipher.decrypt(rotating.encrypt('new')))).toBe('AUTH_FAILED');
  });

  it('still rejects values from an unlisted key', () => {
    const foreign = new AesGcmPiiCipher({ key: keyOf(9) }).encrypt('foreign');
    expect(codeOf(() => rotating.decrypt(foreign))).toBe('AUTH_FAILED');
    expect(codeOf(() => rotating.needsRotation(foreign))).toBe('AUTH_FAILED');
  });

  it('ignores a previous key that equals the active key or repeats', () => {
    expect(new AesGcmPiiCipher({ key: KEY_A, previousKeys: [KEY_A, KEY_B, KEY_B] }).previousKeyCount).toBe(1);
  });

  it('hashCandidates() lists the active hash first, then one per previous key, so old rows stay findable', () => {
    const cands = rotating.hashCandidates(' уа12345678 ');
    expect(cands).toHaveLength(3);
    expect(cands[0]).toBe(rotating.hash('УА12345678'));
    expect(cands[1]).toBe(oldCipher.hash('УА12345678'));
    expect(new Set(cands).size).toBe(3);
  });

  it('bytes encrypted under a previous key remain readable', () => {
    const blob = oldCipher.encryptBytes(Buffer.from('file'), 'k1');
    expect(rotating.decryptBytes(blob, 'k1').toString()).toBe('file');
  });
});

describe('AesGcmPiiCipher: hash', () => {
  it('is deterministic 64-char hex', () => {
    const h = cipherA.hash('УА12345678');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(cipherA.hash('УА12345678')).toBe(h);
  });

  it('normalises: trim + uppercase (Cyrillic Ө/Ү included) + NFC', () => {
    const h = cipherA.hash('ӨҮ12345678');
    expect(cipherA.hash('  өү12345678\t')).toBe(h);
    expect(cipherA.hash('ӨҮ12345678')).toBe(h);
    // й = и + U+0306 (NFD) ↔ й (NFC)
    expect(cipherA.hash('ЙИ12345678')).toBe(cipherA.hash('йИ12345678'));
  });

  it('differs for different values and different keys', () => {
    expect(cipherA.hash('УА12345678')).not.toBe(cipherA.hash('УА12345679'));
    expect(cipherA.hash('УА12345678')).not.toBe(new AesGcmPiiCipher({ key: KEY_B }).hash('УА12345678'));
  });

  it('is a keyed HMAC over the HKDF "hash" subkey - not the raw key and not the encryption subkey', () => {
    const ikm = Buffer.from(KEY_A, 'base64');
    const sub = (info: string) => Buffer.from(hkdfSync('sha256', ikm, Buffer.from('los-radix/bsa/pii-cipher/v1'), info, 32));
    const hmac = (k: Buffer) => createHmac('sha256', k).update('УА12345678').digest('hex');
    expect(cipherA.hash('УА12345678')).toBe(hmac(sub('los/pii/hash/v1')));
    expect(cipherA.hash('УА12345678')).not.toBe(hmac(ikm));
    expect(cipherA.hash('УА12345678')).not.toBe(hmac(sub('los/pii/enc/v1')));
  });

  it('refuses empty / whitespace-only input (would collapse all blanks into one dedupe key)', () => {
    expect(codeOf(() => cipherA.hash(''))).toBe('EMPTY_INPUT');
    expect(codeOf(() => cipherA.hash(' \t\n'))).toBe('EMPTY_INPUT');
    expect(() => cipherA.hash(null as unknown as string)).toThrow(TypeError);
  });
});

describe('AesGcmPiiCipher: bytes', () => {
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 0xff));

  it('round-trips binary data incl. empty, and is not the identity', () => {
    const blob = cipherA.encryptBytes(bytes, 'bsa/org/a.pdf');
    expect(blob.length).toBe(1 + 12 + bytes.length + 16);
    expect(blob.includes(bytes.subarray(0, 64))).toBe(false);
    expect(cipherA.decryptBytes(blob, 'bsa/org/a.pdf').equals(bytes)).toBe(true);
    expect(cipherA.decryptBytes(cipherA.encryptBytes(Buffer.alloc(0), 'k'), 'k')).toHaveLength(0);
  });

  it('uses a per-object random nonce', () => {
    expect(cipherA.encryptBytes(bytes, 'k').equals(cipherA.encryptBytes(bytes, 'k'))).toBe(false);
  });

  it('binds the blob to its object key (AAD): moving it under another key fails', () => {
    const blob = cipherA.encryptBytes(bytes, 'bsa/a');
    expect(codeOf(() => cipherA.decryptBytes(blob, 'bsa/b'))).toBe('AUTH_FAILED');
  });

  it.each([
    ['header byte', 0, 'UNKNOWN_VERSION'],
    ['nonce', 1, 'AUTH_FAILED'],
    ['body', 20, 'AUTH_FAILED'],
    ['tag', -1, 'AUTH_FAILED'],
  ] as const)('detects a flipped bit in the %s', (_n, idx, expected) => {
    const blob = Buffer.from(cipherA.encryptBytes(bytes, 'k'));
    blob[idx < 0 ? blob.length + idx : idx] ^= 0x01;
    expect(codeOf(() => cipherA.decryptBytes(blob, 'k'))).toBe(expected);
  });

  it('rejects truncated blobs and non-buffers', () => {
    const blob = cipherA.encryptBytes(bytes, 'k');
    expect(codeOf(() => cipherA.decryptBytes(blob.subarray(0, 20), 'k'))).toBe('INVALID_FORMAT');
    expect(codeOf(() => cipherA.decryptBytes(blob.subarray(0, blob.length - 1), 'k'))).toBe('AUTH_FAILED');
    expect(codeOf(() => cipherA.decryptBytes('nope' as unknown as Buffer, 'k'))).toBe('INVALID_FORMAT');
    expect(() => cipherA.encryptBytes('nope' as unknown as Buffer, 'k')).toThrow(TypeError);
  });
});

describe('createPiiCipher(env)', () => {
  it('builds a cipher from PII_ENCRYPTION_KEY', () => {
    const c = createPiiCipher({ PII_ENCRYPTION_KEY: KEY_A });
    expect(cipherA.decrypt(c.encrypt('x'))).toBe('x');
    expect(c.previousKeyCount).toBe(0);
  });

  it('reads PII_ENCRYPTION_KEY_PREVIOUS as a comma list (spaces and empty members ignored)', () => {
    const c = createPiiCipher({ PII_ENCRYPTION_KEY: KEY_A, PII_ENCRYPTION_KEY_PREVIOUS: ` ${KEY_B} , ,${KEY_C},` });
    expect(c.previousKeyCount).toBe(2);
    expect(c.decrypt(new AesGcmPiiCipher({ key: KEY_C }).encrypt('old'))).toBe('old');
  });

  it.each([[undefined], [''], ['   ']])('throws KEY_MISSING when PII_ENCRYPTION_KEY is %j (in every environment)', (value) => {
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(codeOf(() => createPiiCipher({ PII_ENCRYPTION_KEY: value, NODE_ENV }))).toBe('KEY_MISSING');
    }
  });

  it('throws KEY_INVALID for a wrong-length key and for a bad previous key', () => {
    expect(codeOf(() => createPiiCipher({ PII_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }))).toBe('KEY_INVALID');
    expect(codeOf(() => createPiiCipher({ PII_ENCRYPTION_KEY: KEY_A, PII_ENCRYPTION_KEY_PREVIOUS: `${KEY_B},garbage` }))).toBe('KEY_INVALID');
  });
});
