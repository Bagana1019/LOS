// NFR-3: PII шифрлэлт + тэнцүүгээр хайх hash. PiiCipher port-ийн хэрэгжүүлэлт — Модуль 0-ийн `@los/database` crypto (AES-256-GCM,
// түлхүүрийн цуглуулга DATA_ENCRYPTION_KEY[S], blind index DATA_INDEX_KEY) дээр суурилна; өөрийн түлхүүр, формат зохиохгүй.
//  - Тэмдэгт мөр (дансны дугаар, гүйлгээний утга, нэр, регистрийн snapshot): `encryptedField` формат `v1.<keyId>.<iv>.<tag>.<ct>`,
//    AAD = 'scoring.bsa' (шифртекстийг BSA-ийн домэйнд түгжинэ).
//  - hash(): foundation-ийн `blindIndex` (HMAC-SHA256, регистр том/жижиг үсэг, завсарт үл мэдрэмтгий) — origination-ий `register_no_hash`-тай ижил.
//  - Файл (хуулгын bytes): foundation-д binary байхгүй тул энд AES-256-GCM (түлхүүр = foundation-ийн идэвхтэй түлхүүрээс HKDF-ээр гаргасан
//    файлын дэд түлхүүр). Формат: 0x02 | keyId урт[1] | keyId | nonce[12] | ciphertext | tag[16]; AAD = объектын түлхүүр.
// Нууц ба PII-г ХЭЗЭЭ Ч алдааны мессеж/логт оруулахгүй (түлхүүр, plaintext, ciphertext).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { configFromEnv, createFieldCrypto, isEncryptedField, type FieldCrypto, type FieldCryptoConfig } from '@los/database';
import type { EnvLike } from './env';
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

/** Шифрлэгдсэн талбарын AAD: BSA-ийн шифртекстийг өөр домэйн (customer.register_no г.м) рүү хуулж ашиглах боломжгүй */
export const PII_FIELD_AAD = 'scoring.bsa';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Файлын формат: 1 байт хувилбар */
const FILE_FORMAT_BYTE = 0x02;
const FILE_AAD_PREFIX = 'los-pii-file-v1\0';
// HKDF тогтмолууд: salt нууц биш (домэйн тусгаарлагч). info өөрчлөх = бүх хуучин файл уншигдахгүй болно — ХЭЗЭЭ Ч өөрчлөхгүй.
const HKDF_SALT = Buffer.from('los-radix/bsa/pii-cipher/v1', 'utf8');
const HKDF_INFO_FILE = 'los/file/enc/v1';

const fileAad = (objectKey: string): Buffer => Buffer.from(FILE_AAD_PREFIX + objectKey, 'utf8');

export class FieldCryptoPiiCipher implements PiiCipher, ByteCipher {
  readonly #crypto: FieldCrypto;
  readonly #config: FieldCryptoConfig;
  readonly #random: (size: number) => Buffer;

  constructor(config: FieldCryptoConfig, options: { randomBytes?: (size: number) => Buffer } = {}) {
    this.#config = config;
    this.#crypto = createFieldCrypto(config);
    this.#random = options.randomBytes ?? randomBytes;
  }

  encrypt(plain: string): string {
    if (typeof plain !== 'string') throw new TypeError('PiiCipher.encrypt expects a string');
    return this.#crypto.encrypt(plain, PII_FIELD_AAD);
  }

