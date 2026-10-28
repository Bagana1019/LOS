// BsaCommonModule — DI (explicit @Inject), global export, fail-fast тохиргоо, lifecycle; README-д env бүр баримтжсан эсэх.
import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BsaCommonModule } from './bsa-common.module';
import { PrismaEventPublisher } from './event-publisher';
import { ImportQueueError, InlineImportQueue } from './import-queue';
import {
  BSA_SETTINGS, EVENT_PUBLISHER, IMPORT_QUEUE, OBJECT_STORE, PII_CIPHER,
  type BsaSettingsProvider, type DomainEventPublisher, type ImportQueue, type ObjectStore, type PiiCipher,
} from './infra.ports';
import { EncryptingObjectStore, InMemoryObjectStore } from './object-store';
import { AesGcmPiiCipher, PiiCipherError } from './pii-cipher';
import { DEFAULT_BSA_SETTINGS } from './settings';

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 5 + 3)).toString('base64');
const MANAGED_ENV = [
  'NODE_ENV', 'PII_ENCRYPTION_KEY', 'PII_ENCRYPTION_KEY_PREVIOUS', 'MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD', 'MINIO_USE_SSL', 'BSA_BUCKET', 'REDIS_URL', 'BSA_MAX_DTI', 'BSA_IMPORT_ATTEMPTS', 'BSA_SETTINGS_CACHE_TTL_MS',
] as const;

/** Provider-ийг constructor-оор, explicit @Inject-ээр авдаг жишээ хэрэглэгч (BsaCommonModule-ийг ИМПОРТЛОХГҮЙ модульд — global шалгана) */
@Injectable()
class Consumer {
  constructor(
    @Inject(PII_CIPHER) readonly cipher: PiiCipher,
    @Inject(OBJECT_STORE) readonly store: ObjectStore,
    @Inject(EVENT_PUBLISHER) readonly publisher: DomainEventPublisher,
    @Inject(IMPORT_QUEUE) readonly queue: ImportQueue,
    @Inject(BSA_SETTINGS) readonly settings: BsaSettingsProvider,
  ) {}
}
@Module({ providers: [Consumer], exports: [Consumer] })
class ConsumerModule {}

const setEnv = (values: Record<string, string>): void => void Object.assign(process.env, values);

