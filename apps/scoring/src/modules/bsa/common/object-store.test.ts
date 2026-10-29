// ObjectStore adapter-ууд: MinioObjectStore (fake client-ээр), InMemoryObjectStore, EncryptingObjectStore, createObjectStore.
// Бүх агуулга НЭЭЛТТЭЙ хуурамч (synthetic) bytes — жинхэнэ хуулга биш.
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvConfigError } from './env';
import {
  assertValidObjectKey,
  createObjectStore,
  EncryptingObjectStore,
  InMemoryObjectStore,
  MinioObjectStore,
  ObjectStoreError,
  parseMinioConnection,
  resetObjectStoreWarningsForTests,
  type MinioClientLike,
  type ObjectStoreErrorCode,
} from './object-store';
import { FieldCryptoPiiCipher } from './pii-cipher';

const keyBuf = (offset: number): Buffer => Buffer.from(Array.from({ length: 32 }, (_, i) => i + offset));
const KEY_A = keyBuf(11).toString('base64');
const INDEX_KEY = keyBuf(5).toString('base64');
/** Foundation-ий түлхүүрийн env (DATA_ENCRYPTION_KEY + DATA_INDEX_KEY) */
const keyEnv = { DATA_ENCRYPTION_KEY: KEY_A, DATA_INDEX_KEY: INDEX_KEY };
const cipherOf = (current: string, ...ids: Array<[string, number]>): FieldCryptoPiiCipher =>
  new FieldCryptoPiiCipher({ keys: Object.fromEntries(ids.map(([id, off]) => [id, keyBuf(off)])), currentKeyId: current, indexKey: keyBuf(5) });
const PDF = Buffer.from('%PDF-1.4 SYNTHETIC statement bytes\u0000ÿ', 'latin1');

class S3Err extends Error {
  constructor(readonly code: string) {
    super(`S3 ${code}`);
  }
}

/** minio Client-ийн ашиглагдаж буй хэсгийн fake: S3-тэй адил алдааны `code`-той */
class FakeMinio implements MinioClientLike {
  readonly buckets = new Set<string>();
  readonly objects = new Map<string, { body: Buffer; meta: Record<string, string>; size: number }>();
  readonly calls: string[] = [];
  makeBucketFailures: string[] = [];
  statFailure: string | null = null;
  getBodyOverride: (() => Readable) | null = null;

  async bucketExists(bucket: string): Promise<boolean> {
    this.calls.push('bucketExists');
    await Promise.resolve();
    return this.buckets.has(bucket);
  }
  async makeBucket(bucket: string, _region?: string): Promise<void> {
    this.calls.push('makeBucket');
    await Promise.resolve();
    const failure = this.makeBucketFailures.shift();
    if (failure) throw new S3Err(failure);
    this.buckets.add(bucket);
  }
  async putObject(bucket: string, key: string, body: Buffer, size: number, metadata: Record<string, string>): Promise<unknown> {
    this.calls.push('putObject');
    if (!this.buckets.has(bucket)) throw new S3Err('NoSuchBucket');
    this.objects.set(`${bucket}/${key}`, { body: Buffer.from(body), meta: metadata, size });
    return {};
  }
  async getObject(bucket: string, key: string): Promise<Readable> {
    this.calls.push('getObject');
    if (this.getBodyOverride) return this.getBodyOverride();
    const o = this.objects.get(`${bucket}/${key}`);
    if (!o) throw new S3Err('NoSuchKey');
    // 3 хэсэгт хуваан дамжуулж stream-ийн жинхэнэ байдлыг дууриана
    const third = Math.ceil(o.body.length / 3) || 1;
    return Readable.from([o.body.subarray(0, third), o.body.subarray(third, 2 * third), o.body.subarray(2 * third)]);
  }
  async statObject(bucket: string, key: string): Promise<unknown> {
    this.calls.push('statObject');
    if (this.statFailure) throw new S3Err(this.statFailure);
    if (!this.objects.has(`${bucket}/${key}`)) throw new S3Err('NotFound');
    return { size: this.objects.get(`${bucket}/${key}`)!.size };
  }
  async removeObject(bucket: string, key: string): Promise<void> {
    this.calls.push('removeObject');
    this.objects.delete(`${bucket}/${key}`);
  }
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<ObjectStoreErrorCode | undefined> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ObjectStoreError);
    return (e as ObjectStoreError).code;
  }
  return undefined;
}

