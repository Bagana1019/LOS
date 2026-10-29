import { describe, expect, it } from 'vitest';
import { layoutPdfItems, type PdfTextItem } from './pdf-layout';
import { TEXT_EXTRACTION_DEFAULTS } from './text-extraction.defaults';

const O = TEXT_EXTRACTION_DEFAULTS.pdf;
const H = 10; // үсгийн өндөр
const CW = 5; // тэмдэгтийн өргөн (моноширин загвар)

/** Тэмдэгт тутамд CW өргөнтэй item */
const item = (str: string, x: number, y: number, extra: Partial<PdfTextItem> = {}): PdfTextItem => ({
  str, x, y, width: str.length * CW, height: H, upright: true, ...extra,
});
const cells = (items: PdfTextItem[], opts = O) => layoutPdfItems(items, opts).map((l) => l.cells);

describe('layoutPdfItems: мөр', () => {
  it('ижил baseline-тай item-үүд нэг мөр; мөрүүд дээрээс доош, мөр доторх нүд зүүнээс баруун (оролтын дараалал хамаагүй)', () => {
    const lines = layoutPdfItems(
      [item('B2', 200, 40), item('A2', 20, 40), item('B1', 200, 20), item('A1', 20, 20)],
      O,
    );
    expect(lines.map((l) => l.cells)).toEqual([['A1', 'B1'], ['A2', 'B2']]);
    expect(lines.map((l) => l.text)).toEqual(['A1 B1', 'A2 B2']);
    expect(lines.map((l) => l.y)).toEqual([20, 40]);
  });

  it('baseline-ийн жижиг зөрүү (үсгийн өндрийн 30%) нэг мөр; 60% бол тусдаа мөр', () => {
    expect(cells([item('Date', 20, 100), item('Amount', 200, 103)])).toEqual([['Date', 'Amount']]);
    expect(cells([item('Date', 20, 100), item('Amount', 200, 106)])).toEqual([['Date'], ['Amount']]);
  });

  it('хүлцэл үсгийн өндөртэй пропорциональ: том үсэгтэй мөрийн зөрүү 12 нь нэг мөр, жижигт тусдаа', () => {
    const big = (s: string, x: number, y: number) => item(s, x, y, { height: 40 });
    expect(cells([big('A', 20, 100), big('B', 200, 112)])).toEqual([['A', 'B']]);
    const small = (s: string, x: number, y: number) => item(s, x, y, { height: 6 });
    expect(cells([small('A', 20, 100), small('B', 200, 112)])).toEqual([['A'], ['B']]);
  });

  it('дараалсан мөрүүд гинжин байдлаар нэгдэхгүй: мөрийн дундаж y-тай харьцуулна', () => {
    // y = 0, 4, 8, 12; өндөр 10 → хүлцэл 5. Гинж бол нэг мөр болох байсан; дундажтай харьцуулбал [a,b] [c,d]
    expect(cells([item('a', 10, 0), item('b', 100, 4), item('c', 200, 8), item('d', 300, 12)])).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('шилжсэн тайлбарын 2-р мөр (зөвхөн тайлбарын баганад) тусдаа мөр болж, мөрийн дараа орно', () => {
    const out = cells([
      item('2026-03-05', 20, 100), item('Payment for services', 100, 100), item('37,750.00', 300, 100),
      item('under agreement 17', 100, 110),
      item('2026-03-06', 20, 124), item('Transfer', 100, 124), item('750,000.00', 300, 124),
    ]);
    expect(out).toEqual([
      ['2026-03-05', 'Payment for services', '37,750.00'],
      ['under agreement 17'],
      ['2026-03-06', 'Transfer', '750,000.00'],
    ]);
  });

  it('хоосон/зөвхөн хоосон зайтай/NaN item-г үл тооно; хоосон оролт → []', () => {
    expect(layoutPdfItems([], O)).toEqual([]);
    expect(cells([item(' ', 5, 5), item('', 9, 5), item('x', Number.NaN, 5), item('Ok', 20, 5)])).toEqual([['Ok']]);
  });
});

describe('layoutPdfItems: нүд', () => {
  it('зай > cellGapRatio×h бол шинэ нүд; үгийн завсрын зайд нэг зай; залгагдсан үсгийг залгана', () => {
    const out = cells([
      item('Trans', 20, 50), item('fer', 20 + 5 * CW + 0.5, 50), // 0.5 ≤ 0.15·10 → "Transfer"
      item('ref', 20 + 8 * CW + 0.5 + 3, 50), // 3 > 1.5 → зай орно
      item('1,234.50', 200, 50), // том зай → шинэ нүд
    ]);
    expect(out).toEqual([['Transfer ref', '1,234.50']]);
  });

  it('хил: зай яг cellGapRatio×h бол нэг нүд, түүнээс арай их бол хоёр нүд', () => {
    const gap = O.cellGapRatio * H;
    expect(cells([item('AA', 0, 0), item('BB', 2 * CW + gap, 0)])).toEqual([['AA BB']]);
    expect(cells([item('AA', 0, 0), item('BB', 2 * CW + gap + 0.1, 0)])).toEqual([['AA', 'BB']]);
  });

  it('item-ийн төгсгөлийн зай (trailing space) нүдийн хилийг далдлахгүй: зайг харагдах төгсгөлөөс хэмжинэ', () => {
    // "Date " өргөн 5·CW (харагдах хэсэг 4·CW). Харагдах зай: 5·CW+g − 4·CW = 5+g; хил 6.5
    expect(cells([item('Date ', 20, 50), item('Amount', 20 + 5 * CW + 0.5, 50)])).toEqual([['Date Amount']]); // 5.5 ≤ 6.5
    expect(cells([item('Date ', 20, 50), item('Amount', 20 + 5 * CW + 2, 50)])).toEqual([['Date', 'Amount']]); // 7 > 6.5
  });

  it('тоон нүд бүтэн: мянгатын таслал, цэг алдагдахгүй', () => {
    const out = cells([item('1,250,000.00', 20, 50), item('-3,400.50', 200, 50), item('12.5%', 300, 50)]);
    expect(out).toEqual([['1,250,000.00', '-3,400.50', '12.5%']]);
  });

  it('нэг item доторх ≥ 2 зайн дараалал (моноширин мөр нэг Tj-д) нүд болж таслагдана', () => {
    const str = '2026-03-01   Transfer ref 1001      7,750.00';
    const out = cells([item(str, 20, 50)]);
    expect(out).toEqual([['2026-03-01', 'Transfer ref 1001', '7,750.00']]);
  });

  it('нэг item дотор 1 зай нүд таслахгүй', () => {
    expect(cells([item('Transfer ref 1001', 20, 50)])).toEqual([['Transfer ref 1001']]);
  });

  it('өөр өөр өндөртэй хөрш: жижиг өндрөөр хэмжинэ (нүд нийлэхээс илүү таслагдах нь дээр)', () => {
    const out = cells([item('AA', 0, 50, { height: 20 }), item('BB', 2 * CW + 8, 50, { height: 8 })]);
    // gap 8 > 0.65·8 = 5.2 → тас (0.65·20 = 13 бол нэг нүд болох байсан)
    expect(out).toEqual([['AA', 'BB']]);
  });

  it('давхцсан (overlap) item-үүд нэг нүд, зай нэмэхгүй', () => {
    expect(cells([item('AB', 20, 50), item('C', 20 + 2 * CW - 3, 50)])).toEqual([['ABC']]);
  });
});

describe('layoutPdfItems: давхар зурсан, босоо текст', () => {
  it('хуурамч bold (ижил текст бараг ижил байрлалд 2 удаа) нэг л удаа гарна', () => {
    expect(cells([item('Balance', 20, 50), item('Balance', 20.3, 50.2)])).toEqual([['Balance']]);
  });

  it('өөр байрлалтай ижил текст (өөр мөр/нүд) хасагдахгүй', () => {
    expect(cells([item('0.00', 20, 50), item('0.00', 200, 50), item('0.00', 20, 70)])).toEqual([['0.00', '0.00'], ['0.00']]);
  });

  it('босоо/налуу текст (усан тэмдэг) хэвтээ мөрт ХОЛИГДОХГҮЙ — тусдаа мөр болж хуудасны төгсгөлд', () => {
    const lines = layoutPdfItems(
      [item('2026-03-01', 20, 100), item('1,000.00', 200, 100), item('COPY', 100, 100, { upright: false }), item('2026-03-02', 20, 120)],
      O,
    );
    expect(lines.map((l) => l.cells)).toEqual([['2026-03-01', '1,000.00'], ['2026-03-02'], ['COPY']]);
  });
});
