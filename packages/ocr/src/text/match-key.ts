// Түлхүүр үг тааруулах канон түлхүүр (BSA-FR-3.1, NFR-9): кирилл, латин, холимог бичлэг НЭГ түлхүүр өгнө.
// Хүснэгтүүд: ./charmap.ts. Жишээ: 'Цалин' = 'ЦАЛИН' = 'tsalin' = 'цaлин'(латин a) → 'tsalin'.
import { APOSTROPHE_CHARS_RE, INVISIBLE_CHARS_RE, LATIN_FOLD_RULES } from './charmap';
import { resolveMixedScriptWords, transliterateLowerCyrillic } from './script';

/** Латин нугалалт тогтворжих хүртэл давтах дээд тоо (дүрмүүд нь урт багасгах/үсэг солих л тул хэдхэн дамжилтад тогтворжино) */
const MAX_FOLD_PASSES = 10;

/** NFD-ээр диакритик хасна, гэхдээ кирилл й, ё-г хамгаална (өөр түлхүүртэй: й→i, ё→o). */
function stripDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/и\u0306/g, 'й')
    .replace(/е\u0308/g, 'ё')
    .replace(/[\u0300-\u036F]/g, '')
    .normalize('NFC');
}

/** Латин хувилбаруудыг (kh/x, zh, w, c, ye/yo, y, давхар үсэг) тогтворжтол нугалж нэг араг яс болгоно. */
function foldLatin(s: string): string {
  let cur = s;
  for (let pass = 0; pass < MAX_FOLD_PASSES; pass++) {
    let next = cur;
    for (const [re, replacement] of LATIN_FOLD_RULES) next = next.replace(re, replacement);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * Түлхүүр үг тааруулах канон түлхүүр. Алхмууд: NFKC → үл үзэгдэх тэмдэгт/apostrophe устгах → холимог үгийн look-alike
 * нэгтгэх (том/жижиг мэдэрнэ) → жижиг үсэг (Ө/Ү орно) → диакритик хасах → тэмдэгт = нэг зай → кирилл→латин араг яс →
 * латин хувилбар нугалах. Идемпотент: toMatchKey(toMatchKey(x)) === toMatchKey(x). Хоосон/буруу оролтод ''.
 */
export function toMatchKey(input: string): string {
  if (typeof input !== 'string' || input === '') return '';
  let s = input.normalize('NFKC').replace(INVISIBLE_CHARS_RE, '').replace(APOSTROPHE_CHARS_RE, '');
  s = stripDiacritics(resolveMixedScriptWords(s).toLowerCase());
  s = s.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ');
  s = foldLatin(transliterateLowerCyrillic(s));
  return s.replace(/ {2,}/g, ' ').trim();
}
