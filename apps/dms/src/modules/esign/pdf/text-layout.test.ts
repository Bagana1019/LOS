import { beforeAll, describe, expect, it } from 'vitest';
import { loadMeasureFonts } from './pdf-inspect';
import { ellipsize, fitText, MAX_FIELD_CHARS, sanitizeText, wrapText, type TextMeasure } from './text-layout';

/** Тогтмол өргөнтэй хиймэл хэмжүүр: тэмдэгт бүр = size × 0.5 */
const mono: TextMeasure = { widthOfTextAtSize: (text, size) => Array.from(text).length * size * 0.5 };

describe('sanitizeText', () => {
  it('control/мөр таслах/tab-ыг нэг зай болгож, захын зайг хасна', () => {
    expect(sanitizeText('  Бат\r\nЭрдэнэ\t\tБолд \u0000 ')).toBe('Бат Эрдэнэ Болд');
  });

  it('bidi override, zero-width, soft hyphen, BOM-ийг хасна (нэрээр харагдах байдлыг хуурах оролдлого)', () => {
    expect(sanitizeText('‮АБВ‬​⁦Г⁩­﻿Д')).toBe('АБВГД');
  });

  it('кирилл Ө ө Ү ү болон Латин тэмдэгтийг өөрчлөхгүй', () => {
    expect(sanitizeText('Өлзийбат Үүрцайх ө ү ABC-123 №')).toBe('Өлзийбат Үүрцайх ө ү ABC-123 №');
  });

  it('дан surrogate-ийг U+FFFD болгоно, жинхэнэ surrogate pair (emoji)-ийг хэвээр үлдээнэ', () => {
    expect(sanitizeText('А\uD800Б')).toBe('А�Б');
    expect(sanitizeText('А😀Б')).toBe('А😀Б');
  });

  it('maxChars-аас урт бол … -ээр таслаж нийт уртыг хэтрүүлэхгүй', () => {
    const out = sanitizeText('а'.repeat(MAX_FIELD_CHARS + 50));
    expect(Array.from(out)).toHaveLength(MAX_FIELD_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(sanitizeText('абвгд', 3)).toBe('аб…');
  });

  it('хоосон/зөвхөн хоосон зай → хоосон мөр', () => {
    expect(sanitizeText(' \n\t ')).toBe('');
  });
});

describe('wrapText', () => {
  it('үгээр мөрлөж, мөр бүр maxWidth-д багтана', () => {
    // 10pt × 0.5 = 5/тэмдэгт, maxWidth 50 → 10 тэмдэгт
    expect(wrapText('нэг хоёр гурав дөрөв тав', mono, 10, 50)).toEqual(['нэг хоёр', 'гурав', 'дөрөв тав']);
  });

  it('үг хоорондын зай нэг л тоологдоно, нэг мөрөнд багтвал таслахгүй', () => {
    expect(wrapText('нэг хоёр', mono, 10, 500)).toEqual(['нэг хоёр']);
  });

  it('урт хэш (зайгүй)-ийг тэмдэгтээр таслаж, нийлүүлбэл эх хэвээрээ', () => {
    const hash = 'a'.repeat(64);
    const lines = wrapText(hash, mono, 10, 100); // 20 тэмдэгт/мөр
    expect(lines).toEqual(['a'.repeat(20), 'a'.repeat(20), 'a'.repeat(20), 'a'.repeat(4)]);
    expect(lines.join('')).toBe(hash);
  });

  it('URL-ийг эхлээд / : . зэрэг зөөлөн цэгээр таслана (үгийн дундуур биш)', () => {
    const lines = wrapText('http://localhost:3000/verify/7K3QXM9ZB4TN', mono, 10, 100); // 20 тэмдэгт/мөр
    expect(lines).toEqual(['http://localhost:', '3000/verify/', '7K3QXM9ZB4TN']);
  });

  it('урт үг дунд мөрөнд орсон бол өмнөх үгийг тусад нь мөрөнд үлдээж, урт үгийг шинэ мөрөөс эхлүүлнэ', () => {
    expect(wrapText(`нэг ${'б'.repeat(25)}`, mono, 10, 50)).toEqual(['нэг', 'б'.repeat(10), 'б'.repeat(10), 'б'.repeat(5)]);
  });

  it('maxWidth нэг тэмдэгтээс явцуу ч гацахгүй, мөр бүрд ≥1 тэмдэгт', () => {
    const lines = wrapText('абв', mono, 10, 1);
    expect(lines).toEqual(['а', 'б', 'в']);
  });

  it('хоосон текст → [""]', () => {
    expect(wrapText('', mono, 10, 100)).toEqual(['']);
  });
});

describe('ellipsize', () => {
  it('… -тэй нь багтахаар төгсгөлөөс хасна', () => {
    expect(ellipsize('абвгдеёжз', mono, 10, 30)).toBe('абвгд…'); // 6 тэмдэгт × 5 = 30
  });
});

describe('fitText', () => {
  const options = { maxSize: 10, minSize: 5, maxWidth: 100, maxLines: 2 };

  it('хамгийн том хэмжээнд багтвал нэг мөр, дээд хэмжээгээр', () => {
    expect(fitText('абвгд', mono, options)).toEqual({ size: 10, lines: ['абвгд'] });
  });

  it('хэмжээг 0.25-аар бууруулж багтах хамгийн том хэмжээг олно', () => {
    // 30 тэмдэгт × size × 0.5 ≤ 100 → size ≤ 6.67 → 6.5
    const fitted = fitText('а'.repeat(30), mono, options);
    expect(fitted.lines).toHaveLength(1);
    expect(fitted.size).toBe(6.5);
    expect(mono.widthOfTextAtSize(fitted.lines[0], fitted.size)).toBeLessThanOrEqual(100);
  });

  it('хамгийн бага хэмжээнд ч багтахгүй бол мөрөнд хуваана', () => {
    const fitted = fitText('нэг хоёр гурав дөрөв тав зургаа долоо найм', mono, { ...options, maxLines: 5 });
    expect(fitted.size).toBe(5);
    expect(fitted.lines.length).toBeGreaterThan(1);
    expect(fitted.lines.every((line) => mono.widthOfTextAtSize(line, 5) <= 100)).toBe(true);
  });

  it('maxLines-аас олон бол сүүлийн мөрийг … -ээр таслана, ямар ч мөр maxWidth-ээс хэтрэхгүй', () => {
    const fitted = fitText('а'.repeat(200), mono, { ...options, maxLines: 2 });
    expect(fitted.lines).toHaveLength(2);
    expect(fitted.lines[1].endsWith('…')).toBe(true);
    expect(fitted.lines.every((line) => mono.widthOfTextAtSize(line, fitted.size) <= 100)).toBe(true);
  });

  it('minSize > maxSize байвал minSize-ийг барина', () => {
    expect(fitText('аб', mono, { maxSize: 3, minSize: 5, maxWidth: 100, maxLines: 1 }).size).toBe(5);
  });
});

describe('жинхэнэ DejaVu шрифтээр', () => {
  let regular: TextMeasure;
  beforeAll(async () => {
    regular = (await loadMeasureFonts()).regular;
  });

  it('урт монгол нэр, хэш, URL нь баганад багтаж, тэмдэгт алдагдахгүй', () => {
    const samples = [
      'Өлзийбат-Эрдэнэ Үүрцайхгийн Төмөр-Очирын Бат-Өлзий '.repeat(3).trim(),
      'aa348f2551c701fb84d47154a8ffb34f27620b604d7120d59fbf4e826733a4c6',
      'https://sign.example.mn/verify/7K3QXM9ZB4TN?utm_source=sms&utm_campaign=esign',
    ];
    for (const sample of samples) {
      const lines = wrapText(sample, regular, 9.5, 120);
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) expect(regular.widthOfTextAtSize(line, 9.5)).toBeLessThanOrEqual(120);
      expect(lines.join(' ').replace(/\s/g, '')).toBe(sample.replace(/\s/g, ''));
    }
  });
});