const BAD_KEYS: Array<[string, unknown]> = [
  ['parent traversal', '../etc/passwd'],
  ['embedded traversal', 'bsa/../../x'],
  ['dots inside name', 'bsa/a..b.pdf'],
  ['absolute path', '/bsa/a.pdf'],
  ['trailing slash', 'bsa/a/'],
  ['double slash', 'bsa//a.pdf'],
  ['dot segment', 'bsa/./a.pdf'],
  ['backslash', 'bsa\\a.pdf'],
  ['space', 'bsa/a b.pdf'],
  ['cyrillic (not in whitelist)', 'bsa/хуулга.pdf'],
  ['percent-encoded traversal', 'bsa/%2e%2e/a'],
  ['null byte', 'bsa/a\u0000.pdf'],
  ['newline', 'bsa/a\n.pdf'],
  ['empty', ''],
  ['513 chars', 'k'.repeat(513)],
  ['non-string', 42],
  ['undefined', undefined],
];

describe('assertValidObjectKey', () => {
  it.each(['bsa/org-1/an_1/6f1b2c.pdf', 'a', 'A.b-c_d/e', 'k'.repeat(512), 'a/b.c/d.pdf'])('accepts %s', (k) => {
    expect(() => assertValidObjectKey(k)).not.toThrow();
  });
  it.each(BAD_KEYS)('rejects %s', (_n, k) => {
    expect(() => assertValidObjectKey(k)).toThrow(ObjectStoreError);
    try {
      assertValidObjectKey(k);
    } catch (e) {
      expect((e as ObjectStoreError).code).toBe('INVALID_KEY');
    }
  });
});

