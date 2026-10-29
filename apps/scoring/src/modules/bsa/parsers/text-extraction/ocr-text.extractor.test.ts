// OCR → StatementText тест: гараар бүтээсэн OcrResult (300 dpi, 12pt ≈ үсгийн өргөн 24px, мөрийн өндөр 44px) + fake OcrProvider.
import { OcrError, type OcrBox, type OcrLine, type OcrPage, type OcrProvider, type OcrResult, type OcrWord } from '@los/ocr';
import { describe, expect, it, vi } from 'vitest';
import { StatementExtractionError } from './errors';
import { ocrResultToPages, recognizeStatementText, splitOcrLineCells } from './ocr-text.extractor';
import { TEXT_EXTRACTION_DEFAULTS } from './text-extraction.defaults';
import type { OcrTextOptions } from './types';

const O = TEXT_EXTRACTION_DEFAULTS.ocr;
const CW = 24; // үсгийн дундаж өргөн (px)
const LH = 44; // мөрийн өндөр (px)
const SPACE = 12; // үгийн завсрын зай (px)

const box = (x: number, y: number, width: number, height = LH): OcrBox => ({ x, y, width, height });
const word = (text: string, x: number, y = 100): OcrWord => ({ text, confidence: 0.95, box: box(x, y, text.length * CW) });

/** Үгсийг зүүнээс баруун, үг хоорондын зай нь gaps[i] (px) */
function lineOf(texts: string[], gaps: number[], x0 = 100, y = 100): OcrLine {
  let x = x0;
  const words = texts.map((t, i) => {
    const w = word(t, x, y);
    x += t.length * CW + (gaps[i] ?? 0);
    return w;
  });
  const last = words[words.length - 1];
  return { text: texts.join(' '), confidence: 0.93, box: box(x0, y, last.box.x + last.box.width - x0), words };
}

const pageOf = (lines: OcrLine[], pageNo = 1): OcrPage => ({ pageNo, width: 2480, height: 3508, text: lines.map((l) => l.text).join('\n'), lines, meanConfidence: 0.9 });
const resultOf = (pages: OcrPage[], extra: Partial<OcrResult> = {}): OcrResult => ({
  engine: 'fake-ocr', engineVersion: '1', languages: ['mon', 'eng'], pages, text: pages.map((p) => p.text).join('\n\f'), meanConfidence: 0.88, durationMs: 5, ...extra,
});
const providerOf = (impl: OcrProvider['recognize']): OcrProvider & { recognize: ReturnType<typeof vi.fn> } => ({ name: 'fake', recognize: vi.fn(impl) });

