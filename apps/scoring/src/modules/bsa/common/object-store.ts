// Хуулгын эх файлын хадгалалт (MinIO, S3-тэй нийцтэй). ObjectStore port-ийн adapter-ууд:
//   MinioObjectStore (бодит) · InMemoryObjectStore (тест/dev) · EncryptingObjectStore (decorator: файлын bytes шифрлэнэ, NFR-3).
// Файл = PII (дансны дугаар, гүйлгээний утга) тул үйлдвэрлэлд ЗААВАЛ шифрлэгдсэн хадгалагдана (createObjectStore шалгана).
// Алдааны мессежид объектын түлхүүр/агуулга орохгүй (түлхүүрт PII орсон байж болзошгүй — лог руу гарахгүй).
import { Logger } from '@nestjs/common';
import { Client as MinioClient } from 'minio';
import type { Readable } from 'node:stream';
import { envBoolean, envInteger, envString, EnvConfigError, isProduction, type EnvLike } from './env';
import type { ObjectStore } from './infra.ports';
import { createPiiCipher, type ByteCipher } from './pii-cipher';

export type ObjectStoreErrorCode = 'INVALID_KEY' | 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'TOO_LARGE' | 'INTEGRITY' | 'BACKEND';

export class ObjectStoreError extends Error {
  constructor(readonly code: ObjectStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ObjectStoreError';
  }
}

/** Нэг объектын дээд хэмжээ анхдагч утга (BSA_OBJECT_MAX_BYTES-ээр дарж болно). Upload-ын бодит хязгаар нь BsaSettings.maxUploadBytes */
export const OBJECT_STORE_DEFAULTS = { bucket: 'bsa-statements', maxObjectBytes: 64 * 1024 * 1024 } as const;

const MAX_KEY_LENGTH = 512;
const KEY_CHARS = /^[A-Za-z0-9/_.-]+$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const CONTENT_TYPE_RE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(\s*;\s*[\w!#$&^.+-]+=("[^"\r\n]*"|[\w!#$&^.+-]+))*$/;

/**
 * Түлхүүрийн шалгалт (path traversal-аас хамгаална): зөвхөн [A-Za-z0-9/_.-], 1..512 тэмдэгт, `..` байхгүй.
 * Нэмэлтээр (filesystem backend-д нэр нормчлогдож өөр объекттой давхцахаас сэргийлж) эхэнд/төгсгөлд `/`, давхар `//`, `.` хэсэг татгалзана.
 */
export function assertValidObjectKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new ObjectStoreError('INVALID_KEY', `object key must be a string of 1..${MAX_KEY_LENGTH} characters`);
  }
  if (!KEY_CHARS.test(key)) throw new ObjectStoreError('INVALID_KEY', 'object key may contain only [A-Za-z0-9/_.-]');
  if (key.includes('..')) throw new ObjectStoreError('INVALID_KEY', "object key must not contain '..'");
  if (key.split('/').some((seg) => seg === '' || seg === '.')) {
    throw new ObjectStoreError('INVALID_KEY', "object key must not start/end with '/', contain '//' or a '.' segment");
  }
}

function assertValidBody(body: unknown, contentType: unknown, max: number): asserts body is Buffer {
  if (!Buffer.isBuffer(body)) throw new ObjectStoreError('INVALID_ARGUMENT', 'object body must be a Buffer');
  if (typeof contentType !== 'string' || contentType.length > 255 || !CONTENT_TYPE_RE.test(contentType)) {
    throw new ObjectStoreError('INVALID_ARGUMENT', 'invalid content type');
  }
  if (body.length > max) throw new ObjectStoreError('TOO_LARGE', `object exceeds the ${max}-byte limit`);
}

// ───────────────────────── MinIO ─────────────────────────

/** `minio` v8 Client-ийн ашиглагдаж буй хэсэг (тестэд fake өгөх боломжтой) */
export interface MinioClientLike {
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string, region?: string): Promise<void>;
  putObject(bucket: string, key: string, body: Buffer, size: number, metadata: Record<string, string>): Promise<unknown>;
  getObject(bucket: string, key: string): Promise<Readable>;
  statObject(bucket: string, key: string): Promise<unknown>;
  removeObject(bucket: string, key: string): Promise<void>;
}

export interface MinioObjectStoreOptions {
  bucket?: string;
  region?: string;
  maxObjectBytes?: number;
}

const s3Code = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined);
const isNotFound = (e: unknown): boolean => ['NoSuchKey', 'NotFound'].includes(s3Code(e) ?? '');
const isBucketExists = (e: unknown): boolean => ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(s3Code(e) ?? '');

export class MinioObjectStore implements ObjectStore {
  readonly #bucket: string;
  readonly #region: string | undefined;
  readonly #max: number;
  #ready: Promise<void> | null = null;

