import { MockOcrProvider, type OcrProvider } from '@los/ocr';
import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OCR_PROVIDER, StatementExtractionError, StatementTextService, TextExtractionModule } from './index';

const CSV = Buffer.from('Date;Desc;Amount\n2026-03-01;Salary;1000,00\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);

afterEach(() => vi.unstubAllEnvs());

describe('TextExtractionModule', () => {
  it('imports:[TextExtractionModule] → StatementTextService; OCR_PROVIDER = createOcrProvider(env) (INTEGRATION_MODE тохируулаагүй → mock)', async () => {
    vi.stubEnv('INTEGRATION_MODE', '');
    const ref = await Test.createTestingModule({ imports: [TextExtractionModule] }).compile();
    const svc = ref.get(StatementTextService);
    expect((await svc.extract({ fileName: 'a.csv', content: CSV })).source).toBe('CSV');
    expect(ref.get<OcrProvider>(OCR_PROVIDER, { strict: false }).name).toBe('mock');
  });

  it('INTEGRATION_MODE=real үед tesseract provider бүтээгдэнэ (дуудахгүй)', async () => {
    vi.stubEnv('INTEGRATION_MODE', 'real');
    const ref = await Test.createTestingModule({ imports: [TextExtractionModule] }).compile();
    expect(ref.get<OcrProvider>(OCR_PROVIDER, { strict: false }).name).toBe('tesseract');
  });

  it('INTEGRATION_MODE буруу → эхлэхэд унана (fail-fast)', async () => {
    vi.stubEnv('INTEGRATION_MODE', 'bogus');
    await expect(Test.createTestingModule({ imports: [TextExtractionModule] }).compile()).rejects.toThrow(/INTEGRATION_MODE/);
  });

  it('register({ options }) → хязгаар дарагдана', async () => {
    const ref = await Test.createTestingModule({ imports: [TextExtractionModule.register({ options: { maxBytes: 10 } })] }).compile();
    const err = (await ref.get(StatementTextService).extract({ fileName: 'a.csv', content: CSV }).catch((e: unknown) => e)) as StatementExtractionError;
    expect(err.code).toBe('TOO_LARGE');
  });

  it('register({ ocrProvider }) → env-ийн оронд бэлэн provider; зураг түүгээр уншигдана', async () => {
    const provider = new MockOcrProvider({ builtins: false, byFileName: [], bySha256: {} });
    const line = { text: 'Hello world', confidence: 0.5, box: { x: 0, y: 5, width: 100, height: 20 }, words: [] };
    const recognize = vi.spyOn(provider, 'recognize').mockResolvedValue({
      engine: 'injected',
      engineVersion: null,
      languages: ['mon'],
      text: 't',
      meanConfidence: 0.5,
      durationMs: 1,
      pages: [{ pageNo: 1, width: 10, height: 10, text: 't', meanConfidence: 0.5, lines: [line] }],
    });
    const ref = await Test.createTestingModule({ imports: [TextExtractionModule.register({ ocrProvider: provider })] }).compile();
    const t = await ref.get(StatementTextService).extract({ fileName: 'a.png', content: PNG });
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(t.meta.ocr?.engine).toBe('injected');
    expect(t.pages[0].lines[0].cells).toEqual(['Hello world']);
  });

  it('register({ options: { ocrFallback: true } }) mock provider-тэй бүтнэ', async () => {
    vi.stubEnv('INTEGRATION_MODE', 'mock');
    const ref = await Test.createTestingModule({ imports: [TextExtractionModule.register({ options: { ocrFallback: true } })] }).compile();
    expect(ref.get(StatementTextService)).toBeInstanceOf(StatementTextService);
  });

  it('экспорт: өөр модуль TextExtractionModule.register(...)-ийг import хийж StatementTextService ба OCR_PROVIDER-ийг inject хийнэ', async () => {
    @Injectable()
    class Consumer {
      constructor(
        @Inject(StatementTextService) readonly text: StatementTextService,
        @Inject(OCR_PROVIDER) readonly ocr: OcrProvider,
      ) {}
    }
    @Module({ imports: [TextExtractionModule.register({ options: { maxBytes: 10 } })], providers: [Consumer] })
    class ConsumerModule {}

    const ref = await Test.createTestingModule({ imports: [ConsumerModule] }).compile();
    const consumer = ref.get(Consumer);
    expect(consumer.ocr.name).toBeTruthy();
    await expect(consumer.text.extract({ fileName: 'a.csv', content: CSV })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
});
