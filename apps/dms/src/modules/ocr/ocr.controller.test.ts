// POST /api/ocr/extract, GET /api/ocr/doc-types, GET /api/ocr/health — Nest testing module + supertest (бодит HTTP, multer).
// Бүх файл ЗОХИОМОЛ: PNG/PDF-ийн зөвхөн magic bytes. Бодит OCR биш — MockOcrProvider / stub provider.
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MockOcrProvider, OcrError, SYNTHETIC_REGISTER_NO, type OcrErrorCode, type OcrInput, type OcrProvider, type OcrResult } from '@los/ocr';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OCR_PROVIDER, OcrModule } from './ocr.module';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_HEAD, Buffer.alloc(64)]);
const PDF = Buffer.from('%PDF-1.4\n%synthetic\n');
const PII = `${SYNTHETIC_REGISTER_NO} Дорж Болд MN640005123456789012`;

type Env = Record<string, string | undefined>;
const ENV_KEYS = ['INTEGRATION_MODE', 'OCR_ENGINE', 'TESSERACT_BIN', 'OCR_MAX_FILE_BYTES', 'OCR_MAX_CONCURRENCY', 'OCR_MAX_QUEUE'];

/** env-ийг модуль үүсэх үед л унших тул compile-ийн дараа шууд сэргээнэ */
async function createApp(opts: { env?: Env; provider?: OcrProvider | null } = {}): Promise<INestApplication> {
  const saved: Env = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, opts.env ?? {});
  try {
    let builder = Test.createTestingModule({ imports: [OcrModule] });
    if (opts.provider !== null) builder = builder.overrideProvider(OCR_PROVIDER).useValue(opts.provider ?? new MockOcrProvider());
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api'); // main.ts-тэй адил
    await app.listen(0);
    return app;
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const http = (app: INestApplication) => request(app.getHttpServer());

function failingProvider(code: OcrErrorCode, message = PII): OcrProvider {
  return {
    name: 'stub',
    recognize: async () => {
      throw new OcrError(code, message);
    },
  };
}

describe('OcrController', () => {
  let app: INestApplication;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  describe('POST /api/ocr/extract', () => {
    beforeEach(async () => {
      app = await createApp();
    });

    it('ID карт: 200, AUTO-оор таньж талбаруудыг буцаана; хариу cache-д орохгүй', async () => {
      const res = await http(app).post('/api/ocr/extract').attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({ docType: 'ID_CARD', detectedDocType: 'ID_CARD' });
      expect(res.body.fields.registerNo.value).toBe(SYNTHETIC_REGISTER_NO);
      expect(res.body.fields.birthDate.value).toBe('1985-06-15');
      expect(res.body.ocr).toMatchObject({ engine: 'mock', pageCount: 1 });
      expect(res.body.ocr.text).toBeUndefined();
      expect(Array.isArray(res.body.warnings)).toBe(true);
    });

    it('docType=SALARY_CERTIFICATE', async () => {
      const res = await http(app).post('/api/ocr/extract').field('docType', 'SALARY_CERTIFICATE').attach('file', PNG, 'salary.png');
      expect(res.status).toBe(200);
      expect(res.body.docType).toBe('SALARY_CERTIFICATE');
      expect(res.body.fields.monthlySalary.value).toBe(1_800_000);
    });

    it('docType=GENERIC', async () => {
      const res = await http(app).post('/api/ocr/extract').field('docType', 'GENERIC').attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(200);
      expect(res.body.docType).toBe('GENERIC');
      expect(res.body.fields.registerNos.value).toContain(SYNTHETIC_REGISTER_NO);
    });

    it('includeText=true үед OCR текст орно', async () => {
      const res = await http(app).post('/api/ocr/extract').field('includeText', 'true').attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(200);
      expect(res.body.ocr.text).toContain('Дорж');
    });

    it('файлаа JSON толгойтой нэр, зайтай нэр, Кирилл нэртэй ч хүлээж авна (нэр ашиглагдахгүй)', async () => {
      const res = await http(app).post('/api/ocr/extract').attach('file', PNG, 'Миний id card.png');
      expect(res.status).toBe(200);
      expect(res.body.docType).toBe('ID_CARD');
    });

    it('файл байхгүй: 400 FILE_REQUIRED', async () => {
      const res = await http(app).post('/api/ocr/extract').field('docType', 'AUTO');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FILE_REQUIRED');
    });

    it('JSON (multipart биш) хүсэлт: 400 FILE_REQUIRED', async () => {
      const res = await http(app).post('/api/ocr/extract').send({ docType: 'AUTO' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FILE_REQUIRED');
    });

    it('хоосон файл: 400 FILE_REQUIRED', async () => {
      const res = await http(app).post('/api/ocr/extract').attach('file', Buffer.alloc(0), 'id-card.png');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FILE_REQUIRED');
    });

    it('magic bytes таарахгүй (текст файл, Content-Type=image/png гэж худал): 415, агуулга хариунд орохгүй', async () => {
      const res = await http(app).post('/api/ocr/extract').attach('file', Buffer.from(PII), { filename: 'id-card.png', contentType: 'image/png' });
      expect(res.status).toBe(415);
      expect(res.body.code).toBe('UNSUPPORTED_MIME');
      expect(JSON.stringify(res.body)).not.toMatch(/ЖЮ85061512|Дорж|MN6400|id-card/);
    });

    it.each([
      ['SVG', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ['ZIP', 'PK\u0003\u0004zzzz'],
      ['PDF эхлэл дундаас', 'junk%PDF-1.4'],
      ['tesseract файлын жагсаалт (local file read)', '/etc/passwd\n/etc/shadow\n'],
    ])('%s: 415', async (_name, content) => {
      const res = await http(app).post('/api/ocr/extract').attach('file', Buffer.from(content, 'latin1'), 'id-card.png');
      expect(res.status).toBe(415);
    });

    it('Content-Type толгойд итгэхгүй: PDF bytes + image/png толгой => provider-т application/pdf очно', async () => {
      const inner = new MockOcrProvider();
      const seen: OcrInput[] = [];
      const spy: OcrProvider = {
        name: 'spy',
        recognize: async (input) => {
          seen.push(input);
          return inner.recognize(input);
        },
      };
      await app.close();
      app = await createApp({ provider: spy });
      const res = await http(app).post('/api/ocr/extract').attach('file', PDF, { filename: 'id-card.pdf', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(seen[0].mimeType).toBe('application/pdf');
      expect(Buffer.compare(seen[0].content, PDF)).toBe(0);
    });

    it.each([
      ['PNG', PNG, 'image/png'],
      ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg'],
      ['TIFF', Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0]), 'image/tiff'],
      ['WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]), 'image/webp'],
      ['PDF', PDF, 'application/pdf'],
    ])('%s magic bytes-ыг зөв төрлөөр provider-т дамжуулна', async (_name, content, mime) => {
      const inner = new MockOcrProvider();
      const spy = vi.fn((input: OcrInput) => inner.recognize(input));
      await app.close();
      app = await createApp({ provider: { name: 'spy', recognize: spy } });
      const res = await http(app).post('/api/ocr/extract').attach('file', content, 'id-card.bin');
      expect(res.status).toBe(200);
      expect(spy.mock.calls[0][0].mimeType).toBe(mime);
    });

    it('замтай файлын нэр (../../) provider-т зөвхөн basename болж очно', async () => {
      const spy = vi.fn(async (input: OcrInput) => new MockOcrProvider().recognize(input));
      await app.close();
      app = await createApp({ provider: { name: 'spy', recognize: spy } });
      const res = await http(app).post('/api/ocr/extract').attach('file', PNG, '../../etc/id-card.png');
      expect(res.status).toBe(200);
      expect(spy.mock.calls[0][0].fileName).toBe('id-card.png');
    });

    it.each([
      ['docType=PASSPORT', { docType: 'PASSPORT' }],
      ['docType жижиг үсэг', { docType: 'id_card' }],
      ['includeText=yes', { includeText: 'yes' }],
      ['үл мэдэгдэх талбар', { debug: '1' }],
    ])('%s: 400 VALIDATION_FAILED', async (_name, fields) => {
      let req = http(app).post('/api/ocr/extract');
      for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
      const res = await req.attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.issues.length).toBeGreaterThan(0);
    });

    it('бүтэлгүй validation нь ирсэн утгыг эргүүлж харуулахгүй', async () => {
      const res = await http(app).post('/api/ocr/extract').field('docType', PII).attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/ЖЮ85061512|Дорж|MN6400/);
    });

    it('хэт урт текст талбар: 400', async () => {
      const res = await http(app).post('/api/ocr/extract').field('docType', 'A'.repeat(1000)).attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(400);
    });

    it('2 файл: 400 (files=1)', async () => {
      const res = await http(app).post('/api/ocr/extract').attach('file', PNG, 'a.png').attach('file', PNG, 'b.png');
      expect(res.status).toBe(400);
    });

    it('өөр нэртэй файл талбар: 400', async () => {
      const res = await http(app).post('/api/ocr/extract').attach('document', PNG, 'id-card.png');
      expect(res.status).toBe(400);
    });

    it('GET /api/ocr/extract: 404', async () => {
      const res = await http(app).get('/api/ocr/extract');
      expect(res.status).toBe(404);
    });

    it('X-Correlation-Id зөв бол логт, хариунд орохгүй; буруу бол орохгүй', async () => {
      const ok = await http(app).post('/api/ocr/extract').set('X-Correlation-Id', 'req-42').attach('file', PNG, 'id-card.png');
      expect(ok.status).toBe(200);
      expect(JSON.stringify(ok.body)).not.toContain('req-42');
      expect(String(log.mock.calls.at(-1)?.[0])).toContain('"correlationId":"req-42"');

      log.mockClear();
      await http(app).post('/api/ocr/extract').set('X-Correlation-Id', 'bad"id{x}').attach('file', PNG, 'id-card.png');
      expect(String(log.mock.calls.at(-1)?.[0])).not.toContain('bad');
    });

    it('лог PII агуулахгүй', async () => {
      await http(app).post('/api/ocr/extract').field('includeText', 'true').attach('file', PNG, 'id-card.png');
      const all = JSON.stringify(log.mock.calls);
      expect(all).toContain('ocr.extract');
      expect(all).not.toMatch(/ЖЮ85061512|Дорж|Болд|MN1234567|1985/);
    });
  });

  describe('файлын хэмжээний хязгаар', () => {
    it('OCR_MAX_FILE_BYTES-аас том: 413', async () => {
      app = await createApp({ env: { OCR_MAX_FILE_BYTES: '2048' } });
      const big = Buffer.concat([PNG_HEAD, Buffer.alloc(4096)]);
      const res = await http(app).post('/api/ocr/extract').attach('file', big, 'id-card.png');
      expect(res.status).toBe(413);
    });

    it('хязгаарт багтсан файл зөвшөөрөгдөнө', async () => {
      app = await createApp({ env: { OCR_MAX_FILE_BYTES: '2048' } });
      const res = await http(app).post('/api/ocr/extract').attach('file', Buffer.concat([PNG_HEAD, Buffer.alloc(1000)]), 'id-card.png');
      expect(res.status).toBe(200);
    });

    it('анхдагч хязгаар 10 MB: 10 MB-аас бага файл OK, илүү нь 413', async () => {
      app = await createApp();
      const under = Buffer.concat([PNG_HEAD, Buffer.alloc(9 * 1024 * 1024)]);
      expect((await http(app).post('/api/ocr/extract').attach('file', under, 'id-card.png')).status).toBe(200);
      const over = Buffer.concat([PNG_HEAD, Buffer.alloc(10 * 1024 * 1024 + 1)]);
      expect((await http(app).post('/api/ocr/extract').attach('file', over, 'id-card.png')).status).toBe(413);
    });
  });

  describe('OcrError -> HTTP', () => {
    const cases: Array<[OcrErrorCode, number]> = [
      ['UNSUPPORTED_MIME', 415],
      ['INVALID_INPUT', 400],
      ['EMPTY_RESULT', 422],
      ['ENGINE_UNAVAILABLE', 503],
      ['TIMEOUT', 504],
      ['ENGINE_FAILED', 502],
      ['NO_FIXTURE', 422],
    ];

    it.each(cases)('provider %s -> %i, PII-тэй мессеж хариунд ЭСВЭЛ логт орохгүй', async (code, status) => {
      app = await createApp({ provider: failingProvider(code) });
      const res = await http(app).post('/api/ocr/extract').set('X-Correlation-Id', 'c-1').attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ statusCode: status, code });
      expect(typeof res.body.message).toBe('string');
      expect(JSON.stringify(res.body)).not.toMatch(/ЖЮ85061512|Дорж|MN6400/);
      expect(JSON.stringify([...log.mock.calls, ...vi.mocked(Logger.prototype.warn).mock.calls])).not.toMatch(/ЖЮ85061512|Дорж|MN6400/);
    });

    it('MockOcrProvider NO_FIXTURE (танигдаагүй нэр): 422', async () => {
      app = await createApp();
      const res = await http(app).post('/api/ocr/extract').attach('file', PNG, 'something-else.png');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('NO_FIXTURE');
    });

    it('OcrError биш гэнэтийн алдаа: 500, мессеж задрахгүй', async () => {
      const provider: OcrProvider = {
        name: 'boom',
        recognize: async () => {
          throw new Error(`DB password for ${PII}`);
        },
      };
      app = await createApp({ provider });
      const res = await http(app).post('/api/ocr/extract').attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/ЖЮ85061512|password/);
    });
  });

  describe('concurrency gate', () => {
    it('завгүй үед 429 BUSY, чөлөөлөгдсөний дараа дахин OK', async () => {
      const inner = new MockOcrProvider();
      let release!: () => void;
      let started = false;
      const slow: OcrProvider = {
        name: 'slow',
        recognize: (input: OcrInput) =>
          new Promise<OcrResult>((resolve, reject) => {
            started = true;
            release = () => inner.recognize(input).then(resolve, reject);
          }),
      };
      app = await createApp({ provider: slow, env: { OCR_MAX_CONCURRENCY: '1', OCR_MAX_QUEUE: '0' } });
      const first = http(app).post('/api/ocr/extract').attach('file', PNG, 'id-card.png').then((r) => r);
      for (let i = 0; i < 200 && !started; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(started).toBe(true);

      const busy = await http(app).post('/api/ocr/extract').attach('file', PNG, 'id-card.png');
      expect(busy.status).toBe(429);
      expect(busy.body.code).toBe('BUSY');

      release();
      expect((await first).status).toBe(200);

      started = false;
      const again = http(app).post('/api/ocr/extract').attach('file', PNG, 'id-card.png').then((r) => r);
      for (let i = 0; i < 200 && !started; i += 1) await new Promise((r) => setTimeout(r, 10));
      release();
      expect((await again).status).toBe(200);
    });
  });

  describe('GET /api/ocr/doc-types', () => {
    it('AUTO + 3 төрөл', async () => {
      app = await createApp();
      const res = await http(app).get('/api/ocr/doc-types');
      expect(res.status).toBe(200);
      expect(res.body.docTypes.map((d: { code: string }) => d.code)).toEqual(['AUTO', 'ID_CARD', 'SALARY_CERTIFICATE', 'GENERIC']);
      expect(res.body.docTypes.find((d: { code: string }) => d.code === 'SALARY_CERTIFICATE').fields).toContain('monthlySalary');
    });
  });

  describe('GET /api/ocr/health', () => {
    it('mock: 200 ok', async () => {
      app = await createApp();
      const res = await http(app).get('/api/ocr/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, provider: 'mock' });
    });

    it('provider ok=false: 503', async () => {
      const provider: OcrProvider = { name: 'tesseract', recognize: vi.fn(), healthCheck: async () => ({ ok: false, detail: 'tesseract олдсонгүй' }) };
      app = await createApp({ provider });
      const res = await http(app).get('/api/ocr/health');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, provider: 'tesseract', detail: 'tesseract олдсонгүй' });
    });

    it('healthCheck шидвэл: 503', async () => {
      const provider: OcrProvider = {
        name: 'x',
        recognize: vi.fn(),
        healthCheck: async () => {
          throw new Error('secret');
        },
      };
      app = await createApp({ provider });
      const res = await http(app).get('/api/ocr/health');
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('secret');
    });
  });

  describe('default wiring (OCR_PROVIDER = createOcrProvider(process.env))', () => {
    it('INTEGRATION_MODE тохируулаагүй: mock provider, бүтэн урсгал ажиллана', async () => {
      app = await createApp({ provider: null });
      const res = await http(app).post('/api/ocr/extract').attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(200);
      expect(res.body.ocr.engine).toBe('mock');
    });

    it('INTEGRATION_MODE=real, tesseract олдохгүй: health 503 (хүсэлтэд Error биш)', async () => {
      app = await createApp({ provider: null, env: { INTEGRATION_MODE: 'real', TESSERACT_BIN: '/nonexistent/tesseract-xyz' } });
      const health = await http(app).get('/api/ocr/health');
      expect(health.status).toBe(503);
      expect(health.body.ok).toBe(false);
      expect(health.body.provider).toBe('tesseract');
      const res = await http(app).post('/api/ocr/extract').attach('file', PNG, 'id-card.png');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ENGINE_UNAVAILABLE');
    });

    it('INTEGRATION_MODE буруу бол эхлэхэд Error', async () => {
      await expect(createApp({ provider: null, env: { INTEGRATION_MODE: 'prod' } })).rejects.toThrow('INTEGRATION_MODE');
    });

    it('OCR_MAX_FILE_BYTES буруу бол эхлэхэд Error', async () => {
      await expect(createApp({ env: { OCR_MAX_FILE_BYTES: 'abc' } })).rejects.toThrow('OCR_MAX_FILE_BYTES');
    });
  });
});
