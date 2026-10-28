// Түлхүүр хэллэгийг нормчилсон текстээс "үгийн хил"-ийг хүндэтгэн хайх. BSA-FR-3.1, NFR-9.
import { FIELD_SEPARATOR, WORD_SEPARATOR } from './normalize';

/** EXACT: хоёр захаараа бүтэн үг. PREFIX: зүүн хил зөв, баруун захад нөхцөл залгагдсан ('цалин' ⊂ 'цалингийн'). */
export type PhraseMatch = 'EXACT' | 'PREFIX';

const SPACE = WORD_SEPARATOR.charCodeAt(0);
const BAR = FIELD_SEPARATOR.charCodeAt(0);
const isBoundary = (code: number): boolean => code === SPACE || code === BAR;

/**
 * `haystack` дотор `phrase` (хоёулаа toMatchKey-ийн гаралт) үгийн зүүн хилээс эхлэн таарах эсэх.
 * - Зүүн хил үргэлж шаардлагатай: 'us' нь 'musak', 'rus' дотор таарахгүй.
 * - Баруун хил: бүтэн үг → 'EXACT'; хил биш бол зөвхөн `prefixAllowed` үед 'PREFIX'.
 * Олон таарсан байрлалаас 'EXACT'-ийг давуу авна. Цэвэр функц, O(n·k) хамгийн ихдээ (indexOf).
 */
export function matchPhrase(haystack: string, phrase: string, prefixAllowed: boolean): PhraseMatch | null {
  if (phrase === '') return null;
  let best: PhraseMatch | null = null;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(phrase, from);
    if (at < 0) return best;
    from = at + 1;
    if (at > 0 && !isBoundary(haystack.charCodeAt(at - 1))) continue;
    const end = at + phrase.length;
    if (end === haystack.length || isBoundary(haystack.charCodeAt(end))) return 'EXACT';
    if (prefixAllowed) best = 'PREFIX';
  }
}

/** Хэллэгийн сүүлийн үгийн урт (араг ясны тэмдэгтээр) */
export function lastWordLength(phrase: string): number {
  return phrase.length - phrase.lastIndexOf(WORD_SEPARATOR) - 1;
}
