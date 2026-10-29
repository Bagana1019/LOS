// Кирилл/латин үсгийн түвшний нийтлэг функцүүд (NFR-9). Цэвэр функц, I/O байхгүй.
import {
  CYRILLIC_TO_LATIN,
  CYRILLIC_TO_LATIN_LOOKALIKE,
  INVISIBLE_CHARS_RE,
  LATIN_TO_CYRILLIC_LOOKALIKE,
} from './charmap';

const CYRILLIC_BLOCK_RE = /[Ѐ-ԯ]/g;
const LATIN_LOOKALIKE_RE = new RegExp(`[${Object.keys(LATIN_TO_CYRILLIC_LOOKALIKE).join('')}]`, 'g');
const CYRILLIC_LOOKALIKE_RE = new RegExp(`[${Object.keys(CYRILLIC_TO_LATIN_LOOKALIKE).join('')}]`, 'g');
const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;

/** Үл үзэгдэх тэмдэгтийг устгаж, ямар ч unicode зайг (NBSP, tab, \n...) нэг зай болгон, захын зайг тайрна. */
export function normalizeWhitespace(s: string): string {
  return s.replace(INVISIBLE_CHARS_RE, '').replace(/\s+/g, ' ').trim();
}

const isUpper = (c: string | undefined): boolean => c !== undefined && c !== c.toLowerCase();

/**
 * Кирилл үсгийг латин араг яс руу хөрвүүлнэ (хүснэгт: charmap.ts). Том/жижиг хэлбэрийг хадгална:
 * 'Цалин' → 'Tsalin', 'ЦАЛИН' → 'TSALIN'. Хүснэгтэнд байхгүй тэмдэгт хэвээр үлдэнэ.
 */
export function cyrillicToLatin(s: string): string {
  return s.normalize('NFC').replace(CYRILLIC_BLOCK_RE, (ch, offset: number, whole: string) => {
    const lower = ch.toLowerCase();
    const mapped = CYRILLIC_TO_LATIN[lower];
    if (mapped === undefined) return ch;
    if (ch === lower || mapped === '') return mapped;
    if (mapped.length === 1) return mapped.toUpperCase();
    // Хоёр үсэгт (Ts, Ch, Sh, Yu, Ya): хөрш том үсэгтэй бол бүгд том, үгүй бол Title
    return isUpper(whole[offset - 1]) || isUpper(whole[offset + 1])
      ? mapped.toUpperCase()
      : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  });
}

/**
 * Кирилл үсэгтэй харагдацаараа ижил латин үсгийг кирилл болгоно (A,B,C,E,H,K,M,O,P,T,X,Y,a,c,e,o,p,x,y).
 * Регистр, шошго зэрэг "кирилл байх ёстой" талбарт. Бусад тэмдэгтэд хүрэхгүй.
 */
export function foldLatinLookalikesToCyrillic(s: string): string {
  return s.replace(LATIN_LOOKALIKE_RE, (ch) => LATIN_TO_CYRILLIC_LOOKALIKE[ch]);
}

/** Урвуу: кирилл look-alike → латин (латин үгэн дотор OCR-аар орсон кирилл а, с, е, о, р, х, у...). */
export function foldCyrillicLookalikesToLatin(s: string): string {
  return s.replace(CYRILLIC_LOOKALIKE_RE, (ch) => CYRILLIC_TO_LATIN_LOOKALIKE[ch]);
}

const isCyrillicCp = (cp: number): boolean => cp >= 0x400 && cp <= 0x52f;
const isLatinCp = (cp: number): boolean =>
  (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f) || (cp >= 0x1e00 && cp <= 0x1eff);

/**
 * Нэг үг дотор кирилл + латин холилдсон бол бичгийн систем сонгоно. Look-alike үсэг (а/a, с/c, о/o ...) хоёр талдаа байж
 * болдог тул ШИЙДВЭРЛЭГЧ нь look-alike БУС үсэг: кирилл (д, л, ц...) vs латин (d, l, r...). Тэнцвэл эсвэл шийдвэрлэгч үсэггүй бол кирилл.
 * 'цaлин' (латин a) → кирилл; 'Оpдoc' (латин p, o, c; д шийдвэрлэнэ) → кирилл; 'Salаry' (кирилл а) → латин.
 * Цэвэр кирилл/латин үгэнд хүрэхгүй (BSA NFR-9).
 */
export function resolveMixedScriptWords(s: string): string {
  return s.replace(WORD_RE, (word) => {
    let hasCyr = false;
    let hasLat = false;
    let decisiveCyr = 0;
    let decisiveLat = 0;
    for (const ch of word) {
      const cp = ch.codePointAt(0) as number;
      if (isCyrillicCp(cp)) {
        hasCyr = true;
        if (!(ch in CYRILLIC_TO_LATIN_LOOKALIKE)) decisiveCyr++;
      } else if (isLatinCp(cp)) {
        hasLat = true;
        if (!(ch in LATIN_TO_CYRILLIC_LOOKALIKE)) decisiveLat++;
      }
    }
    if (!hasCyr || !hasLat) return word;
    return decisiveCyr >= decisiveLat ? foldLatinLookalikesToCyrillic(word) : foldCyrillicLookalikesToLatin(word);
  });
}

/** Жижиг үсгээр бичигдсэн текстийн кирилл үсгийг араг яс болгоно; хүснэгтэнд үгүй кирилл тэмдэгтийг хасна (idempotent байлгах). */
export function transliterateLowerCyrillic(s: string): string {
  return s.replace(CYRILLIC_BLOCK_RE, (ch) => CYRILLIC_TO_LATIN[ch] ?? '');
}