  constructor(private readonly client: MinioClientLike, options: MinioObjectStoreOptions = {}) {
    this.#bucket = options.bucket ?? OBJECT_STORE_DEFAULTS.bucket;
    this.#region = options.region;
    this.#max = options.maxObjectBytes ?? OBJECT_STORE_DEFAULTS.maxObjectBytes;
    if (!BUCKET_RE.test(this.#bucket)) {
      throw new ObjectStoreError('INVALID_ARGUMENT', `invalid bucket name "${this.#bucket}" (3-63 chars: a-z 0-9 . -)`);
    }
  }

  /** MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY (эсвэл MINIO_ROOT_USER / MINIO_ROOT_PASSWORD) / MINIO_USE_SSL / BSA_BUCKET */
  static fromEnv(env: EnvLike = process.env): MinioObjectStore {
    const conn = parseMinioConnection(env);
    const { endPoint, port, useSSL, accessKey, secretKey, region } = conn;
    const client = new MinioClient({ endPoint, port, useSSL, accessKey, secretKey, region });
    return new MinioObjectStore(client, {
      bucket: envString(env, 'BSA_BUCKET'),
      region: conn.region,
      maxObjectBytes: envInteger(env, 'BSA_OBJECT_MAX_BYTES', { min: 1 }),
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertValidObjectKey(key);
    assertValidBody(body, contentType, this.#max);
    await this.#ensureBucket();
    try {
      await this.client.putObject(this.#bucket, key, body, body.length, { 'Content-Type': contentType });
    } catch (e) {
      throw new ObjectStoreError('BACKEND', 'object store put failed', { cause: e });
    }
  }

  async get(key: string): Promise<Buffer> {
    assertValidObjectKey(key);
    await this.#ensureBucket();
    let stream: Readable;
    try {
      stream = await this.client.getObject(this.#bucket, key);
    } catch (e) {
      if (isNotFound(e)) throw new ObjectStoreError('NOT_FOUND', 'object not found', { cause: e });
      throw new ObjectStoreError('BACKEND', 'object store get failed', { cause: e });
    }
    try {
      return await readAll(stream, this.#max);
    } catch (e) {
      if (e instanceof ObjectStoreError) throw e;
      if (isNotFound(e)) throw new ObjectStoreError('NOT_FOUND', 'object not found', { cause: e });
      throw new ObjectStoreError('BACKEND', 'object store read failed', { cause: e });
    }
  }

  async delete(key: string): Promise<void> {
    assertValidObjectKey(key);
    await this.#ensureBucket();
    try {
      await this.client.removeObject(this.#bucket, key); // S3 DELETE идемпотент: байхгүй түлхүүр алдаа биш
    } catch (e) {
      if (isNotFound(e)) return;
      throw new ObjectStoreError('BACKEND', 'object store delete failed', { cause: e });
    }
  }

  async exists(key: string): Promise<boolean> {
    assertValidObjectKey(key);
    await this.#ensureBucket();
    try {
      await this.client.statObject(this.#bucket, key);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw new ObjectStoreError('BACKEND', 'object store stat failed', { cause: e });
    }
  }

  /** Анхны хэрэглээнд bucket-ийг автоматаар үүсгэнэ (нэг удаа; алдаа гарвал дараагийн дуудлага дахин оролдоно); зэрэгцээ үүсгэлтийн race зөвшөөрөгдөнө */
  #ensureBucket(): Promise<void> {
    this.#ready ??= this.#createBucketIfMissing().catch((e: unknown) => {
      this.#ready = null;
      throw new ObjectStoreError('BACKEND', 'object store bucket check failed', { cause: e });
    });
    return this.#ready;
  }

  async #createBucketIfMissing(): Promise<void> {
    if (await this.client.bucketExists(this.#bucket)) return;
    try {
      await this.client.makeBucket(this.#bucket, this.#region);
    } catch (e) {
      if (!isBucketExists(e)) throw e;
    }
  }
}

async function readAll(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > max) {
      stream.destroy();
      throw new ObjectStoreError('TOO_LARGE', `object exceeds the ${max}-byte limit`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

// ───────────────────────── Холболтын тохиргоо (env) ─────────────────────────

export interface MinioConnection {
  endPoint: string;
  port: number | undefined;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region: string | undefined;
}

/**
 * MINIO_ENDPOINT = `host:port` (docker-compose: localhost:9000) эсвэл `http(s)://host[:port]`. URL-ийн scheme нь SSL-ийг тодорхойлно;
 * MINIO_USE_SSL өгөгдсөн бөгөөд scheme-тэй зөрвөл тохиргооны алдаа (чимээгүй сонголт хийхгүй).
 * Нууц үг мессежид орохгүй.
 */
export function parseMinioConnection(env: EnvLike): MinioConnection {
  const raw = envString(env, 'MINIO_ENDPOINT');
  if (raw === undefined) throw new EnvConfigError('MINIO_ENDPOINT', 'is not set');
  const { host, port, https } = splitEndpoint(raw);
  const explicitSsl = envBoolean(env, 'MINIO_USE_SSL');
  if (explicitSsl !== undefined && https !== undefined && explicitSsl !== https) {
    throw new EnvConfigError('MINIO_USE_SSL', `conflicts with the ${https ? 'https' : 'http'}:// scheme of MINIO_ENDPOINT`);
  }
  const accessKey = envString(env, 'MINIO_ACCESS_KEY') ?? envString(env, 'MINIO_ROOT_USER');
  const secretKey = envString(env, 'MINIO_SECRET_KEY') ?? envString(env, 'MINIO_ROOT_PASSWORD');
  if (accessKey === undefined) throw new EnvConfigError('MINIO_ACCESS_KEY', 'is not set (MINIO_ROOT_USER is also empty)');
  if (secretKey === undefined) throw new EnvConfigError('MINIO_SECRET_KEY', 'is not set (MINIO_ROOT_PASSWORD is also empty)');
  // Модуль 0-ийн .env.example: MINIO_ENDPOINT=<host> + MINIO_PORT=9000 (тусдаа). Зөвхөн `host` хэлбэрт (URL биш, порт байхгүй) MINIO_PORT хэрэглэнэ;
  // URL-д порт хоосон = схемийн анхдагч (80/443) тул MINIO_PORT түүнийг дарахгүй. Хоёулаа байхгүй бол minio клиентийн анхдагч.
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const resolvedPort = port ?? (isUrl ? undefined : envInteger(env, 'MINIO_PORT', { min: 1, max: 65535 }));
  return { endPoint: host, port: resolvedPort, useSSL: explicitSsl ?? https ?? false, accessKey, secretKey, region: envString(env, 'MINIO_REGION') };
}

// URL-ийн анхдагч порт (http:80 / https:443) `new URL().port`-д хоосон болдог; minio клиент ижил анхдагчийг сонгодог тул undefined үлдээнэ.
const HOST_PORT_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/;

/** Алдааны мессежид `raw`-г хэвлэхгүй: буруу бичигдсэн утга нууц (user:pass@) агуулсан байж болно */
function splitEndpoint(raw: string): { host: string; port: number | undefined; https: boolean | undefined } {
  const bad = (why: string): EnvConfigError => new EnvConfigError('MINIO_ENDPOINT', `${why}; expected host:port or http(s)://host[:port]`);
  const unbracket = (h: string): string => h.replace(/^\[|\]$/g, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw bad('not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad(`unsupported scheme ${url.protocol}`);
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
      throw bad('must not contain a path, query, fragment or credentials');
    }
    return { host: unbracket(url.hostname), port: url.port === '' ? undefined : Number(url.port), https: url.protocol === 'https:' };
  }
  const m = HOST_PORT_RE.exec(raw);
  if (!m) throw bad('not a valid host[:port]');
  const port = m[2] === undefined ? undefined : Number(m[2]);
  if (port !== undefined && (port < 1 || port > 65535)) throw bad('port out of range 1..65535');
  return { host: unbracket(m[1]), port, https: undefined };
}

// ───────────────────────── In-memory ─────────────────────────

/** Тест / Redis-MinIO-гүй dev. Процессоос гарахад өгөгдөл алдагдана. Түлхүүр/хэмжээний шалгалт MinIO-той ижил */
export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly #max: number;

  constructor(options: { maxObjectBytes?: number } = {}) {
    this.#max = options.maxObjectBytes ?? OBJECT_STORE_DEFAULTS.maxObjectBytes;
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.#run(() => {
      assertValidObjectKey(key);
      assertValidBody(body, contentType, this.#max);
      this.#objects.set(key, { body: Buffer.from(body), contentType });
    });
  }

  get(key: string): Promise<Buffer> {
    return this.#run(() => {
      assertValidObjectKey(key);
      const o = this.#objects.get(key);
      if (!o) throw new ObjectStoreError('NOT_FOUND', 'object not found');
      return Buffer.from(o.body);
    });
  }

  delete(key: string): Promise<void> {
    return this.#run(() => {
      assertValidObjectKey(key);
      this.#objects.delete(key);
    });
  }

  exists(key: string): Promise<boolean> {
    return this.#run(() => {
      assertValidObjectKey(key);
      return this.#objects.has(key);
    });
  }

  /** Тестэд: хадгалагдсан түлхүүрүүд, content type, хэмжээ */
  keys(): string[] {
    return [...this.#objects.keys()];
  }
  contentTypeOf(key: string): string | undefined {
    return this.#objects.get(key)?.contentType;
  }
  /** Тестэд: хадгалагдсан түүхий (шифрлэгдсэн байж болох) bytes-ийг хуулбарлаж буцаана / бичнэ — tamper шалгахад */
  rawGet(key: string): Buffer | undefined {
    const o = this.#objects.get(key);
    return o && Buffer.from(o.body);
  }
  rawSet(key: string, body: Buffer): void {
    const o = this.#objects.get(key);
    if (o) this.#objects.set(key, { ...o, body: Buffer.from(body) });
  }

  #run<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

// ───────────────────────── Шифрлэгч decorator ─────────────────────────

/**
 * Файлын bytes-ийг store-д орохын өмнө AES-256-GCM-ээр шифрлэнэ (объект бүр санамсаргүй nonce, түлхүүр нь AAD-д холбогдсон тул blob-ыг
 * өөр түлхүүр рүү зөөж болохгүй). Дотоод store-д зөвхөн ciphertext + `application/octet-stream` очно (жинхэнэ MIME-г задруулахгүй).
 */
export class EncryptingObjectStore implements ObjectStore {
  constructor(private readonly inner: ObjectStore, private readonly cipher: ByteCipher) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertValidObjectKey(key);
    assertValidBody(body, contentType, Number.MAX_SAFE_INTEGER);
    await this.inner.put(key, this.cipher.encryptBytes(body, key), 'application/octet-stream');
  }

  async get(key: string): Promise<Buffer> {
    assertValidObjectKey(key);
    const blob = await this.inner.get(key);
    try {
      return this.cipher.decryptBytes(blob, key);
    } catch (e) {
      const why = 'stored object failed decryption/authentication (tampered or encrypted with another key)';
      throw new ObjectStoreError('INTEGRITY', why, { cause: e });
    }
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }
}

// ───────────────────────── Factory ─────────────────────────

export interface CreateObjectStoreOptions {
  /**
   * Файл шифрлэгч. Өгөөгүй бол DATA_ENCRYPTION_KEY[S]-ээс (foundation) үүсгэнэ (түлхүүр байхгүй бол шифрлэлтгүй — ЗӨВХӨН үйлдвэрлэлийн бус орчинд).
   * `null` = шифрлэлтийг санаатайгаар унтраана (тест).
   */
  cipher?: ByteCipher | null;
  warn?: (message: string) => void;
}

let inMemoryWarned = false;
/** Тестэд "нэг удаагийн" анхааруулгыг дахин идэвхжүүлэх */
export function resetObjectStoreWarningsForTests(): void {
  inMemoryWarned = false;
}

/**
 * MINIO_ENDPOINT байвал MinIO, үгүй бол in-memory (дуугарсан нэг удаагийн анхааруулгатай). NODE_ENV=production үед:
 * endpoint байхгүй бол ЭСВЭЛ файл шифрлэх түлхүүр байхгүй бол шидэнэ — чимээгүйгээр сул хамгаалалттай ажиллахгүй.
 */
export function createObjectStore(env: EnvLike = process.env, options: CreateObjectStoreOptions = {}): ObjectStore {
  const production = isProduction(env);
  const endpoint = envString(env, 'MINIO_ENDPOINT');
  if (endpoint === undefined && production) {
    throw new EnvConfigError('MINIO_ENDPOINT', 'is required when NODE_ENV=production (the in-memory store loses uploaded statements)');
  }
  const hasKey = envString(env, 'DATA_ENCRYPTION_KEY') !== undefined || envString(env, 'DATA_ENCRYPTION_KEYS') !== undefined;
  const cipher = options.cipher !== undefined ? options.cipher : hasKey ? createPiiCipher(env) : null;
  if (cipher === null && production) {
    const why = 'is required when NODE_ENV=production: statement files are PII and must be encrypted (NFR-3)';
    throw new EnvConfigError('DATA_ENCRYPTION_KEY', why);
  }

  let base: ObjectStore;
  if (endpoint === undefined) {
    if (!inMemoryWarned) {
      inMemoryWarned = true;
      const message = 'MINIO_ENDPOINT is not set: using the IN-MEMORY object store. Uploads are lost on restart. Local dev/tests ONLY.';
      (options.warn ?? ((m: string) => new Logger('ObjectStore').warn(m)))(message);
    }
    base = new InMemoryObjectStore({ maxObjectBytes: envInteger(env, 'BSA_OBJECT_MAX_BYTES', { min: 1 }) });
  } else {
    base = MinioObjectStore.fromEnv(env);
  }
  return cipher === null ? base : new EncryptingObjectStore(base, cipher);
}
