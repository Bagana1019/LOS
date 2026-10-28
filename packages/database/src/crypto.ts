import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// NFR-5, CLAUDE.md §6.5: регистр, дансны дугаар, ИҮ-ийн зургийн түлхүүр — шифрлэгдсэн хэлбэрээр хадгална, лог-д бичихгүй.
// Шийдвэр (docs/DECISIONS.md): Prisma-аар pgcrypto SQL функц дуудах боломжгүй тул апп түвшинд AES-256-GCM; түлхүүр DB-д хадгалагдахгүй.
// Формат: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url). Түлхүүр солих: шинэ түлхүүрийг DATA_ENCRYPTION_KEYS-д нэмээд
// DATA_ENCRYPTION_KEY_ID-г шилжүүлнэ — хуучин утгууд хуучин түлхүүрээр тайлагдсаар байна.
// Хайлт: шифрлэгдсэн талбарыг хайх `blindIndex()` (HMAC-SHA256) — `register_no_hash` зэрэг unique index-д.

export interface FieldCryptoConfig {
  /** keyId → 32 байт түлхүүр */
  keys: Record<string, Buffer>;
  currentKeyId: string;
  indexKey: Buffer;
}

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');
const KEY_BYTES = 32;

function parseKey(raw: string, what: string): Buffer {
  const b = Buffer.from(raw, 'base64');
  if (b.length !== KEY_BYTES) throw new Error(`${what} must be ${KEY_BYTES} bytes, base64-encoded (e.g. \`openssl rand -base64 32\`)`);
  return b;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): FieldCryptoConfig {
  // Тест: түлхүүр тавиагүй бол тогтмол тестийн түлхүүр. Бусад орчинд заавал.
  if (env.NODE_ENV === 'test' && !env.DATA_ENCRYPTION_KEYS && !env.DATA_ENCRYPTION_KEY) {
    return { keys: { t1: Buffer.alloc(KEY_BYTES, 1) }, currentKeyId: 't1', indexKey: Buffer.alloc(KEY_BYTES, 2) };
  }
  const keys: Record<string, Buffer> = {};
  if (env.DATA_ENCRYPTION_KEYS) {
    for (const part of env.DATA_ENCRYPTION_KEYS.split(',')) {
      const i = part.indexOf(':');
      if (i < 1) throw new Error('DATA_ENCRYPTION_KEYS must look like "k1:<base64>,k2:<base64>"');
      keys[part.slice(0, i).trim()] = parseKey(part.slice(i + 1).trim(), `DATA_ENCRYPTION_KEYS[${part.slice(0, i)}]`);
    }
  } else if (env.DATA_ENCRYPTION_KEY) {
    keys.k1 = parseKey(env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY');
  } else {
    throw new Error('DATA_ENCRYPTION_KEY (or DATA_ENCRYPTION_KEYS) is required — see .env.example');
  }
  const currentKeyId = env.DATA_ENCRYPTION_KEY_ID ?? Object.keys(keys)[0]!;
  if (!keys[currentKeyId]) throw new Error(`DATA_ENCRYPTION_KEY_ID "${currentKeyId}" is not in the keyring`);
  if (!env.DATA_INDEX_KEY) throw new Error('DATA_INDEX_KEY is required — see .env.example');
  return { keys, currentKeyId, indexKey: parseKey(env.DATA_INDEX_KEY, 'DATA_INDEX_KEY') };
}

export interface FieldCrypto {
  encrypt(plain: string, aad?: string): string;
  decrypt(cipher: string, aad?: string): string;
  blindIndex(plain: string): string;
}

export function createFieldCrypto(config: FieldCryptoConfig): FieldCrypto {
  return {
    encrypt(plain, aad) {
      const key = config.keys[config.currentKeyId]!;
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      if (aad) c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', config.currentKeyId, b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
    },
    decrypt(cipher, aad) {
      const [v, keyId, iv, tag, ct, extra] = cipher.split('.');
      if (v !== 'v1' || !keyId || !iv || !tag || ct === undefined || extra !== undefined) throw new Error('Malformed encrypted field');
      const key = config.keys[keyId];
      if (!key) throw new Error(`Unknown encryption key id "${keyId}"`);
      const d = createDecipheriv('aes-256-gcm', key, fromB64u(iv));
      if (aad) d.setAAD(Buffer.from(aad));
      d.setAuthTag(fromB64u(tag));
      return Buffer.concat([d.update(fromB64u(ct)), d.final()]).toString('utf8');
    },
    // Регистрийн жижиг/том үсэг, завсрыг үл тооцно: "уб 12345678" ≡ "УБ12345678"
    blindIndex(plain) {
      return createHmac('sha256', config.indexKey).update(plain.normalize('NFC').replace(/\s+/g, '').toLocaleUpperCase('mn')).digest('hex');
    },
  };
}

let shared: FieldCrypto | undefined;
const crypto = () => (shared ??= createFieldCrypto(configFromEnv()));
/** Тестэд env солих үед кэшийг цэвэрлэнэ. */
export const resetFieldCrypto = () => { shared = undefined; };

/** Шифрлэх. `aad` (жишээ `customer.register_no`) өгвөл шифртекстийг тухайн баганад түгжинэ. */
export const encryptedField = (plain: string, aad?: string): string => crypto().encrypt(plain, aad);
export const decryptedField = (cipher: string, aad?: string): string => crypto().decrypt(cipher, aad);
/** Шифрлэгдсэн талбараар хайх/unique болгох тогтмол хэш (түлхүүртэй HMAC). */
export const blindIndex = (plain: string): string => crypto().blindIndex(plain);
export const isEncryptedField = (s: string): boolean => /^v1\.[^.]+\.[^.]+\.[^.]+\.[^.]*$/.test(s);

/** UI/лог-д харуулах: "УБ****5678". */
export function maskRegisterNo(plain: string): string {
  const s = plain.replace(/\s+/g, '');
  return s.length <= 6 ? '*'.repeat(s.length) : `${s.slice(0, 2)}${'*'.repeat(s.length - 6)}${s.slice(-4)}`;
}
export function maskAccountNo(plain: string): string {
  const s = plain.replace(/\s+/g, '');
  return s.length <= 4 ? '*'.repeat(s.length) : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
}
