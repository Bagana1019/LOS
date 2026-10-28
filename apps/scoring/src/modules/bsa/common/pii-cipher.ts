// NFR-3: PII шифрлэлт (AES-256-GCM) + тэнцүүгээр хайх keyed hash (HMAC-SHA256). PiiCipher port-ийн хэрэгжүүлэлт.
// ТҮР ХЭРЭГЖҮҮЛЭЛТ: packages/database-ийн `encryptedField` (M00, pgcrypto wrapper) бэлэн болтол BSA-ийн өөрийн adapter. Түлхүүрийн
// удирдлага (KMS/rotation) тэнд шийдэгдэнэ; тэр үед `createPiiCipher` нэг мөр болж солигдоно (README: "Түр шийдэл").
//
// Формат: 'v1:' + base64url(nonce[12] | ciphertext | tag[16]). Түлхүүр: PII_ENCRYPTION_KEY (base64, яг 32 байт) → HKDF-SHA256-оор
// тусдаа дэд түлхүүрүүд (шифр / hash / файл). Ингэснээр нэг түлхүүрийг шифрлэлт, HMAC-д давхар ашиглахгүй.
// Нууц ба PII-г ХЭЗЭЭ Ч алдааны мессеж/логт оруулахгүй (түлхүүр, plaintext, ciphertext).
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { envString, splitList, type EnvLike } from './env';
import type { PiiCipher } from './infra.ports';

export type PiiCipherErrorCode = 'KEY_MISSING' | 'KEY_INVALID' | 'INVALID_FORMAT' | 'UNKNOWN_VERSION' | 'AUTH_FAILED' | 'EMPTY_INPUT';

export class PiiCipherError extends Error {
  constructor(readonly code: PiiCipherErrorCode, message: string) {
    super(message);
    this.name = 'PiiCipherError';
  }
}

/** Файлын bytes-ийг шифрлэх (EncryptingObjectStore хэрэглэнэ). `aad` = объектын түлхүүр: blob-ыг өөр түлхүүр рүү зөөхөөс хамгаална */
export interface ByteCipher {
  encryptBytes(plain: Buffer, aad: string): Buffer;
  decryptBytes(blob: Buffer, aad: string): Buffer;
}

export const PII_CIPHER_VERSION = 'v1';
const PREFIX = `${PII_CIPHER_VERSION}:`;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Файлын формат: 1 байт хувилбар | nonce | ciphertext | tag */
const FILE_FORMAT_BYTE = 0x01;

// HKDF тогтмолууд: salt нууц биш (домэйн тусгаарлагч). info өөрчлөх = бүх хуучин өгөгдөл уншигдахгүй болно — ХЭЗЭЭ Ч өөрчлөхгүй.
const HKDF_SALT = Buffer.from('los-radix/bsa/pii-cipher/v1', 'utf8');
const HKDF_INFO = { enc: 'los/pii/enc/v1', hash: 'los/pii/hash/v1', file: 'los/file/enc/v1' } as const;
const STRING_AAD = Buffer.from('los-pii-string-v1', 'utf8');
const FILE_AAD_PREFIX = 'los-pii-file-v1\0';

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const ENVELOPE_RE = /^(v\d{1,3}):([\s\S]*)$/;

interface SubKeys {
  enc: Buffer;
  hash: Buffer;
  file: Buffer;
}

export interface AesGcmPiiCipherOptions {
  /** Идэвхтэй түлхүүр: base64, яг 32 байт */
  key: string;
  /** Rotation: зөвхөн ТАЙЛАХад ашиглагдах хуучин түлхүүрүүд (base64) */
  previousKeys?: readonly string[];
  /** Тестэд тогтмол nonce шалгахад. Анхдагч: crypto.randomBytes */
  randomBytes?: (size: number) => Buffer;
}

export class AesGcmPiiCipher implements PiiCipher, ByteCipher {
  /** [0] = идэвхтэй, үлдсэн нь хуучин. #private → console.log / JSON.stringify-д түлхүүр гарахгүй */
  readonly #keys: readonly SubKeys[];
  readonly #random: (size: number) => Buffer;

