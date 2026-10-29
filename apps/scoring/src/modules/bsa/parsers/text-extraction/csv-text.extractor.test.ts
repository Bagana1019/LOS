import { describe, expect, it } from 'vitest';
import { detectCsvDelimiter, extractCsvText, parseCsv } from './csv-text.extractor';
import { TEXT_EXTRACTION_DEFAULTS } from './text-extraction.defaults';
import { encodeCp1251, encodeUtf16, utf8Bom } from './testing/encodings';

const O = TEXT_EXTRACTION_DEFAULTS.csv;
const extract = (s: string | Buffer, o = O) => extractCsvText(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'), o);
const cellsOf = (s: string | Buffer, o = O) => extract(s, o).lines.map((l) => l.cells);

describe('parseCsv (RFC 4180)', () => {
  it('хашилт, давхар хашилт, талбар доторх delimiter ба шинэ мөр', () => {
    const csv = 'a,"b,1","say ""hi""","line1\nline2",e\r\n1,2,3,4,5\n';
    expect(parseCsv(csv, ',')).toEqual([['a', 'b,1', 'say "hi"', 'line1\nline2', 'e'], ['1', '2', '3', '4', '5']]);
  });

  it('CRLF, CR, LF бүгд бичлэгийн төгсгөл; төгсгөлийн шинэ мөргүй ч сүүлийн бичлэг орно', () => {
    expect(parseCsv('a,b\r\nc,d\re,f\ng,h', ',')).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']]);
  });

  it('хоосон мөр = [""] бичлэг; хоосон нүд хадгалагдана; төгсгөлийн delimiter хоосон нүд өгнө', () => {
    expect(parseCsv('a,,c,\n\nx,y,z', ',')).toEqual([['a', '', 'c', ''], [''], ['x', 'y', 'z']]);
  });

  it('хаагдаагүй хашилт: файлын төгсгөл хүртэл талбар (throw хийхгүй)', () => {
    expect(parseCsv('a,"unterminated, still\nopen', ',')).toEqual([['a', 'unterminated, still\nopen']]);
  });

  it('хашилт зөвхөн талбарын эхэнд нээгдэнэ: дунд нь байвал энгийн тэмдэгт', () => {
    expect(parseCsv('5" pipe,ok\nab"c,d', ',')).toEqual([['5" pipe', 'ok'], ['ab"c', 'd']]);
  });

  it('хашилт хаасны дараах илүү тэмдэгт талбарт залгагдана (хайхрамжгүй)', () => {
    expect(parseCsv('"abc"def,x', ',')).toEqual([['abcdef', 'x']]);
  });

  it('maxRecords хязгаар', () => {
    expect(parseCsv('a\nb\nc\nd', ',', 2)).toEqual([['a'], ['b']]);
  });

  it('хоосон текст → []', () => {
    expect(parseCsv('', ',')).toEqual([]);
  });
});

describe('detectCsvDelimiter', () => {
  const D = { sniffRecords: 50, sniffMaxChars: 200_000 };
  const row = (d: string, i: number) => ['2026-03-0' + (i + 1), 'Transfer', '1000', '5000'].join(d);
  const table = (d: string) => [['Date', 'Desc', 'Amount', 'Balance'].join(d), ...Array.from({ length: 5 }, (_, i) => row(d, i))].join('\n');

  it.each([[','], [';'], ['\t'], ['|']])('%j-ээр тусгаарласан хүснэгт', (d) => {
    expect(detectCsvDelimiter(table(d), D)).toBe(d);
  });

  it("';'-тай файл дахь аравны таслал (1500000,50) ',' биш ';'-г сонгоно", () => {
    const t = 'Date;Desc;Amount\n2026-03-01;a;1500000,50\n2026-03-02;b;250,00\n2026-03-03;c;99,99';
    expect(detectCsvDelimiter(t, D)).toBe(';');
  });

  it("','-тай файл дахь хашилттай мянгатын таслал, тайлбар доторх ';'", () => {
    const t = 'Date,Desc,Amount\n2026-03-01,"a; b","1,500,000.50"\n2026-03-02,c,"250.00"\n2026-03-03,"d;e;f","99.99"';
    expect(detectCsvDelimiter(t, D)).toBe(',');
  });

  it('TAB-тай файл, тайлбарт таслал', () => {
    const t = 'Date\tDesc\tAmount\n2026-03-01\tPayment, ref 1\t100\n2026-03-02\tPayment, ref 2, x\t200';
    expect(detectCsvDelimiter(t, D)).toBe('\t');
  });

  it('урьдчилсан гарчигтай (1 талбартай мөрүүд) файл', () => {
    const t = 'Account statement\nPeriod: 2026-03\n\nDate;Desc;Amount\n2026-03-01;a;1\n2026-03-02;b;2';
    expect(detectCsvDelimiter(t, D)).toBe(';');
  });

  it('нэг багана / delimiter олдохгүй → ","', () => {
    expect(detectCsvDelimiter('one\ntwo\nthree', D)).toBe(',');
    expect(detectCsvDelimiter('', D)).toBe(',');
  });
});

describe('extractCsvText', () => {
  it('нүд, text (хоосон бус нүдийг нэг зайгаар), y = бичлэгийн дугаар; хоосон нүд хадгалагдана', () => {
    const r = extract('Date;Desc;Debit;Credit\n2026-03-01;Salary;;1500000.00\n');
    expect(r.delimiter).toBe(';');
    expect(r.lines).toEqual([
      { text: 'Date Desc Debit Credit', cells: ['Date', 'Desc', 'Debit', 'Credit'], y: 1 },
      { text: '2026-03-01 Salary 1500000.00', cells: ['2026-03-01', 'Salary', '', '1500000.00'], y: 2 },
    ]);
  });

  it('бүрэн хоосон бичлэгийг алгасна (хоосон мөр, ",,,", зөвхөн хоосон зай), y дугаарлалт тасрахгүй', () => {
    const r = extract('a,b\n\n,,\n   ,  \nc,d\n');
    expect(r.lines.map((l) => [l.cells, l.y])).toEqual([[['a', 'b'], 1], [['c', 'd'], 5]]);
  });

  it('нүдний хоосон зайг цэвэрлэнэ; хашилт доторх шинэ мөр нэг зай болно', () => {
    expect(cellsOf('a,b\n  x  , "multi\nline  desc" \n')).toEqual([['a', 'b'], ['x', 'multi line desc']]);
  });

  it('хашилттай талбарт мянгатын таслал: "1,500,000.00" бүтэн нүд', () => {
    expect(cellsOf('Date,Amount\n2026-03-01,"1,500,000.00"\n')[1]).toEqual(['2026-03-01', '1,500,000.00']);
  });

  it('UTF-8 BOM: эхний нүдэнд BOM үлдэхгүй', () => {
    const r = extract(utf8Bom('Огноо;Дүн\n2026-03-01;100\n'));
    expect(r.lines[0].cells).toEqual(['Огноо', 'Дүн']);
    expect(r.encoding).toBe('utf-8');
  });

  it('UTF-16LE / BE BOM (Excel "Unicode Text": TAB)', () => {
    const text = 'Огноо\tГүйлгээ\tДүн\n2026-03-01\tЦалин\t100\n';
    for (const endian of ['le', 'be'] as const) {
      const r = extract(encodeUtf16(text, endian));
      expect(r.encoding).toBe(`utf-16${endian}`);
      expect(r.delimiter).toBe('\t');
      expect(r.lines.map((l) => l.cells)).toEqual([['Огноо', 'Гүйлгээ', 'Дүн'], ['2026-03-01', 'Цалин', '100']]);
    }
  });

  it('windows-1251 (гараар кодлосон байт): кирилл, Ө/Ү', () => {
    const r = extract(encodeCp1251('Огноо;Гүйлгээний утга;Дүн\n2026-03-01;Өндөр үнэтэй худалдан авалт;100,50\n'));
    expect(r.encoding).toBe('windows-1251');
    expect(r.lines.map((l) => l.cells)).toEqual([['Огноо', 'Гүйлгээний утга', 'Дүн'], ['2026-03-01', 'Өндөр үнэтэй худалдан авалт', '100,50']]);
  });

  it('delimiter-ийг тохиргооноос албадах (auto-detect-ийг алгасна)', () => {
    expect(cellsOf('a;b|c\n1;2|3', { ...O, delimiter: '|' })).toEqual([['a;b', 'c'], ['1;2', '3']]);
    expect(extract('a;b;c\n1;2;3', { ...O, delimiter: ',' }).lines.map((l) => l.cells)).toEqual([['a;b;c'], ['1;2;3']]);
  });

  it('удирдлагын/zero-width тэмдэгт нүднээс хасагдана', () => {
    expect(cellsOf('a\u200b1,b\u00a02\n')).toEqual([['a1', 'b 2']]);
  });

  it('хоосон/зөвхөн хоосон бичлэгтэй файл → lines = []', () => {
    expect(extract('').lines).toEqual([]);
    expect(extract('\n\n  \n,,\n').lines).toEqual([]);
  });

  it('том файл: 20,000 мөр шугаман хугацаанд, нүд бүрэн', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `2026-03-01;Transfer ${i};${i}.00;${i * 2}.50`).join('\n');
    const r = extract(`Date;Desc;Amount;Balance\n${rows}\n`);
    expect(r.lines).toHaveLength(20_001);
    expect(r.lines[20_000].cells).toEqual(['2026-03-01', 'Transfer 19999', '19999.00', '39998.50']);
  });
});