describe('BsaCommonModule', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    Logger.overrideLogger(false); // in-memory/inline анхааруулгыг чимээгүй болгоно (хэрэгжүүлэлтийн тест тусдаа шалгасан)
  });
  afterAll(() => {
    Logger.overrideLogger(['log', 'error', 'warn']);
  });
  beforeEach(() => {
    for (const k of MANAGED_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PII_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    for (const k of MANAGED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('provides every port and injects them (global) into a module that does not import it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BsaCommonModule, ConsumerModule] }).compile();
    const c = moduleRef.get(Consumer, { strict: false });

    expect(c.cipher).toBeInstanceOf(AesGcmPiiCipher);
    expect(c.cipher.decrypt(c.cipher.encrypt('Бат-Эрдэнэ'))).toBe('Бат-Эрдэнэ');
    expect(c.cipher.hash(' уа00000000 ')).toBe(c.cipher.hash('УА00000000'));

    expect(c.store).toBeInstanceOf(EncryptingObjectStore); // PII түлхүүртэй → файл шифрлэгдэнэ
    await c.store.put('bsa/org/a1/f1.pdf', Buffer.from('%PDF-synthetic'), 'application/pdf');
    expect((await c.store.get('bsa/org/a1/f1.pdf')).toString()).toBe('%PDF-synthetic');

    expect(c.publisher).toBeInstanceOf(PrismaEventPublisher);
    expect(c.queue).toBeInstanceOf(InlineImportQueue); // REDIS_URL-гүй dev
    expect(await c.settings.get('org-1')).toEqual(DEFAULT_BSA_SETTINGS);
    await moduleRef.close();
  });

  it('the object store and the PII cipher share the key (cipher from PII_CIPHER encrypts the files)', async () => {
    const inner = new InMemoryObjectStore();
    // Ижил түлхүүртэй cipher-ээр гаднаас шифрлэсэн blob-ыг модулийн store уншиж чадах ёстой → store нь PII_CIPHER-ийн түлхүүрийг ашиглаж байна
    const external = new EncryptingObjectStore(inner, new AesGcmPiiCipher({ key: KEY }));
    await external.put('k/a.pdf', Buffer.from('shared'), 'application/pdf');
    const moduleRef = await Test.createTestingModule({ imports: [BsaCommonModule] })
      .overrideProvider(OBJECT_STORE)
      .useFactory({ factory: (cipher: PiiCipher) => new EncryptingObjectStore(inner, cipher as AesGcmPiiCipher), inject: [PII_CIPHER] })
      .compile();
    expect((await moduleRef.get<ObjectStore>(OBJECT_STORE).get('k/a.pdf')).toString()).toBe('shared');
    await moduleRef.close();
  });

  it('providers can be overridden in tests', async () => {
    const fake: PiiCipher = { encrypt: (p) => `fake:${p}`, decrypt: (c) => c.slice(5), hash: (p) => `h:${p}` };
    const moduleRef = await Test.createTestingModule({ imports: [BsaCommonModule] }).overrideProvider(PII_CIPHER).useValue(fake).compile();
    expect(moduleRef.get<PiiCipher>(PII_CIPHER)).toBe(fake);
    // PII_CIPHER bytes шифрлэхгүй болсон ч OBJECT_STORE env-ээс (түлхүүртэй → шифрлэнэ) шийдэгдсэн хэвээр
    expect(moduleRef.get(OBJECT_STORE)).toBeInstanceOf(EncryptingObjectStore);
    await moduleRef.close();
  });

  it('without MINIO_ENDPOINT or PII key outside production: in-memory, unencrypted store still works when the cipher is a test double', async () => {
    delete process.env.PII_ENCRYPTION_KEY;
    const fake: PiiCipher = { encrypt: (p) => p, decrypt: (c) => c, hash: (p) => p };
    const moduleRef = await Test.createTestingModule({ imports: [BsaCommonModule] }).overrideProvider(PII_CIPHER).useValue(fake).compile();
    const store = moduleRef.get<ObjectStore>(OBJECT_STORE);
    expect(store).toBeInstanceOf(InMemoryObjectStore);
    await moduleRef.close();
  });

  it.each([
    ['missing PII_ENCRYPTION_KEY', () => delete process.env.PII_ENCRYPTION_KEY, /PII_ENCRYPTION_KEY/],
    ['16-byte PII_ENCRYPTION_KEY', () => (process.env.PII_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64')), /32 bytes/],
    ['invalid BSA_MAX_DTI', () => (process.env.BSA_MAX_DTI = 'lots'), /BSA_MAX_DTI/],
    ['invalid BSA_IMPORT_ATTEMPTS', () => (process.env.BSA_IMPORT_ATTEMPTS = '0'), /BSA_IMPORT_ATTEMPTS/],
    ['malformed MINIO_ENDPOINT', () => setEnv({ MINIO_ENDPOINT: 'http://h/path', MINIO_ACCESS_KEY: 'a', MINIO_SECRET_KEY: 's' }), /MINIO_ENDPOINT/],
    ['MinIO without credentials', () => setEnv({ MINIO_ENDPOINT: 'localhost:9000' }), /MINIO_ACCESS_KEY/],
    ['production without MINIO_ENDPOINT', () => setEnv({ NODE_ENV: 'production', REDIS_URL: 'redis://127.0.0.1:1' }), /MINIO_ENDPOINT/],
    [
      'production without REDIS_URL',
      () => setEnv({ NODE_ENV: 'production', MINIO_ENDPOINT: 'localhost:9000', MINIO_ROOT_USER: 'u', MINIO_ROOT_PASSWORD: 'p' }),
      /REDIS_URL/,
    ],
    ['invalid REDIS_URL', () => (process.env.REDIS_URL = 'http://cache'), /REDIS_URL/],
  ])('fails fast at startup: %s', async (_n, arrange, pattern) => {
    arrange();
    await expect(Test.createTestingModule({ imports: [BsaCommonModule] }).compile()).rejects.toThrow(pattern);
  });

  it('a missing key is reported with the typed cipher error', async () => {
    delete process.env.PII_ENCRYPTION_KEY;
    await expect(Test.createTestingModule({ imports: [BsaCommonModule] }).compile()).rejects.toBeInstanceOf(PiiCipherError);
  });

  it('closing the application closes the import queue (graceful shutdown)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BsaCommonModule] }).compile();
    const queue = moduleRef.get<ImportQueue>(IMPORT_QUEUE);
    await moduleRef.close();
    await expect(queue.enqueue('6f1b2c3d-1111-4111-8111-000000000001')).rejects.toBeInstanceOf(ImportQueueError);
  });

  it('BullMQ queue is created lazily: a configured but unreachable Redis does not stop the app from booting', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const moduleRef = await Test.createTestingModule({ imports: [BsaCommonModule] }).compile();
    await moduleRef.close();
  });
});

describe('README documents every environment variable the adapters read', () => {
  const dir = __dirname;
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'infra.ports.ts')
    .map((f) => readFileSync(join(dir, f), 'utf8'));

  /** `env.NAME`, `envXxx(env, 'NAME'`, `new EnvConfigError('NAME'`, settings.ts-ийн ENV_SPECS мөрүүд */
  const names = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) names.add(m[1]);
    for (const m of src.matchAll(/\benv[A-Za-z]*\(\s*env,\s*'([A-Z][A-Z0-9_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/\bnew EnvConfigError\(\s*'([A-Z][A-Z0-9_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/\b(?:num|int)\(\s*'([A-Z][A-Z0-9_]+)'|\benv: '([A-Z][A-Z0-9_]+)'/g)) names.add(m[1] ?? m[2]);
  }

  it('finds the variables (guards the scan itself)', () => {
    const expectedNames = ['PII_ENCRYPTION_KEY', 'PII_ENCRYPTION_KEY_PREVIOUS', 'MINIO_ENDPOINT', 'MINIO_USE_SSL', 'REDIS_URL', 'BSA_MAX_DTI'];
    for (const expected of [...expectedNames, 'DEFAULT_ORG_ID', 'NODE_ENV']) {
      expect(names.has(expected), expected).toBe(true);
    }
  });

  it('every variable appears in README.md', () => {
    const missing = [...names].filter((n) => !readme.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });
});