  constructor(options: AesGcmPiiCipherOptions) {
    const current = decodeKey(options.key, 'PII_ENCRYPTION_KEY');
    const previous = (options.previousKeys ?? []).map((k, i) => decodeKey(k, `PII_ENCRYPTION_KEY_PREVIOUS[${i}]`));
    // Идэвхтэй түлхүүртэй давхцсан/өөр хоорондоо давтагдсан хуучин түлхүүрийг нэг удаа л туршина
    const unique = new Map<string, Buffer>([[current.toString('hex'), current]]);
    for (const k of previous) if (!unique.has(k.toString('hex'))) unique.set(k.toString('hex'), k);
    this.#keys = [...unique.values()].map(deriveSubKeys);
    this.#random = options.randomBytes ?? randomBytes;
  }

  /** Хуучин түлхүүрийн тоо (rotation төлөв харуулахад; түлхүүрийг өөрийг нь ил гаргахгүй) */
  get previousKeyCount(): number {
    return this.#keys.length - 1;
  }

  encrypt(plain: string): string {
    if (typeof plain !== 'string') throw new TypeError('PiiCipher.encrypt expects a string');
    return PREFIX + this.#seal(this.#keys[0].enc, Buffer.from(plain, 'utf8'), STRING_AAD).toString('base64url');
  }

  decrypt(cipherText: string): string {
    return this.#openString(cipherText).plain;
  }

  /** true = идэвхтэй биш (хуучин) түлхүүрээр шифрлэгдсэн → `rotate` хийх хэрэгтэй. Алдаатай/хуурамч оролтод шиддэг */
  needsRotation(cipherText: string): boolean {
    return this.#openString(cipherText).keyIndex > 0;
  }

  /** Rotation hook: идэвхтэй түлхүүрээр дахин шифрлэнэ (аль хэдийн идэвхтэй түлхүүртэй бол ижил утгыг буцаана) */
  rotate(cipherText: string): string {
    const { plain, keyIndex } = this.#openString(cipherText);
    return keyIndex === 0 ? cipherText : this.encrypt(plain);
  }

  /**
   * Тогтмол keyed hash (HMAC-SHA256, hex). Оролтыг NFC + trim + UPPERCASE болгоно (регистр "уа12345678" = "УА12345678").
   * Хоосон оролт татгалзана: бүх хоосон утга нэг hash болж давхардлын шалгалтыг буруу болгохоос сэргийлнэ.
   */
  hash(plain: string): string {
    return hmacHex(this.#keys[0].hash, normalizeForHash(plain));
  }

  /** Rotation үед хайлт: идэвхтэй + хуучин түлхүүрүүдийн hash-ууд (идэвхтэй нь эхэнд). Хуучин мөрийг `IN (...)`-ээр олно */
  hashCandidates(plain: string): string[] {
    const normalized = normalizeForHash(plain);
    return this.#keys.map((k) => hmacHex(k.hash, normalized));
  }

  encryptBytes(plain: Buffer, aad: string): Buffer {
    if (!Buffer.isBuffer(plain)) throw new TypeError('PiiCipher.encryptBytes expects a Buffer');
    const sealed = this.#seal(this.#keys[0].file, plain, fileAad(aad));
    return Buffer.concat([Buffer.from([FILE_FORMAT_BYTE]), sealed]);
  }

  decryptBytes(blob: Buffer, aad: string): Buffer {
    if (!Buffer.isBuffer(blob) || blob.length < 1 + NONCE_BYTES + TAG_BYTES) {
      throw new PiiCipherError('INVALID_FORMAT', 'encrypted file is truncated or not a buffer');
    }
    if (blob[0] !== FILE_FORMAT_BYTE) {
      throw new PiiCipherError('UNKNOWN_VERSION', `unsupported encrypted file format byte 0x${blob[0].toString(16)}`);
    }
    const body = blob.subarray(1);
    for (const k of this.#keys) {
      const plain = this.#tryOpen(k.file, body, fileAad(aad));
      if (plain) return plain;
    }
    throw new PiiCipherError('AUTH_FAILED', 'encrypted file failed authentication (tampered, wrong object key, or unknown encryption key)');
  }

  #openString(cipherText: string): { plain: string; keyIndex: number } {
    const body = parseEnvelope(cipherText);
    for (const [keyIndex, k] of this.#keys.entries()) {
      const plain = this.#tryOpen(k.enc, body, STRING_AAD);
      if (plain) return { plain: plain.toString('utf8'), keyIndex };
    }
    throw new PiiCipherError('AUTH_FAILED', 'ciphertext failed authentication (tampered, or encrypted with an unknown key)');
  }

