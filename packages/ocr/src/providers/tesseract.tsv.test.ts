import { describe, expect, it } from 'vitest';
import { parseTesseractTsv } from './tesseract.tsv';

const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const row = (...c: Array<string | number>) => c.join('\t');

// Гар бичмэл жишиг: 1 хуудас, 2 мөр. Мөр бүр level-4; үг бүр level-5. conf -1 мөрүүд текстгүй.
const SAMPLE = [
  HEADER,
  row(1, 1, 0, 0, 0, 0, 0, 0, 1800, 1180, -1, ''),
  row(2, 1, 1, 0, 0, 0, 90, 60, 900, 200, -1, ''),
  row(3, 1, 1, 1, 0, 0, 90, 60, 900, 200, -1, ''),
  row(4, 1, 1, 1, 1, 0, 90, 60, 900, 50, -1, ''),
  row(5, 1, 1, 1, 1, 1, 90, 60, 300, 50, 96.5, 'Овог'),
  row(5, 1, 1, 1, 1, 2, 420, 62, 100, 48, 91.25, 'Дорж'),
  row(4, 1, 1, 1, 2, 0, 90, 140, 700, 50, -1, ''),
  row(5, 1, 1, 1, 2, 1, 90, 140, 200, 50, 88, 'Регистр'),
  row(5, 1, 1, 1, 2, 2, 320, 140, 330, 50, 70, 'ЖЮ85061512'),
  '',
].join('\n');

describe('parseTesseractTsv', () => {
  it('хуудасны хэмжээг level-1-ээс, мөр/үгийн хайрцаг ба итгэлийг (conf/100) задлана', () => {
    const pages = parseTesseractTsv(SAMPLE);
    expect(pages).toHaveLength(1);
    const p = pages[0];
    expect([p.pageNo, p.width, p.height]).toEqual([1, 1800, 1180]);
    expect(p.lines.map((l) => l.text)).toEqual(['Овог Дорж', 'Регистр ЖЮ85061512']);
    expect(p.text).toBe('Овог Дорж\nРегистр ЖЮ85061512');
    expect(p.lines[0].box).toEqual({ x: 90, y: 60, width: 900, height: 50 });
    expect(p.lines[0].words[1]).toEqual({ text: 'Дорж', confidence: 0.9125, box: { x: 420, y: 62, width: 100, height: 48 } });
    expect(p.lines[0].confidence).toBeCloseTo((0.965 + 0.9125) / 2, 10);
    expect(p.meanConfidence).toBeCloseTo((0.965 + 0.9125 + 0.88 + 0.7) / 4, 10);
  });

  it('conf -1 үг (текстгүй), хоосон/зөвхөн зайтай текст, 0 итгэлтэй хоосон үгийг алгасна; мөр нь үггүй бол орохгүй', () => {
    const tsv = [
      HEADER,
      row(1, 1, 0, 0, 0, 0, 0, 0, 100, 100, -1, ''),
      row(4, 1, 1, 1, 1, 0, 0, 0, 100, 20, -1, ''),
      row(5, 1, 1, 1, 1, 1, 0, 0, 50, 20, -1, 'алгас'),
      row(5, 1, 1, 1, 1, 2, 60, 0, 30, 20, 80, '   '),
      row(4, 1, 1, 1, 2, 0, 0, 30, 100, 20, -1, ''),
      row(5, 1, 1, 1, 2, 1, 0, 30, 40, 20, 0, 'тэг'),
    ].join('\n');
    const [p] = parseTesseractTsv(tsv);
    expect(p.lines.map((l) => l.text)).toEqual(['тэг']);
    expect(p.lines[0].words[0].confidence).toBe(0);
  });

  it('эвдэрсэн мөр: багана дутуу, тоо биш талбар → алгасна; CRLF тэвчнэ; текст дотор TAB байвал залгана', () => {
    const tsv = [HEADER, 'гэмтсэн мөр', row('x', 1, 1, 1, 1, 1, 0, 0, 1, 1, 90, 'буруу'), row(5, 1, 1, 1, 1, 1, 0, 0, 10, 10, 90, 'а\tб'), row(5, 1, 1, 1, 1, 2, 20, 0, 10, 10, 90, 'в')].join('\r\n');
    const [p] = parseTesseractTsv(tsv);
    expect(p.lines[0].words.map((w) => w.text)).toEqual(['а\tб', 'в']);
  });

  it('level-4 мөргүй үгийг мөр болгож, хайрцгийг нэгтгэнэ; хуудасны хэмжээ level-1-гүй бол хайрцгаас', () => {
    const tsv = [HEADER, row(5, 1, 1, 1, 1, 1, 10, 20, 30, 10, 90, 'а'), row(5, 1, 1, 1, 1, 2, 50, 22, 40, 12, 90, 'б')].join('\n');
    const [p] = parseTesseractTsv(tsv);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].box).toEqual({ x: 10, y: 20, width: 80, height: 14 });
    expect([p.width, p.height]).toEqual([90, 34]);
  });

  it('олон хуудас (page_num), page_num-аар эрэмбэлнэ; итгэл [0,1]-д хавчигдана', () => {
    const tsv = [
      HEADER,
      row(5, 2, 1, 1, 1, 1, 0, 0, 10, 10, 150, 'хоёр'),
      row(5, 1, 1, 1, 1, 1, 0, 0, 10, 10, 90, 'нэг'),
    ].join('\n');
    const pages = parseTesseractTsv(tsv);
    expect(pages.map((p) => [p.pageNo, p.text])).toEqual([[1, 'нэг'], [2, 'хоёр']]);
    expect(pages[1].lines[0].words[0].confidence).toBe(1);
  });

  it('хоосон/зөвхөн толгой оролт → хоосон жагсаалт', () => {
    expect(parseTesseractTsv('')).toEqual([]);
    expect(parseTesseractTsv(`${HEADER}\n`)).toEqual([]);
  });

  it('текстгүй хуудас үлдэнэ (lines: [], meanConfidence 0)', () => {
    const [p] = parseTesseractTsv([HEADER, row(1, 1, 0, 0, 0, 0, 0, 0, 640, 480, -1, '')].join('\n'));
    expect(p).toMatchObject({ pageNo: 1, width: 640, height: 480, text: '', lines: [], meanConfidence: 0 });
  });
});
