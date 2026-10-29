import { describe, expect, it } from 'vitest';
import { extractPlainText, splitPlainTextCells } from './plain-text.extractor';
import { TEXT_EXTRACTION_DEFAULTS } from './text-extraction.defaults';
import { encodeCp1251, encodeUtf16, utf8Bom } from './testing/encodings';

const O = TEXT_EXTRACTION_DEFAULTS.csv;
const extract = (s: string | Buffer) => extractPlainText(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'), O);

describe('splitPlainTextCells', () => {
  it('TAB эсвэл ≥ 2 зай = нүдний хил; 1 зай нүд таслахгүй', () => {
    expect(splitPlainTextCells('2026-03-01  Salary payment   1,500,000.00')).toEqual(['2026-03-01', 'Salary payment', '1,500,000.00']);
    expect(splitPlainTextCells('2026-03-01\tSalary payment\t1,500,000.00')).toEqual(['2026-03-01', 'Salary payment', '1,500,000.00']);
    expect(splitPlainTextCells('Salary payment for march')).toEqual(['Salary payment for march']);
  });

  it('TAB + зай холимог, дараалсан TAB нэг тусгаарлагч (хоосон нүд үүсэхгүй)', () => {
    expect(splitPlainTextCells('a \t b\t\tc  \t  d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('NBSP зай болно; эхэн/төгсгөлийн хоосон зай хасагдана; хоосон мөр → []', () => {
    expect(splitPlainTextCells('  a\u00a0\u00a0b  ')).toEqual(['a', 'b']);
    expect(splitPlainTextCells('   \t  ')).toEqual([]);
    expect(splitPlainTextCells('')).toEqual([]);
  });
});

describe('extractPlainText', () => {
  it('мөр бүр line: cells, text (нэг зайгаар), y = мөрийн дугаар; хоосон мөр алгасагдана', () => {
    const pages = extract('Statement of account\n\n2026-03-01   Salary   1,500,000.00\r\n\r\n2026-03-02\tShop\t45,900.00\n');
    expect(pages).toEqual([
      {
        pageNo: 1,
        lines: [
          { text: 'Statement of account', cells: ['Statement of account'], y: 1 },
          { text: '2026-03-01 Salary 1,500,000.00', cells: ['2026-03-01', 'Salary', '1,500,000.00'], y: 3 },
          { text: '2026-03-02 Shop 45,900.00', cells: ['2026-03-02', 'Shop', '45,900.00'], y: 5 },
        ],
      },
    ]);
  });

  it('form feed = хуудасны таслал; хуудас бүрт мөрийн дугаар шинээр', () => {
    const pages = extract('p1 line 1\np1 line 2\fp2  a  b\n');
    expect(pages.map((p) => [p.pageNo, p.lines.map((l) => l.cells)])).toEqual([[1, [['p1 line 1'], ['p1 line 2']]], [2, [['p2', 'a', 'b']]]]);
    expect(pages[1].lines[0].y).toBe(1);
  });

  it('CR, LF, CRLF мөрийн төгсгөл', () => {
    expect(extract('a\rb\nc\r\nd')[0].lines.map((l) => l.text)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('кодчилол: UTF-8 BOM, UTF-16LE, windows-1251', () => {
    const text = 'Огноо  Гүйлгээ  Дүн\n2026-03-01  Цалин  100';
    const expected = [['Огноо', 'Гүйлгээ', 'Дүн'], ['2026-03-01', 'Цалин', '100']];
    for (const buf of [utf8Bom(text), encodeUtf16(text, 'le'), encodeCp1251(text)]) {
      expect(extract(buf)[0].lines.map((l) => l.cells)).toEqual(expected);
    }
  });

  it('зөвхөн хоосон зай/хоосон мөр → pages = []', () => {
    expect(extract('')).toEqual([]);
    expect(extract('  \n\t\n\f \n')).toEqual([]);
  });

  it('хуудас дундаа хоосон: хоосон хуудас pageNo-г хадгалж үлдэнэ', () => {
    const pages = extract('a\f\fb');
    expect(pages.map((p) => [p.pageNo, p.lines.length])).toEqual([[1, 1], [2, 0], [3, 1]]);
  });
});