  #seal(key: Buffer, data: Buffer, aad: Buffer): Buffer {
    const nonce = this.#random(NONCE_BYTES);
    if (nonce.length !== NONCE_BYTES) throw new Error(`nonce source returned ${nonce.length} bytes, expected ${NONCE_BYTES}`);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
  }

  /** nonce|ct|tag → plaintext; баталгаажуулалт бүтэлгүйтвэл null (өөр түлхүүрийг туршихын тулд) */
  #tryOpen(key: Buffer, body: Buffer, aad: Buffer): Buffer | null {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      return Buffer.concat([decipher.update(body.subarray(NONCE_BYTES, body.length - TAG_BYTES)), decipher.final()]);
    } catch {
      return null;
    }
  }
}

/** PII_ENCRYPTION_KEY (+ PII_ENCRYPTION_KEY_PREVIOUS таслалаар тусгаарласан) env-ээс. Түлхүүр байхгүй/буруу бол ЯМАР Ч орчинд шидэнэ */
export function createPiiCipher(env: EnvLike = process.env): AesGcmPiiCipher {
  const key = envString(env, 'PII_ENCRYPTION_KEY');
  if (key === undefined) {
    throw new PiiCipherError('KEY_MISSING', 'PII_ENCRYPTION_KEY is required: base64 of 32 random bytes, e.g. `openssl rand -base64 32`');
  }
  return new AesGcmPiiCipher({ key, previousKeys: splitList(env.PII_ENCRYPTION_KEY_PREVIOUS ?? '') });
}

// ───────────────────────── дотоод туслахууд ─────────────────────────

/** Стандарт base64 (padding-тэй, canonical), яг 32 байт. Түлхүүрийн утгыг мессежид ОРУУЛАХГҮЙ */
function decodeKey(raw: string, name: string): Buffer {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!BASE64_RE.test(text)) throw new PiiCipherError('KEY_INVALID', `${name} must be standard base64 (A-Z a-z 0-9 + / and = padding)`);
  const key = Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== text) {
    const hint = `must decode to exactly ${KEY_BYTES} bytes (got ${key.length}); generate one with \`openssl rand -base64 32\``;
    throw new PiiCipherError('KEY_INVALID', `${name} ${hint}`);
  }
  return key;
}

function deriveSubKeys(ikm: Buffer): SubKeys {
  const derive = (info: string): Buffer => Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, info, KEY_BYTES));
  return { enc: derive(HKDF_INFO.enc), hash: derive(HKDF_INFO.hash), file: derive(HKDF_INFO.file) };
}

/** 'v1:<base64url>' → nonce|ct|tag. Хэлбэр/хувилбар/дутуу байдлыг тус тусад нь typed алдаагаар ялгана */
function parseEnvelope(cipherText: string): Buffer {
  if (typeof cipherText !== 'string') throw new PiiCipherError('INVALID_FORMAT', 'ciphertext must be a string');
  const m = ENVELOPE_RE.exec(cipherText);
  if (!m) throw new PiiCipherError('INVALID_FORMAT', 'not an encrypted value (missing version prefix)');
  if (m[1] !== PII_CIPHER_VERSION) throw new PiiCipherError('UNKNOWN_VERSION', `unsupported ciphertext version "${m[1]}"`);
  const body = m[2];
  if (!BASE64URL_RE.test(body)) throw new PiiCipherError('INVALID_FORMAT', 'ciphertext payload is not base64url');
  const raw = Buffer.from(body, 'base64url');
  if (raw.toString('base64url') !== body) throw new PiiCipherError('INVALID_FORMAT', 'ciphertext payload is not canonical base64url');
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new PiiCipherError('INVALID_FORMAT', 'ciphertext is truncated');
  return raw;
}

function normalizeForHash(plain: string): string {
  if (typeof plain !== 'string') throw new TypeError('PiiCipher.hash expects a string');
  const normalized = plain.normalize('NFC').trim().toUpperCase();
  if (normalized === '') throw new PiiCipherError('EMPTY_INPUT', 'cannot hash an empty value');
  return normalized;
}

const hmacHex = (key: Buffer, data: string): string => createHmac('sha256', key).update(data, 'utf8').digest('hex');
const fileAad = (objectKey: string): Buffer => Buffer.from(FILE_AAD_PREFIX + objectKey, 'utf8');
