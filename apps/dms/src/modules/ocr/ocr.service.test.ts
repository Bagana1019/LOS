import { Logger } from '@nestjs/common';
import {
  FIXTURE_ID_CARD_TEXT,
  FIXTURE_SALARY_CERTIFICATE_TEXT,
  MockOcrProvider,
  OcrError,
  ocrResultFromText,
  SYNTHETIC_REGISTER_NO,
  type OcrProvider,
  type OcrResult,
} from '@los/ocr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GateFullError } from './concurrency-gate';
import type { OcrHttpConfig } from './ocr.config';
import { OcrService, type ExtractCommand } from './ocr.service';

const CONFIG: OcrHttpConfig = { maxFileBytes: 1024, maxConcurrency: 2, maxQueue: 4 };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const NOW = new Date('2026-10-28T03:00:00Z');

function cmd(over: Partial<ExtractCommand> = {}): ExtractCommand {
  return { content: PNG, mimeType: 'image/png', fileName: 'id-card.png', docType: 'AUTO', includeText: false, ...over };
}

function make(provider: OcrProvider = new MockOcrProvider(), config: OcrHttpConfig = CONFIG, clock: () => Date = () => NOW) {
  return new OcrService(provider, config, clock);
}

describe('OcrService.extract', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('ID картыг AUTO-оор танина, талбаруудыг буцаана', async () => {
    const r = await make().extract(cmd());
    expect(r.docType).toBe('ID_CARD');
    expect(r.detectedDocType).toBe('ID_CARD');
    expect(r.fields.registerNo.value).toBe(SYNTHETIC_REGISTER_NO);
    expect(r.fields.lastName.value).toBe('Дорж');
    expect(r.ocr.engine).toBe('mock');
    expect(r.ocr.pageCount).toBe(1);
    expect(r.ocr).not.toHaveProperty('text');
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('docType-ыг тодорхой зааж болно (SALARY_CERTIFICATE)', async () => {
    const r = await make().extract(cmd({ fileName: 'salary.png', docType: 'SALARY_CERTIFICATE' }));
    expect(r.docType).toBe('SALARY_CERTIFICATE');
    expect(r.fields.monthlySalary.value).toBe(1_800_000);
  });

  it('includeText=true үед л OCR текст орно', async () => {
    const withText = await make().extract(cmd({ includeText: true }));
    expect(withText.ocr.text).toContain('Дорж');
    const without = await make().extract(cmd({ includeText: false }));
    expect(without.ocr.text).toBeUndefined();
  });

  it('үнэмлэхний хугацаа дууссан эсэхийг clock-оор (Улаанбаатарын өдөр) шалгана', async () => {
    const future = await make(undefined, CONFIG, () => new Date('2031-01-01T00:00:00Z')).extract(cmd());
    expect(future.warnings.join(' ')).toContain('хугацаа дууссан');
    const now = await make().extract(cmd());
    expect(now.warnings.join(' ')).not.toContain('хугацаа дууссан');
  });

  it('Улаанбаатарын цагийн бүсээр өдрийг тооцно (UTC 2030-04-12 17:00 = УБ 2030-04-13)', async () => {
    const r = await make(undefined, CONFIG, () => new Date('2030-04-12T17:00:00Z')).extract(cmd());
    expect(r.warnings.join(' ')).toContain('хугацаа дууссан');
    const before = await make(undefined, CONFIG, () => new Date('2030-04-12T15:00:00Z')).extract(cmd());
    expect(before.warnings.join(' ')).not.toContain('хугацаа дууссан');
  });

  it('provider-ийн OcrError-ыг хэвээр дамжуулна', async () => {
    await expect(make().extract(cmd({ fileName: 'unknown.png' }))).rejects.toMatchObject({ code: 'NO_FIXTURE' });
    const failing: OcrProvider = {
      name: 'x',
      recognize: async () => {
        throw new OcrError('TIMEOUT', 'x');
      },
    };
    await expect(make(failing).extract(cmd())).rejects.toBeInstanceOf(OcrError);
  });

  it('PII-гүй лог: талбарын утга, текст, файлын нэр орохгүй; correlationId орно', async () => {
    await make().extract(cmd({ includeText: true, correlationId: 'corr-1' }));
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ event: 'ocr.extract', correlationId: 'corr-1', docType: 'ID_CARD', engine: 'mock', bytes: PNG.length, pages: 1 });
    expect(typeof parsed.fieldsFound).toBe('number');
    for (const secret of [SYNTHETIC_REGISTER_NO, 'Дорж', 'Болд', 'MN1234567', 'id-card', '1985']) expect(line).not.toContain(secret);
  });

  it('дараалал дүүрэн бол GateFullError (429)', async () => {
    let release!: () => void;
    const slow: OcrProvider = {
      name: 'slow',
      recognize: () => new Promise<OcrResult>((resolve) => (release = () => resolve(fakeResult(FIXTURE_ID_CARD_TEXT)))),
    };
    const svc = make(slow, { maxFileBytes: 1024, maxConcurrency: 1, maxQueue: 0 });
    const first = svc.extract(cmd());
    await new Promise((r) => setImmediate(r));
    await expect(svc.extract(cmd())).rejects.toBeInstanceOf(GateFullError);
    release();
    await expect(first).resolves.toMatchObject({ docType: 'ID_CARD' });
    // слот чөлөөлөгдсөн: дараагийн хүсэлт зөвшөөрөгдөнө
    const second = svc.extract(cmd());
    await new Promise((r) => setImmediate(r));
    release();
    await expect(second).resolves.toBeDefined();
  });

  it('GENERIC / SALARY нэмэлт: сарын цалин fixture-аас', async () => {
    const provider: OcrProvider = { name: 'fix', recognize: async () => fakeResult(FIXTURE_SALARY_CERTIFICATE_TEXT) };
    const r = await make(provider).extract(cmd({ docType: 'AUTO' }));
    expect(r.docType).toBe('SALARY_CERTIFICATE');
  });
});