describe('MinioObjectStore (fake client)', () => {
  let client: FakeMinio;
  let store: MinioObjectStore;
  beforeEach(() => {
    client = new FakeMinio();
    store = new MinioObjectStore(client, { bucket: 'bsa-test' });
  });

  it('round-trips bytes and sends size + Content-Type', async () => {
    await store.put('bsa/o/a1.pdf', PDF, 'application/pdf');
    expect(client.objects.get('bsa-test/bsa/o/a1.pdf')).toMatchObject({ size: PDF.length, meta: { 'Content-Type': 'application/pdf' } });
    expect((await store.get('bsa/o/a1.pdf')).equals(PDF)).toBe(true);
    expect(await store.exists('bsa/o/a1.pdf')).toBe(true);
    await store.delete('bsa/o/a1.pdf');
    expect(await store.exists('bsa/o/a1.pdf')).toBe(false);
  });

  it('round-trips an empty object', async () => {
    await store.put('empty', Buffer.alloc(0), 'application/octet-stream');
    expect(await store.get('empty')).toHaveLength(0);
  });

  it('creates the bucket on first use, exactly once, even for concurrent first calls', async () => {
    await Promise.all([store.put('a', PDF, 'application/pdf'), store.put('b', PDF, 'application/pdf'), store.exists('c')]);
    await store.put('d', PDF, 'application/pdf');
    expect(client.calls.filter((c) => c === 'makeBucket')).toHaveLength(1);
    expect(client.calls.filter((c) => c === 'bucketExists')).toHaveLength(1);
  });

  it('does not create the bucket when it already exists', async () => {
    client.buckets.add('bsa-test');
    await store.exists('x');
    expect(client.calls).not.toContain('makeBucket');
  });

  it('treats "bucket already owned" (concurrent creator) as success', async () => {
    // race: bucketExists=false харсан хойно нөгөө процесс үүсгэчихсэн → makeBucket "аль хэдийн байна" гэж алдаа өгнө
    client.bucketExists = async () => false;
    client.makeBucketFailures = ['BucketAlreadyOwnedByYou'];
    client.buckets.add('bsa-test');
    await expect(store.put('x', PDF, 'application/pdf')).resolves.toBeUndefined();
    client.makeBucketFailures = ['BucketAlreadyExists'];
    const second = new MinioObjectStore(client, { bucket: 'bsa-test' });
    await expect(second.exists('x')).resolves.toBe(true);
  });

  it('wraps a failed bucket creation as BACKEND and retries on the next call', async () => {
    client.makeBucketFailures = ['AccessDenied'];
    expect(await codeOfAsync(() => store.put('a', PDF, 'application/pdf'))).toBe('BACKEND');
    await store.put('a', PDF, 'application/pdf'); // дараагийн дуудлага дахин оролдоно
    expect(client.calls.filter((c) => c === 'makeBucket')).toHaveLength(2);
  });

  it('get of a missing key -> NOT_FOUND; exists -> false; delete is idempotent', async () => {
    expect(await codeOfAsync(() => store.get('nope'))).toBe('NOT_FOUND');
    expect(await store.exists('nope')).toBe(false);
    await expect(store.delete('nope')).resolves.toBeUndefined();
  });

  it('maps non-"not found" backend failures to BACKEND (does not report them as missing)', async () => {
    client.statFailure = 'InternalError';
    expect(await codeOfAsync(() => store.exists('x'))).toBe('BACKEND');
    client.getBodyOverride = () => {
      throw new S3Err('SlowDown');
    };
    expect(await codeOfAsync(() => store.get('x'))).toBe('BACKEND');
  });

  it('maps a stream error while reading to BACKEND', async () => {
    client.getBodyOverride = () => new Readable({ read() { this.destroy(new Error('socket reset')); } });
    expect(await codeOfAsync(() => store.get('x'))).toBe('BACKEND');
  });

  it('enforces the size limit on put and while streaming get', async () => {
    const small = new MinioObjectStore(client, { bucket: 'bsa-test', maxObjectBytes: 100 });
    expect(await codeOfAsync(() => small.put('big', Buffer.alloc(101), 'application/pdf'))).toBe('TOO_LARGE');
    await store.put('big', Buffer.alloc(101), 'application/pdf'); // зөвшөөрсөн store-оор оруулаад жижиг хязгаартай уншина
    expect(await codeOfAsync(() => small.get('big'))).toBe('TOO_LARGE');
    expect(client.objects.has('bsa-test/big')).toBe(true);
  });

  it.each(BAD_KEYS)('never reaches the backend for an invalid key (%s)', async (_n, key) => {
    const k = key as string;
    for (const op of [() => store.put(k, PDF, 'application/pdf'), () => store.get(k), () => store.delete(k), () => store.exists(k)]) {
      expect(await codeOfAsync(op)).toBe('INVALID_KEY');
    }
    expect(client.calls).toEqual([]);
  });

  it.each([
    ['CRLF header injection', 'application/pdf\r\nX-Evil: 1'],
    ['no slash', 'pdf'],
    ['empty', ''],
    ['space', 'application/p df'],
    ['too long', `application/${'x'.repeat(300)}`],
  ])('rejects a bad content type (%s)', async (_n, ct) => {
    expect(await codeOfAsync(() => store.put('a', PDF, ct))).toBe('INVALID_ARGUMENT');
    expect(client.calls).toEqual([]);
  });

  it('accepts content types with parameters and rejects a non-Buffer body', async () => {
    await store.put('a', PDF, 'text/csv; charset=utf-8');
    expect(await codeOfAsync(() => store.put('b', 'text' as unknown as Buffer, 'text/csv'))).toBe('INVALID_ARGUMENT');
  });

  it('does not leak the object key into error messages', async () => {
    const key = 'bsa/org/secret-customer-key.pdf';
    const errors: string[] = [];
    for (const op of [() => store.get(key), () => store.put(`${key}/../x`, PDF, 'application/pdf')]) {
      try {
        await op();
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    expect(errors).toHaveLength(2);
    for (const m of errors) expect(m).not.toContain('secret-customer-key');
  });

  it('validates the bucket name', () => {
    for (const bucket of ['AB', 'Bsa_Statements', 'a', '-bad-', 'x'.repeat(64)]) {
      expect(() => new MinioObjectStore(client, { bucket })).toThrow(ObjectStoreError);
    }
    expect(() => new MinioObjectStore(client, { bucket: 'bsa-statements' })).not.toThrow();
  });

  it('defaults the bucket to bsa-statements', async () => {
    await new MinioObjectStore(client).put('a', PDF, 'application/pdf');
    expect(client.buckets.has('bsa-statements')).toBe(true);
  });
});

describe('parseMinioConnection (env)', () => {
  const base = { MINIO_ENDPOINT: 'localhost:9000', MINIO_ACCESS_KEY: 'ak', MINIO_SECRET_KEY: 'sk' };

  it('parses host:port (docker-compose default) with plain HTTP', () => {
    expect(parseMinioConnection(base)).toEqual({ endPoint: 'localhost', port: 9000, useSSL: false, accessKey: 'ak', secretKey: 'sk', region: undefined });
  });
  it('parses URLs; https implies SSL; default port stays undefined', () => {
    const https = parseMinioConnection({ ...base, MINIO_ENDPOINT: 'https://minio.example.test' });
    expect(https).toMatchObject({ endPoint: 'minio.example.test', port: undefined, useSSL: true });
    expect(parseMinioConnection({ ...base, MINIO_ENDPOINT: 'http://minio.example.test:9100/' })).toMatchObject({ port: 9100, useSSL: false });
    expect(parseMinioConnection({ ...base, MINIO_ENDPOINT: 'http://minio.example.test:80' })).toMatchObject({ port: undefined, useSSL: false });
  });
  it('keeps an explicit :80 on a bare host:port so SSL=true does not silently switch to 443', () => {
    expect(parseMinioConnection({ ...base, MINIO_ENDPOINT: 'minio:80', MINIO_USE_SSL: 'true' })).toMatchObject({ port: 80, useSSL: true });
  });
  it('supports host without port, IPv6 and MINIO_USE_SSL for host:port form', () => {
    expect(parseMinioConnection({ ...base, MINIO_ENDPOINT: 'minio', MINIO_USE_SSL: 'TRUE' })).toMatchObject({ endPoint: 'minio', port: undefined, useSSL: true });
    expect(parseMinioConnection({ ...base, MINIO_ENDPOINT: '[::1]:9000' })).toMatchObject({ endPoint: '::1', port: 9000 });
  });
  it('uses MINIO_PORT (foundation .env.example: MINIO_ENDPOINT=<host>) only for a bare host; an explicit port or a URL wins', () => {
    const split = { ...base, MINIO_ENDPOINT: 'localhost', MINIO_PORT: '9000' };
    expect(parseMinioConnection(split)).toMatchObject({ endPoint: 'localhost', port: 9000, useSSL: false });
    expect(parseMinioConnection({ ...split, MINIO_ENDPOINT: 'minio:9100' })).toMatchObject({ port: 9100 });
    expect(parseMinioConnection({ ...split, MINIO_ENDPOINT: 'https://minio.example.test' })).toMatchObject({ port: undefined, useSSL: true });
    expect(() => parseMinioConnection({ ...split, MINIO_PORT: '70000' })).toThrow(/MINIO_PORT/);
  });
  it('falls back to MINIO_ROOT_USER / MINIO_ROOT_PASSWORD; MINIO_ACCESS_KEY wins', () => {
    const root = { MINIO_ENDPOINT: 'localhost:9000', MINIO_ROOT_USER: 'minio', MINIO_ROOT_PASSWORD: 'minio12345' };
    expect(parseMinioConnection(root)).toMatchObject({ accessKey: 'minio', secretKey: 'minio12345' });
    expect(parseMinioConnection({ ...root, MINIO_ACCESS_KEY: 'svc', MINIO_SECRET_KEY: 'svc-secret' })).toMatchObject({ accessKey: 'svc', secretKey: 'svc-secret' });
    expect(parseMinioConnection({ ...root, MINIO_ACCESS_KEY: '  ', MINIO_SECRET_KEY: '' })).toMatchObject({ accessKey: 'minio', secretKey: 'minio12345' });
  });
  it('fails precisely on missing endpoint or credentials', () => {
    expect(() => parseMinioConnection({})).toThrow(/MINIO_ENDPOINT/);
    expect(() => parseMinioConnection({ MINIO_ENDPOINT: 'localhost:9000', MINIO_SECRET_KEY: 'sk' })).toThrow(/MINIO_ACCESS_KEY/);
    expect(() => parseMinioConnection({ MINIO_ENDPOINT: 'localhost:9000', MINIO_ACCESS_KEY: 'ak' })).toThrow(/MINIO_SECRET_KEY/);
  });
  it.each([
    ['port out of range', 'localhost:70000'],
    ['port zero', 'localhost:0'],
    ['unsupported scheme', 'ftp://localhost'],
    ['path', 'http://localhost:9000/bucket'],
    ['credentials in URL', 'http://user:pw@localhost:9000'],
    ['garbage', 'not a host!'],
    ['bare credentials', 'user:pw@localhost:9000'],
    ['query', 'http://localhost:9000/?a=1'],
  ])('rejects %s', (_n, endpoint) => {
    expect(() => parseMinioConnection({ ...base, MINIO_ENDPOINT: endpoint })).toThrow(EnvConfigError);
  });
  it('rejects MINIO_USE_SSL that conflicts with the URL scheme, and non-boolean values', () => {
    expect(() => parseMinioConnection({ ...base, MINIO_ENDPOINT: 'https://m.test', MINIO_USE_SSL: 'false' })).toThrow(/MINIO_USE_SSL/);
    expect(() => parseMinioConnection({ ...base, MINIO_ENDPOINT: 'http://m.test', MINIO_USE_SSL: 'true' })).toThrow(/MINIO_USE_SSL/);
    expect(() => parseMinioConnection({ ...base, MINIO_USE_SSL: 'maybe' })).toThrow(/MINIO_USE_SSL/);
  });
  it('never echoes credentials or a malformed endpoint (which may contain them) in errors', () => {
    for (const env of [{ ...base, MINIO_ENDPOINT: 'user:topsecret@localhost:9000' }, { ...base, MINIO_ENDPOINT: 'http://user:topsecret@localhost' }]) {
      try {
        parseMinioConnection(env);
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain('topsecret');
      }
    }
  });
  it('MinioObjectStore.fromEnv builds a real client without touching the network and honours BSA_BUCKET', () => {
    expect(MinioObjectStore.fromEnv({ ...base, BSA_BUCKET: 'custom-bucket' })).toBeInstanceOf(MinioObjectStore);
    expect(() => MinioObjectStore.fromEnv({ ...base, BSA_BUCKET: 'Bad_Bucket' })).toThrow(ObjectStoreError);
    expect(() => MinioObjectStore.fromEnv({ ...base, BSA_OBJECT_MAX_BYTES: '0' })).toThrow(/BSA_OBJECT_MAX_BYTES/);
  });
});

describe('InMemoryObjectStore', () => {
  it('stores copies, so mutating inputs/outputs cannot corrupt the store', async () => {
    const s = new InMemoryObjectStore();
    const input = Buffer.from('abc');
    await s.put('k', input, 'text/plain');
    input[0] = 0x7a;
    const out = await s.get('k');
    expect(out.toString()).toBe('abc');
    out[0] = 0x7a;
    expect((await s.get('k')).toString()).toBe('abc');
    expect(s.contentTypeOf('k')).toBe('text/plain');
    expect(s.keys()).toEqual(['k']);
  });
  it('behaves like MinIO for missing keys, deletes, validation and size limits', async () => {
    const s = new InMemoryObjectStore({ maxObjectBytes: 4 });
    expect(await codeOfAsync(() => s.get('missing'))).toBe('NOT_FOUND');
    expect(await s.exists('missing')).toBe(false);
    await expect(s.delete('missing')).resolves.toBeUndefined();
    expect(await codeOfAsync(() => s.put('../x', PDF, 'application/pdf'))).toBe('INVALID_KEY');
    expect(await codeOfAsync(() => s.put('k', Buffer.alloc(5), 'application/pdf'))).toBe('TOO_LARGE');
    await s.put('k', Buffer.alloc(4), 'application/pdf');
    await s.delete('k');
    expect(await s.exists('k')).toBe(false);
  });
});

describe('EncryptingObjectStore', () => {
  const cipher = cipherOf('k1', ['k1', 11]);
  let inner: InMemoryObjectStore;
  let store: EncryptingObjectStore;
  beforeEach(() => {
    inner = new InMemoryObjectStore();
    store = new EncryptingObjectStore(inner, cipher);
  });

  it('round-trips and stores only ciphertext with an opaque content type', async () => {
    await store.put('bsa/o/a1.pdf', PDF, 'application/pdf');
    const raw = inner.rawGet('bsa/o/a1.pdf')!;
    expect(raw.length).toBe(2 + 'k1'.length + 12 + PDF.length + 16); // 0x02 | idLen | keyId | nonce | ct | tag
    expect(raw.includes(PDF.subarray(0, 8))).toBe(false);
    expect(inner.contentTypeOf('bsa/o/a1.pdf')).toBe('application/octet-stream');
    expect((await store.get('bsa/o/a1.pdf')).equals(PDF)).toBe(true);
  });

  it('round-trips an empty file and uses a fresh nonce per object', async () => {
    await store.put('e1', Buffer.alloc(0), 'text/plain');
    await store.put('e2', Buffer.alloc(0), 'text/plain');
    expect(await store.get('e1')).toHaveLength(0);
    expect(inner.rawGet('e1')!.equals(inner.rawGet('e2')!)).toBe(false);
  });

  it('detects tampering of stored bytes (INTEGRITY) at every region', async () => {
    await store.put('k', PDF, 'application/pdf');
    const original = inner.rawGet('k')!;
    for (const index of [0, 1, 13, original.length - 1]) {
      const tampered = Buffer.from(original);
      tampered[index] ^= 0x01;
      inner.rawSet('k', tampered);
      expect(await codeOfAsync(() => store.get('k'))).toBe('INTEGRITY');
    }
    inner.rawSet('k', original.subarray(0, original.length - 4)); // truncated
    expect(await codeOfAsync(() => store.get('k'))).toBe('INTEGRITY');
    inner.rawSet('k', Buffer.alloc(0));
    expect(await codeOfAsync(() => store.get('k'))).toBe('INTEGRITY');
    inner.rawSet('k', original);
    expect((await store.get('k')).equals(PDF)).toBe(true);
  });

  it('detects a blob swapped between two object keys (key is bound as AAD)', async () => {
    await store.put('bsa/a', Buffer.from('statement A'), 'text/plain');
    await store.put('bsa/b', Buffer.from('statement B'), 'text/plain');
    inner.rawSet('bsa/a', inner.rawGet('bsa/b')!);
    expect(await codeOfAsync(() => store.get('bsa/a'))).toBe('INTEGRITY');
  });

  it('cannot be read with a different encryption key', async () => {
    await store.put('k', PDF, 'application/pdf');
    const other = new EncryptingObjectStore(inner, cipherOf('k2', ['k2', 77]));
    expect(await codeOfAsync(() => other.get('k'))).toBe('INTEGRITY');
  });

  it('can read objects encrypted under a previous key after rotation', async () => {
    await store.put('k', PDF, 'application/pdf');
    const rotated = new EncryptingObjectStore(inner, cipherOf('k2', ['k1', 11], ['k2', 77]));
    expect((await rotated.get('k')).equals(PDF)).toBe(true);
  });

  it('passes NOT_FOUND through, validates keys before touching the inner store, delegates delete/exists', async () => {
    expect(await codeOfAsync(() => store.get('missing'))).toBe('NOT_FOUND');
    const spy = vi.spyOn(inner, 'put');
    expect(await codeOfAsync(() => store.put('../x', PDF, 'application/pdf'))).toBe('INVALID_KEY');
    expect(await codeOfAsync(() => store.put('k', PDF, 'bad\r\ntype'))).toBe('INVALID_ARGUMENT');
    expect(spy).not.toHaveBeenCalled();
    await store.put('k', PDF, 'application/pdf');
    expect(await store.exists('k')).toBe(true);
    await store.delete('k');
    expect(await store.exists('k')).toBe(false);
  });
});

describe('createObjectStore(env)', () => {
  const minioEnv = { MINIO_ENDPOINT: 'localhost:9000', MINIO_ACCESS_KEY: 'ak', MINIO_SECRET_KEY: 'sk' };
  beforeEach(() => resetObjectStoreWarningsForTests());

  it('without endpoint (non-production) falls back to in-memory and warns loudly exactly once', async () => {
    const warn = vi.fn();
    const first = createObjectStore({}, { warn });
    createObjectStore({ NODE_ENV: 'development' }, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/IN-MEMORY/);
    expect(first).toBeInstanceOf(InMemoryObjectStore);
    await first.put('k', PDF, 'application/pdf');
    expect((await first.get('k')).equals(PDF)).toBe(true);
  });

  it('with endpoint builds a MinioObjectStore (no warning)', () => {
    const warn = vi.fn();
    expect(createObjectStore(minioEnv, { warn })).toBeInstanceOf(MinioObjectStore);
    expect(warn).not.toHaveBeenCalled();
  });

  it('wraps the store with file encryption when DATA_ENCRYPTION_KEY is present, and the wrapped store works', async () => {
    const store = createObjectStore(keyEnv, { warn: () => undefined });
    expect(store).toBeInstanceOf(EncryptingObjectStore);
    await store.put('k', PDF, 'application/pdf');
    expect((await store.get('k')).equals(PDF)).toBe(true);
    expect(createObjectStore({ ...minioEnv, ...keyEnv })).toBeInstanceOf(EncryptingObjectStore);
  });

  it('uses an explicit cipher (shared with PII_CIPHER) and lets tests opt out with null', () => {
    expect(createObjectStore(minioEnv, { cipher: cipherOf('k2', ['k2', 77]) })).toBeInstanceOf(EncryptingObjectStore);
    expect(createObjectStore({ ...minioEnv, ...keyEnv }, { cipher: null })).toBeInstanceOf(MinioObjectStore);
  });

  it('NODE_ENV=production without MINIO_ENDPOINT throws (never silently in-memory)', () => {
    expect(() => createObjectStore({ NODE_ENV: 'production', ...keyEnv })).toThrow(/MINIO_ENDPOINT/);
  });

  it('NODE_ENV=production without an encryption key throws (files are PII)', () => {
    expect(() => createObjectStore({ ...minioEnv, NODE_ENV: 'production' })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => createObjectStore({ ...minioEnv, NODE_ENV: 'production' }, { cipher: null })).toThrow(/DATA_ENCRYPTION_KEY/);
  });

  it('NODE_ENV=production with endpoint + key succeeds', () => {
    expect(createObjectStore({ ...minioEnv, NODE_ENV: 'production', ...keyEnv })).toBeInstanceOf(EncryptingObjectStore);
  });

  it('propagates precise config errors (credentials, bad key)', () => {
    expect(() => createObjectStore({ MINIO_ENDPOINT: 'localhost:9000' })).toThrow(/MINIO_ACCESS_KEY/);
    expect(() => createObjectStore({ ...minioEnv, DATA_ENCRYPTION_KEY: 'short', DATA_INDEX_KEY: INDEX_KEY })).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});
