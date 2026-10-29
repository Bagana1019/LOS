// CSV / энгийн текстийн кодчилол таних: UTF-8 (BOM), UTF-16LE/BE (BOM), windows-1251 (heuristic). Node TextDecoder ашиглана.
import type { CsvTextOptions } from './types';

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251';

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
}

export type DecodeOptions = Pick<CsvTextOptions, 'cp1251Dominance' | 'remapMongolianCp1251'>;

// Монгол кирилл windows-1251: Ө/Ү нь украин Є/Ї-ийн байранд (0xAA/0xAF, жижиг 0xBA/0xBF) гэж таамагласан.
// TODO(samples): жинхэнэ cp1251 CSV-ээр баталгаажуулах. Монгол хуулгад украин Є/Ї байхгүй тул буруу таамаглал ч хор хөнөөлгүй.
const MONGOLIAN_CP1251_REMAP: Readonly<Record<string, string>> = { 'Є': 'Ө', 'є': 'ө', 'Ї': 'Ү', 'ї': 'ү' };

/** windows-1251-ийн 0xC0-ээс доош кирилл үсгүүд: Ё 0xA8, ё 0xB8, Є 0xAA, є 0xBA, Ї 0xAF, ї 0xBF */
const CP1251_EXTRA_LETTERS: ReadonlySet<number> = new Set([0xa8, 0xb8, 0xaa, 0xba, 0xaf, 0xbf]);

function decodeUtf16(buf: Buffer, bigEndian: boolean): string {
  const even = buf.length - (buf.length % 2);
  const body = Buffer.from(buf.subarray(0, even)); // хуулбар: swap16 эх буфферийг өөрчилнө
  if (bigEndian) body.swap16();
  return new TextDecoder('utf-16le').decode(body);
}

export function decodeTextBytes(buf: Buffer, options: DecodeOptions): DecodedText {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: decodeUtf16(buf.subarray(2), false), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: decodeUtf16(buf.subarray(2), true), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    // UTF-8 биш. 0x80+ байтуудын дотор кирилл үсгийн байт (0xC0-0xFF А-я, мөн Ё/ё/Є/є/Ї/ї — Ө/Ү-ийн байр) давамгайлвал windows-1251
    let high = 0;
    let cyrillic = 0;
    for (const b of buf) {
      if (b >= 0x80) high++;
      if (b >= 0xc0 || CP1251_EXTRA_LETTERS.has(b)) cyrillic++;
    }
    if (high > 0 && cyrillic / high >= options.cp1251Dominance) {
      let text = new TextDecoder('windows-1251').decode(buf);
      if (options.remapMongolianCp1251) text = text.replace(/[ЄєЇї]/g, (c) => MONGOLIAN_CP1251_REMAP[c]);
      return { text, encoding: 'windows-1251' };
    }
    // Хагас эвдэрсэн UTF-8: орлуулагч тэмдэгттэй (U+FFFD) уншина — файлыг няцаахгүй
    return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8' };
  }
}