describe('splitOcrLineCells', () => {
  it('5 үг, хоорондоо өргөн зайтай → 5 нүд', () => {
    const line = lineOf(['2026-03-01', 'Salary', '1,500,000.00', '0.00', '2,300,000.00'], [SPACE * 6, SPACE * 8, SPACE * 5, SPACE * 7]);
    expect(splitOcrLineCells(line, O)).toEqual(['2026-03-01', 'Salary', '1,500,000.00', '0.00', '2,300,000.00']);
  });

  it('энгийн өгүүлбэр (үг хоорондын зай ≈ 0.5 үсэг) → 1 нүд', () => {
    const line = lineOf(['Salary', 'payment', 'for', 'march', '2026'], [SPACE, SPACE, SPACE, SPACE]);
    expect(splitOcrLineCells(line, O)).toEqual(['Salary payment for march 2026']);
  });

  it('олон үгтэй нүд: тайлбар (3 үг) нэг нүд, дүн тусдаа', () => {
    const line = lineOf(['2026-03-02', 'Shop', 'purchase', 'downtown', '45,900.00'], [SPACE * 6, SPACE, SPACE, SPACE * 6]);
    expect(splitOcrLineCells(line, O)).toEqual(['2026-03-02', 'Shop purchase downtown', '45,900.00']);
  });

  it('хил: зай босгоос арай бага → нэг нүд; арай их → хоёр нүд (босго = cellGapCharWidths × үсгийн өргөн)', () => {
    const threshold = Math.max(O.cellGapCharWidths * CW, O.cellGapLineHeights * LH);
    expect(splitOcrLineCells(lineOf(['aaaa', 'bbbb'], [threshold - 0.5]), O)).toEqual(['aaaa bbbb']);
    expect(splitOcrLineCells(lineOf(['aaaa', 'bbbb'], [threshold + 0.5]), O)).toEqual(['aaaa', 'bbbb']);
  });

  it('босго мөрийн үсгийн өргөнөөр дасна: том үсэгтэй мөр (үсэг 48px) 40px зайг нэг нүд гэж үзнэ', () => {
    const big = (t: string, x: number): OcrWord => ({ text: t, confidence: 0.9, box: box(x, 100, t.length * 48, 88) });
    const line: OcrLine = { text: 'big text', confidence: 0.9, box: box(100, 100, 500, 88), words: [big('big', 100), big('text', 100 + 144 + 40)] };
    expect(splitOcrLineCells(line, O)).toEqual(['big text']);
    const small = (t: string, x: number): OcrWord => ({ text: t, confidence: 0.9, box: box(x, 100, t.length * 12, 22) });
    const line2: OcrLine = { text: 'tiny text', confidence: 0.9, box: box(100, 100, 300, 22), words: [small('tiny', 100), small('text', 100 + 48 + 40)] };
    expect(splitOcrLineCells(line2, O)).toEqual(['tiny', 'text']);
  });

  it('хүснэгтийн босоо шугам "|" нүдний хил болж, текстэд орохгүй', () => {
    const line = lineOf(['2026-03-01', '|', 'Salary', '|', '1,500,000.00'], [SPACE, SPACE, SPACE, SPACE]);
    expect(splitOcrLineCells(line, O)).toEqual(['2026-03-01', 'Salary', '1,500,000.00']);
  });

  it('үгийн хайрцаг байхгүй мөр → [line.text]; хоосон мөр → []', () => {
    const base = { confidence: 0.9, box: box(0, 0, 400) };
    expect(splitOcrLineCells({ ...base, text: '  Opening   balance 1,000.00 ', words: [] }, O)).toEqual(['Opening balance 1,000.00']);
    expect(splitOcrLineCells({ ...base, text: '   ', words: [] }, O)).toEqual([]);
  });

  it('геометр огт байхгүй (өргөн 0) → таслахгүй, нэг нүд', () => {
    const z = (t: string, x: number): OcrWord => ({ text: t, confidence: 0.9, box: box(x, 0, 0, 0) });
    const line: OcrLine = { text: 'a b', confidence: 0.9, box: box(0, 0, 0, 0), words: [z('a', 0), z('b', 500)] };
    expect(splitOcrLineCells(line, O)).toEqual(['a b']);
  });

  it('үгс эмх замбараагүй ирсэн ч x-ээр эрэмбэлнэ; хоосон үгийг алгасна', () => {
    const line = lineOf(['first', 'second'], [SPACE * 8]);
    line.words = [{ ...word('', 50) }, line.words[1], line.words[0]];
    expect(splitOcrLineCells(line, O)).toEqual(['first', 'second']);
  });

  it('кирилл үгийн өргөнийг кодын цэгээр тооцно (UTF-16 хос тэмдэгтээр биш)', () => {
    const line = lineOf(['Гүйлгээний', 'утга', '45,900.00'], [SPACE, SPACE * 7]);
    expect(splitOcrLineCells(line, O)).toEqual(['Гүйлгээний утга', '45,900.00']);
  });
});