describe('OcrService.docTypes', () => {
  it('AUTO + 3 төрөл, талбарын жагсаалттай', () => {
    const { docTypes } = make().docTypes();
    expect(docTypes.map((d) => d.code)).toEqual(['AUTO', 'ID_CARD', 'SALARY_CERTIFICATE', 'GENERIC']);
    expect(docTypes.find((d) => d.code === 'ID_CARD')?.fields).toContain('registerNo');
    expect(docTypes.every((d) => typeof d.name === 'string' && d.name.length > 0)).toBe(true);
  });
});

describe('OcrService.health', () => {
  it('mock: ok', async () => {
    expect(await make().health()).toMatchObject({ ok: true, provider: 'mock' });
  });

  it('healthCheck-гүй provider: ok', async () => {
    const r = await make({ name: 'bare', recognize: vi.fn() }).health();
    expect(r).toMatchObject({ ok: true, provider: 'bare' });
  });

  it('ok=false-ийг дамжуулна', async () => {
    const p: OcrProvider = { name: 't', recognize: vi.fn(), healthCheck: async () => ({ ok: false, detail: 'tesseract олдсонгүй' }) };
    expect(await make(p).health()).toEqual({ ok: false, provider: 't', detail: 'tesseract олдсонгүй' });
  });

  it('healthCheck шидвэл ok=false, алдааны мессеж задрахгүй', async () => {
    const p: OcrProvider = {
      name: 't',
      recognize: vi.fn(),
      healthCheck: async () => {
        throw new Error('/secret/path/ЖЮ85061512');
      },
    };
    const r = await make(p).health();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});

// туслах: текстээс OcrResult (provider-ийн хуурамч хариу)
function fakeResult(text: string): OcrResult {
  return ocrResultFromText(text, 0.95, 'fake');
}
