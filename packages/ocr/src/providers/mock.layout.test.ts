import { describe, expect, it } from 'vitest';
import { layoutTextToPages, MOCK_LAYOUT_DEFAULTS } from './mock.layout';
import { assembleOcrResult, ocrResultFromText } from './result';

const L = MOCK_LAYOUT_DEFAULTS;

describe('layoutTextToPages', () => {
  it('мөр бүрийн y нэмэгдэнэ (хоосон мөр ч зай эзэлнэ), мөрийн текст = үгсийг ганц зайгаар залгасан', () => {
    const [page] = layoutTextToPages('Нэг мөр\n\nГурав дахь   мөр');
    expect(page.lines.map((l) => l.text)).toEqual(['Нэг мөр', 'Гурав дахь мөр']);
    const [a, b] = page.lines;
    expect(b.box.y - a.box.y).toBe(2 * (L.lineHeight + L.lineGap));
    expect(a.box.y).toBe(L.marginY);
    expect(page.text).toBe('Нэг мөр\nГурав дахь мөр');
  });

  it('x нь тэмдэгтийн offset × charWidth; нэг зай = 1 багана', () => {
    const [page] = layoutTextToPages('аб вг');
    const [w1, w2] = page.lines[0].words;
    expect(w1.box.x).toBe(L.marginX);
    expect(w1.box.width).toBe(2 * L.charWidth);
    expect(w2.box.x).toBe(L.marginX + 3 * L.charWidth);
  });

  it('TAB болон 2+ зай нь дор хаяж columnGapCols өргөн цоорхой үүсгэнэ, нэг зайнаас илт өргөн', () => {
    const gap = (text: string) => {
      const [w1, w2] = layoutTextToPages(text)[0].lines[0].words;
      return w2.box.x - (w1.box.x + w1.box.width);
    };
    const single = gap('abcdefg hij');
    expect(single).toBe(L.charWidth);
    expect(gap('abcdefg\thij')).toBeGreaterThanOrEqual(L.columnGapCols * L.charWidth);
    expect(gap('abcdefg  hij')).toBeGreaterThanOrEqual(L.columnGapCols * L.charWidth);
    expect(gap('abcdefg  hij')).toBeGreaterThan(single * 2);
  });

  it('TAB зогсоол 8 баганаар тэгшилнэ (хүснэгтийн багана босоо чиглэлд таарна)', () => {
    const [page] = layoutTextToPages('Огноо\tУтга\n2026.03.01\tЦалин');
    const [r1, r2] = page.lines;
    // 1-р мөр: 5 тэмдэгт + tab → 8; 2-р мөр: 10 тэмдэгт + tab → 16. Хоёр багана өөр зогсоолд тул х ялгаатай, гэхдээ тус бүр 8-ын үржвэр
    expect((r1.words[1].box.x - L.marginX) / L.charWidth).toBe(8);
    expect((r2.words[1].box.x - L.marginX) / L.charWidth).toBe(16);
  });

  it('итгэл: тогтмол тоо ба функц; 0..1-д хавчина', () => {
    const fixed = layoutTextToPages('аа бб', 0.5)[0];
    expect(fixed.lines[0].words.map((w) => w.confidence)).toEqual([0.5, 0.5]);
    expect(fixed.meanConfidence).toBe(0.5);
    const fn = layoutTextToPages('аа бб', (w) => (w === 'аа' ? 2 : -1))[0];
    expect(fn.lines[0].words.map((w) => w.confidence)).toEqual([1, 0]);
    expect(fn.lines[0].confidence).toBe(0.5);
  });

  it("'\\f' хуудас салгана, төгсгөлийн хоосон хуудсыг хасна, хоосон текст ганц хоосон хуудас", () => {
    const pages = layoutTextToPages('нэг\n\fхоёр\n\f');
    expect(pages.map((p) => [p.pageNo, p.text])).toEqual([[1, 'нэг'], [2, 'хоёр']]);
    const empty = layoutTextToPages('');
    expect(empty).toHaveLength(1);
    expect(empty[0].lines).toHaveLength(0);
    expect(empty[0].meanConfidence).toBe(0);
  });

  it('deterministic: ижил оролт = яг ижил гаралт', () => {
    const t = 'Огноо\tУтга\tДүн\n2026.03.01\tЦалин\t1,800,000.00';
    expect(layoutTextToPages(t)).toEqual(layoutTextToPages(t));
  });

  it('NBSP зайг үг салгагч гэж үзнэ; кирилл тэмдэгтийг 1 багана гэж тоолно (surrogate pair-д ч)', () => {
    const [page] = layoutTextToPages('аб вг 😀x');
    expect(page.lines[0].words.map((w) => w.text)).toEqual(['аб', 'вг', '😀x']);
    expect(page.lines[0].words[2].box.width).toBe(2 * L.charWidth);
  });

  it('CRLF мөр таслалтыг тэвчнэ', () => {
    expect(layoutTextToPages('а\r\nб')[0].lines.map((l) => l.text)).toEqual(['а', 'б']);
  });
});

describe('assembleOcrResult / ocrResultFromText', () => {
  it("текст '\\n\\f'-ээр, meanConfidence = бүх үгийн дундаж, warnings зөвхөн байвал", () => {
    const pages = layoutTextToPages('нэг хоёр\fгурав', (w) => (w === 'гурав' ? 0.4 : 1));
    const r = assembleOcrResult(pages, { engine: 'x', engineVersion: '1', languages: ['mon'], durationMs: 5 });
    expect(r.text).toBe('нэг хоёр\n\fгурав');
    expect(r.meanConfidence).toBeCloseTo((1 + 1 + 0.4) / 3, 10);
    expect(r.warnings).toBeUndefined();
    expect(assembleOcrResult(pages, { engine: 'x', engineVersion: null, languages: [], durationMs: 0, warnings: ['w'] }).warnings).toEqual(['w']);
  });

  it('үггүй үед meanConfidence 0', () => {
    expect(ocrResultFromText('').meanConfidence).toBe(0);
  });
});