  decrypt(cipherText: string): string {
    if (typeof cipherText !== 'string' || !isEncryptedField(cipherText)) {
      throw new PiiCipherError('INVALID_FORMAT', 'not an encrypted value (expected the v1.<keyId>.<iv>.<tag>.<ciphertext> field format)');
    }
    const keyId = cipherText.split('.')[1] ?? '';
    if (!this.#config.keys[keyId]) throw new PiiCipherError('AUTH_FAILED', 'ciphertext was encrypted with an unknown key id');
    try {
      return this.#crypto.decrypt(cipherText, PII_FIELD_AAD);
    } catch {
      throw new PiiCipherError('AUTH_FAILED', 'ciphertext failed authentication (tampered, or encrypted for another field)');
    }
  }

  /** true = идэвхтэй биш (хуучин) түлхүүрээр шифрлэгдсэн → `rotate` хийх хэрэгтэй. Алдаатай оролтод шиддэг */
  needsRotation(cipherText: string): boolean {
    this.decrypt(cipherText);
    return cipherText.split('.')[1] !== this.#config.currentKeyId;
  }

  /** Rotation hook: идэвхтэй түлхүүрээр дахин шифрлэнэ (аль хэдийн идэвхтэй түлхүүртэй бол ижил утгыг буцаана) */
  rotate(cipherText: string): string {
    return this.needsRotation(cipherText) ? this.encrypt(this.decrypt(cipherText)) : cipherText;
  }

  /**
   * Тогтмол keyed hash (HMAC-SHA256, hex; foundation `blindIndex`): регистр "уа12345678" = "УА 12345678" = "УА12345678".
   * Хоосон оролт татгалзана: бүх хоосон утга нэг hash болж давхардлын шалгалтыг буруу болгохоос сэргийлнэ.
   */
  hash(plain: string): string {
    if (typeof plain !== 'string') throw new TypeError('PiiCipher.hash expects a string');
    if (plain.trim() === '') throw new PiiCipherError('EMPTY_INPUT', 'cannot hash an empty value');
    return this.#crypto.blindIndex(plain);
  }

  encryptBytes(plain: Buffer, aad: string): Buffer {
    if (!Buffer.isBuffer(plain)) throw new TypeError('PiiCipher.encryptBytes expects a Buffer');
    const keyId = this.#config.currentKeyId;
    const keyIdBytes = Buffer.from(keyId, 'utf8');
    if (keyIdBytes.length === 0 || keyIdBytes.length > 255) throw new PiiCipherError('KEY_INVALID', 'DATA_ENCRYPTION_KEY_ID must be 1..255 bytes');
    const nonce = this.#random(NONCE_BYTES);
    if (nonce.length !== NONCE_BYTES) throw new Error(`nonce source returned ${nonce.length} bytes, expected ${NONCE_BYTES}`);
    const cipher = createCipheriv('aes-256-gcm', this.#fileKey(keyId), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(fileAad(aad));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([FILE_FORMAT_BYTE, keyIdBytes.length]), keyIdBytes, nonce, ct, cipher.getAuthTag()]);
  }

  decryptBytes(blob: Buffer, aad: string): Buffer {
    if (!Buffer.isBuffer(blob) || blob.length < 2) throw new PiiCipherError('INVALID_FORMAT', 'encrypted file is truncated or not a buffer');
    if (blob[0] !== FILE_FORMAT_BYTE) {
      throw new PiiCipherError('UNKNOWN_VERSION', `unsupported encrypted file format byte 0x${blob[0].toString(16)}`);
    }
    const idLen = blob[1];
    if (blob.length < 2 + idLen + NONCE_BYTES + TAG_BYTES) throw new PiiCipherError('INVALID_FORMAT', 'encrypted file is truncated');
    const keyId = blob.subarray(2, 2 + idLen).toString('utf8');
    if (!this.#config.keys[keyId]) throw new PiiCipherError('AUTH_FAILED', 'encrypted file uses an unknown key id');
    const body = blob.subarray(2 + idLen);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#fileKey(keyId), body.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAAD(fileAad(aad));
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      return Buffer.concat([decipher.update(body.subarray(NONCE_BYTES, body.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new PiiCipherError('AUTH_FAILED', 'encrypted file failed authentication (tampered, wrong object key, or wrong encryption key)');
    }
  }

  #fileKey(keyId: string): Buffer {
    const ikm = this.#config.keys[keyId];
    if (!ikm || ikm.length !== KEY_BYTES) throw new PiiCipherError('KEY_INVALID', 'encryption key must be 32 bytes');
    return Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO_FILE, KEY_BYTES));
  }
}

/** Foundation-ий env (DATA_ENCRYPTION_KEY[S], DATA_ENCRYPTION_KEY_ID, DATA_INDEX_KEY — .env.example) уншина. NODE_ENV=test-д түлхүүр байхгүй бол foundation-ий тестийн түлхүүр. */
export function createPiiCipher(env: EnvLike = process.env): FieldCryptoPiiCipher {
  let config: FieldCryptoConfig;
  try {
    config = configFromEnv(env as NodeJS.ProcessEnv);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'invalid encryption configuration';
    throw new PiiCipherError(/required/.test(message) ? 'KEY_MISSING' : 'KEY_INVALID', message);
  }
  return new FieldCryptoPiiCipher(config);
}
