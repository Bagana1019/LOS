import { describe, expect, it } from 'vitest';
import { decodeTextBytes } from './text-decoding';
import { encodeCp1251, encodeUtf16, utf8Bom } from './testing/encodings';

const OPTS = { cp1251Dominance: 0.7, remapMongolianCp1251: true };
const SAMPLE = 'Огноо;Гүйлгээний утга;Дүн\n2026-03-01;Цалин Өлзий;1500000,50\n';

describe('decodeTextBytes', () => {
  it('UTF-8 (BOM-гүй)', () => {
    expect(decodeTextBytes(Buffer.from(SAMPLE, 'utf8'), OPTS)).toEqual({ text: SAMPLE, encoding: 'utf-8' });
  });

  it('UTF-8 BOM хасагдана', () => {
    const r = decodeTextBytes(utf8Bom(SAMPLE), OPTS);
    expect(r).toEqual({ text: SAMPLE, encoding: 'utf-8' });
    expect(r.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('UTF-16LE BOM, UTF-16BE BOM', () => {
    expect(decodeTextBytes(encodeUtf16(SAMPLE, 'le'), OPTS)).toEqual({ text: SAMPLE, encoding: 'utf-16le' });
    expect(decodeTextBytes(encodeUtf16(SAMPLE, 'be'), OPTS)).toEqual({ text: SAMPLE, encoding: 'utf-16be' });
  });

  it('UTF-16 сондгой урт (төгсгөлийн хагас тэмдэгт) унахгүй; эх буфер өөрчлөгдөхгүй', () => {
    const buf = Buffer.concat([encodeUtf16('AB', 'be'), Buffer.from([0x00])]);
    const copy = Buffer.from(buf);
    expect(decodeTextBytes(buf, OPTS).text).toBe('AB');
    expect(buf.equals(copy)).toBe(true);
  });

  it('windows-1251 (UTF-8 буруу, байтын 0xC0+ давамгайлсан)', () => {
    const r = decodeTextBytes(encodeCp1251('Огноо;Гүйлгээний утга;Дүн\n2026-03-01;Цалин Ёлка;1500000,50\n'), OPTS);
    expect(r.encoding).toBe('windows-1251');
    expect(r.text).toBe('Огноо;Гүйлгээний утга;Дүн\n2026-03-01;Цалин Ёлка;1500000,50\n');
  });

  it('windows-1251: Ө/Ү (Є/Ї байранд) монгол үсэг болж нөхөгдөнө; remap унтраалттай бол Є/Ї хэвээр', () => {
    const bytes = encodeCp1251('Өндөр Үнэ өдөр үнэ');
    expect(decodeTextBytes(bytes, OPTS).text).toBe('Өндөр Үнэ өдөр үнэ');
    expect(decodeTextBytes(bytes, { ...OPTS, remapMongolianCp1251: false }).text).toBe('Єндєр Їнэ єдєр їнэ');
  });

  it('зөвхөн ASCII → UTF-8; хоосон → хоосон', () => {
    expect(decodeTextBytes(Buffer.from('a,b\n1,2'), OPTS)).toEqual({ text: 'a,b\n1,2', encoding: 'utf-8' });
    expect(decodeTextBytes(Buffer.alloc(0), OPTS)).toEqual({ text: '', encoding: 'utf-8' });
  });

  it('UTF-8 буруу ч кирилл биш (давамгайлал бага) → орлуулагч тэмдэгттэй UTF-8, унахгүй', () => {
    // 0x80-0xBF (cp1251-ийн "тэмдэгт" муж) давамгайлсан хог
    const r = decodeTextBytes(Buffer.from([0x61, 0x80, 0x81, 0x82, 0x83, 0xc3, 0x62]), OPTS);
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toContain('\ufffd');
  });

  it('давамгайлах босго дарагдана: cp1251 шиг байтыг босго 1.0 үед UTF-8 хог гэж үзнэ', () => {
    const bytes = Buffer.concat([encodeCp1251('Цалин'), Buffer.from([0xa0])]); // 0xA0 нь 0xC0-аас бага
    expect(decodeTextBytes(bytes, { ...OPTS, cp1251Dominance: 0.99 }).encoding).toBe('utf-8');
    expect(decodeTextBytes(bytes, { ...OPTS, cp1251Dominance: 0.7 }).encoding).toBe('windows-1251');
  });
});
