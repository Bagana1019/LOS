import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockOcrProvider } from './providers/mock.provider';
import { ocrResultFromText } from './providers/result';
import { OcrDocumentService } from './ocr-document.service';
import { OcrError, type OcrInput, type OcrProvider, type OcrResult } from './types';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

class SpyProvider implements OcrProvider {
  readonly name = 'spy';
  inputs: OcrInput[] = [];
  constructor(private readonly result: OcrResult | OcrError) {}
  async recognize(input: OcrInput): Promise<OcrResult> {
    this.inputs.push(input);
    if (this.result instanceof OcrError) throw this.result;
    return this.result;
  }
}

afterEach(() => vi.restoreAllMocks());

describe('OcrDocumentService', () => {
  it('mock provider + extractor: AUTO төрөл, OCR мэдээлэл, includeText=false үед текст ОРОХГҮЙ', async () => {
    const svc = new OcrDocumentService(new MockOcrProvider());
    const r = await svc.analyze({ content: PNG, mimeType: 'image/png', fileName: 'id-card.png' });
    expect(r.extraction).toMatchObject({ docType: 'ID_CARD', detectedDocType: 'ID_CARD', engine: 'mock' });
    expect(r.extraction.fields.registerNo.value).toBe('ЖЮ85061512');
    expect(r.ocr).toEqual({ engine: 'mock', meanConfidence: 0.99, pageCount: 1, durationMs: 0 });
    expect(r.ocr).not.toHaveProperty('text');
    expect(JSON.stringify(r.ocr)).not.toContain('Дорж');
  });

  it('includeText=true үед л бүтэн текст', async () => {
    const svc = new OcrDocumentService(new MockOcrProvider());
    const r = await svc.analyze({ content: PNG, mimeType: 'image/png', fileName: 'salary.png', includeText: true });
    expect(r.ocr.text).toContain('ЦАЛИНГИЙН ТОДОРХОЙЛОЛТ');
    expect(r.extraction.docType).toBe('SALARY_CERTIFICATE');
  });

  it('тодорхой docType өгөхөд тэр төрлөөр задлана (зөрүү байвал анхааруулга)', async () => {
    const svc = new OcrDocumentService(new MockOcrProvider());
    const r = await svc.analyze({ content: PNG, mimeType: 'image/png', fileName: 'salary.png', docType: 'GENERIC' });
    expect(r.extraction.docType).toBe('GENERIC');
    expect(r.extraction.fields.registerNos.value).toEqual(['ЖЮ85061512']);
  });

  it('mime, fileName, languages, timeoutMs-ийг provider-т дамжуулна', async () => {
    const spy = new SpyProvider(ocrResultFromText('Овог: Дорж'));
    await new OcrDocumentService(spy).analyze({ content: PNG, mimeType: 'image/jpeg', fileName: 'a.jpg', languages: ['eng'], timeoutMs: 5000 });
    expect(spy.inputs).toEqual([{ content: PNG, mimeType: 'image/jpeg', fileName: 'a.jpg', languages: ['eng'], timeoutMs: 5000 }]);
  });

  it('extractOptions нь дуудлага бүрт уншигдаж (today г.м.) задлалтад дамжина', async () => {
    const spy = new SpyProvider(ocrResultFromText('Хүчинтэй хугацаа: 2020.04.12'));
    let today = '2019-01-01';
    const svc = new OcrDocumentService(spy, () => ({ today }));
    expect((await svc.analyze({ content: PNG, mimeType: 'image/png', docType: 'ID_CARD' })).extraction.warnings.filter((w) => w.startsWith('expiryDate'))).toEqual([]);
    today = '2026-10-28';
    expect((await svc.analyze({ content: PNG, mimeType: 'image/png', docType: 'ID_CARD' })).extraction.warnings.filter((w) => w.startsWith('expiryDate'))).toHaveLength(1);
  });

  it('OCR-ийн warnings (хуудас таслагдсан г.м.) задлалтын warnings-д орно; pageCount', async () => {
    const ocr = { ...ocrResultFromText('нэг\fхоёр\fгурав'), warnings: ['PDF 3-аас олон хуудастай'] };
    const r = await new OcrDocumentService(new SpyProvider(ocr)).analyze({ content: PNG, mimeType: 'application/pdf' });
    expect(r.ocr.pageCount).toBe(3);
    expect(r.extraction.warnings).toContain('PDF 3-аас олон хуудастай');
  });

  it('provider-ийн OcrError-ыг өөрчлөхгүй дамжуулна; буруу оролт → INVALID_INPUT', async () => {
    const boom = new OcrError('TIMEOUT', 'хугацаа хэтэрлээ');
    await expect(new OcrDocumentService(new SpyProvider(boom)).analyze({ content: PNG, mimeType: 'image/png' })).rejects.toBe(boom);
    await expect(new OcrDocumentService(new MockOcrProvider()).analyze({ content: PNG, mimeType: 'image/png', fileName: 'x.png' })).rejects.toMatchObject({ code: 'NO_FIXTURE' });
    await expect(new OcrDocumentService(new MockOcrProvider()).analyze({ content: 'x' as unknown as Buffer, mimeType: 'image/png' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('PII логлохгүй: console-д юу ч бичигдэхгүй', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const svc = new OcrDocumentService(new MockOcrProvider());
    await svc.analyze({ content: PNG, mimeType: 'image/png', fileName: 'id-card.png', includeText: true });
    await svc.analyze({ content: PNG, mimeType: 'image/png', fileName: 'unknown.png' }).catch(() => undefined);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