describe('ocrResultToPages', () => {
  it('хуудас, мөр, y (хайрцгийн дээд), text = нүднүүдийн нэг зай; хоосон мөр алгасагдана', () => {
    const r = resultOf([
      pageOf([
        lineOf(['Date', 'Desc', 'Amount'], [SPACE * 6, SPACE * 6], 100, 100),
        { text: '', confidence: 0, box: box(0, 150, 0), words: [] },
        lineOf(['2026-03-01', 'Salary', '1,000.00'], [SPACE * 6, SPACE * 6], 100, 200),
      ]),
      pageOf([lineOf(['Page', 'two', 'text'], [SPACE, SPACE], 100, 120)], 2),
    ]);
    const pages = ocrResultToPages(r, O);
    expect(pages.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(pages[0].lines).toEqual([
      { text: 'Date Desc Amount', cells: ['Date', 'Desc', 'Amount'], y: 100 },
      { text: '2026-03-01 Salary 1,000.00', cells: ['2026-03-01', 'Salary', '1,000.00'], y: 200 },
    ]);
    expect(pages[1].lines[0]).toEqual({ text: 'Page two text', cells: ['Page two text'], y: 120 });
  });

  it('мөрийн дарааллыг провайдераас авсан хэвээр хадгална', () => {
    const r = resultOf([pageOf([lineOf(['second'], [], 100, 300), lineOf(['first'], [], 100, 100)])]);
    expect(ocrResultToPages(r, O)[0].lines.map((l) => l.text)).toEqual(['second', 'first']);
  });
});

describe('recognizeStatementText', () => {
  const content = Buffer.from('fake image bytes');
  const okResult = resultOf([pageOf([lineOf(['2026-03-01', 'Salary', '1,000.00'], [SPACE * 6, SPACE * 6])])]);
  const run = (provider: OcrProvider | undefined, options: Partial<OcrTextOptions> = {}, mimeType = 'image/png') =>
    recognizeStatementText(provider, { content, mimeType }, { ...O, ...options });

  it('амжилт: pages + meta.ocr {engine, meanConfidence}; provider-т агуулга, каноник mime, хэл л дамжина (файлын нэргүй)', async () => {
    const provider = providerOf(async () => okResult);
    const r = await run(provider, { languages: ['mon'] });
    expect(r.ocr).toEqual({ engine: 'fake-ocr', meanConfidence: 0.88 });
    expect(r.pages[0].lines[0].cells).toEqual(['2026-03-01', 'Salary', '1,000.00']);
    expect(provider.recognize).toHaveBeenCalledTimes(1);
    expect(provider.recognize).toHaveBeenCalledWith({ content, mimeType: 'image/png', languages: ['mon'] });
  });

  it('хэл заагаагүй бол languages түлхүүр огт дамжихгүй (provider-ийн анхдагч)', async () => {
    const provider = providerOf(async () => okResult);
    await run(provider);
    expect(Object.keys(provider.recognize.mock.calls[0][0]).sort()).toEqual(['content', 'mimeType']);
  });

  it('provider байхгүй → OCR_FAILED', async () => {
    const err = await run(undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatementExtractionError);
    expect(err).toMatchObject({ code: 'OCR_FAILED', detail: 'OCR_PROVIDER_MISSING' });
  });

  it('OcrError → OCR_FAILED; мессеж/текст дамжихгүй, зөвхөн код шошго', async () => {
    const provider = providerOf(async () => {
      throw new OcrError('ENGINE_UNAVAILABLE', 'secret text 2026-03-01 Өлзий');
    });
    const err = (await run(provider).catch((e: unknown) => e)) as StatementExtractionError;
    expect(err.code).toBe('OCR_FAILED');
    expect(err.detail).toBe('OcrError:ENGINE_UNAVAILABLE');
    expect(`${err.message} ${err.detail}`).not.toMatch(/secret|2026|Өлзий/);
  });

  it('ердийн Error (код байхгүй) → OCR_FAILED, шошго = нэр', async () => {
    const provider = providerOf(async () => {
      throw new TypeError('boom');
    });
    await expect(run(provider)).rejects.toMatchObject({ code: 'OCR_FAILED', detail: 'TypeError' });
  });

  it('хоосон үр дүн (мөр байхгүй) → OCR_FAILED', async () => {
    const provider = providerOf(async () => resultOf([pageOf([])]));
    await expect(run(provider)).rejects.toMatchObject({ code: 'OCR_FAILED', detail: 'EMPTY_TEXT' });
  });

  it('OcrResult.warnings (хуудас таслагдсан): rejectOnWarnings үед OCR_FAILED, унтраавал хүлээн авна', async () => {
    const provider = providerOf(async () => ({ ...okResult, warnings: ['PDF 20-оос олон хуудастай: эхний 20 хуудсыг л уншсан'] }));
    await expect(run(provider, { rejectOnWarnings: true }, 'application/pdf')).rejects.toMatchObject({
      code: 'OCR_FAILED',
      detail: 'OCR_INCOMPLETE',
    });
    await expect(run(provider, { rejectOnWarnings: false }, 'application/pdf')).resolves.toMatchObject({ ocr: { engine: 'fake-ocr' } });
  });

  it('хоосон warnings массив хүлээн авна', async () => {
    const provider = providerOf(async () => ({ ...okResult, warnings: [] }));
    await expect(run(provider)).resolves.toBeDefined();
  });
});
