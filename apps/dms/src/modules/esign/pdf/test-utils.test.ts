import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { mm } from './format';
import { extractTextRuns, pageText } from './pdf-inspect';
import { A4_SIZE, createSamplePdf, SAMPLE_CONTRACT_NO, type SamplePageSize } from './test-utils';

describe('createSamplePdf', () => {
  it('анхдагчаар A4 хэмжээтэй 3 хуудас, гэрээний гарчигтай жинхэнэ PDF', async () => {
    const bytes = await createSamplePdf();
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    for (const page of doc.getPages()) {
      expect(page.getSize().width).toBeCloseTo(A4_SIZE[0], 2);
      expect(page.getSize().height).toBeCloseTo(A4_SIZE[1], 2);
      expect(page.getRotation().angle).toBe(0);
    }
    expect(doc.getTitle()).toContain(SAMPLE_CONTRACT_NO);
  });

  it('pages, size, rotation тохиргоог барина', async () => {
    const doc = await PDFDocument.load(await createSamplePdf({ pages: 5, size: [300, 500], rotation: 270 }));
    expect(doc.getPageCount()).toBe(5);
    for (const page of doc.getPages()) {
      expect(page.getSize()).toEqual({ width: 300, height: 500 });
      expect(page.getRotation().angle).toBe(270);
    }
  });

  it('size: [өргөн, өндөр], { width, height }, нэрлэсэн хэмжээ (A3/A4/A5/LETTER); буруу хэмжээ → RangeError', async () => {
    const sizeOf = async (size: SamplePageSize) => (await PDFDocument.load(await createSamplePdf({ pages: 1, size }))).getPage(0).getSize();
    expect(await sizeOf([300, 400])).toEqual({ width: 300, height: 400 });
    expect(await sizeOf({ width: 310, height: 410 })).toEqual({ width: 310, height: 410 });
    expect(await sizeOf('LETTER')).toEqual({ width: 612, height: 792 });
    expect((await sizeOf('A5')).width).toBeCloseTo(419.53, 2);
    expect((await sizeOf('A3')).height).toBeCloseTo(1190.55, 2);
    await expect(createSamplePdf({ size: [0, 100] })).rejects.toThrow(RangeError);
    await expect(createSamplePdf({ size: [100, Number.NaN] })).rejects.toThrow(RangeError);
  });

  it('кирилл (Ө ө Ү ү) текст агуулж, хуудас бүр хөлтэй, 1-р хуудас гарчигтай', async () => {
    const doc = await PDFDocument.load(await createSamplePdf({ pages: 2 }));
    const [first, second] = doc.getPages().map((page) => pageText(doc, page));
    expect(first[0]).toBe(`ЗЭЭЛИЙН ГЭРЭЭ № ${SAMPLE_CONTRACT_NO}`);
    expect(first.at(-1)).toBe('Хуудас 1 / 2');
    expect(second.at(-1)).toBe('Хуудас 2 / 2');
    const body = [...first, ...second].join(' ');
    for (const ch of 'ӨөҮү') expect(body).toContain(ch);
  });

  it('deterministic: ижил оролт → ижил bytes', async () => {
    expect((await createSamplePdf({ pages: 2 })).equals(await createSamplePdf({ pages: 2 }))).toBe(true);
    expect((await createSamplePdf({ pages: 2 })).equals(await createSamplePdf({ pages: 3 }))).toBe(false);
  });

  it('баруун доод булан (штампын газар) болон хуудасны захад текст орохгүй', async () => {
    const [width] = A4_SIZE;
    const doc = await PDFDocument.load(await createSamplePdf({ pages: 3 }));
    for (const page of doc.getPages()) {
      for (const run of extractTextRuns(doc, page)) {
        const [x, y] = run.origin;
        expect(x >= width - mm(45) && y <= mm(45) && !run.text.startsWith('Хуудас')).toBe(false);
        expect(x).toBeGreaterThanOrEqual(mm(15));
        expect(y).toBeGreaterThan(0);
      }
    }
  });

  it('хуудас бүр дүүрнэ: дунджаар 1-р хуудсанд ≥ 8 догол мөр', async () => {
    const doc = await PDFDocument.load(await createSamplePdf({ pages: 1 }));
    const numbered = pageText(doc, doc.getPage(0)).filter((text) => /^\d+\.$/.test(text));
    expect(numbered.length).toBeGreaterThanOrEqual(8);
  });

  it('буруу pages → RangeError', async () => {
    await expect(createSamplePdf({ pages: 0 })).rejects.toThrow(RangeError);
    await expect(createSamplePdf({ pages: 1.5 })).rejects.toThrow(RangeError);
  });
});
