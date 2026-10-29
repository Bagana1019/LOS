// Нэрийг хайлтад зориулж нэг хэлбэрт оруулах (FR-13.1, BR-9 дотоод хар жагсаалт ба НҮБ-ын жагсаалтын тулгалт).
// Кирилл ба латин бичиглэлийг ижил "хэлц" руу хөрвүүлж cross-script recall өгнө. PII тул үр дүнг лог-д бичихгүй.
import { transliterateCyrillic } from './translit';

// Хуваагч: бүх төрлийн зураас, _ . , / \ → зай. Эдгээр нь токен тусгаарлана (Al-Rashid → al rashid).
const SEPARATORS = /[\p{Pd}_.,/\\]/gu;
// Апостроф/хашилт устгана (O'Brien → obrien). U+02B9–02BD (ʻ ʼ …) нь \p{L} тул тусад нь заана;
// үсэг, цифр, зайнаас бусад бүх тэмдэгт мөн устна. Бусад бичгийн үсэг (араб, хятад) хэвээр үлдэнэ.
const DROPPED = /[ʹ-ʽ]|[^\p{L}\p{N}\s]/gu;

// Латин үсэг NFKD-ээр задарч суурь үсэг + diacritic болдоггүй тохиолдлууд (тусдаа үсэг хэвээр үлддэг): турк ı, вьетнам/хорват đ,
// исланд ð þ, польш ł, дани/норвег ø æ, франц œ, герман ß. НҮБ-ын жагсаалтын нэр ASCII болгосон, иргэний бичиг баримт эдгээр
// үсгээр бичигддэг тул NFKD-ийн өмнө ASCII хэлбэрт оруулна (Kılıç ~ Kilic, Đức ~ Duc, Bjørn ~ Bjorn). Оролт аль хэдийн lowercase.
const LATIN_FOLD: Readonly<Record<string, string | undefined>> = {
  ı: 'i', đ: 'd', ð: 'd', ł: 'l', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', þ: 'th',
};
const LATIN_FOLD_CHARS = /[ıđðłøæœßþ]/gu;

// Cross-script folding — жагсаалт зориудаар богино. Бүгд латин үсгийн дүрмүүд.
// kh→h (х ба араб خ), ph→f, ck→k, q→k, w→v, x→ks (Alexander ~ Aleksandr), zh→j (орос/казах/НҮБ "zh" нь MNS 5217-ийн ж = "j"-тэй
// ижил: Жаргал ~ Zhargal; dzh → dj).
const FOLDS: readonly (readonly [RegExp, string])[] = [
  [/kh/g, 'h'], [/ph/g, 'f'], [/ck/g, 'k'], [/zh/g, 'j'], [/q/g, 'k'], [/w/g, 'v'], [/x/g, 'ks'],
];
// Давхар латин үсэг нэг болно (Muhammad ~ Muhamad). Цифр давхардлыг хадгална (88 ≠ 8).
const REPEATS = /([a-z])\1+/g;

// Нэг дүрэм нөгөөгийн оролтыг үүсгэж болно (pkkh → pkh → ph), иймээс тогтворжтол давтана: үр дүн нь idempotent.
// Алхам бүр урт эсвэл x/q/w-ийн тоог бууруулдаг тул төгсгөлтэй.
// fold-д ямар ч дүрэм хамаарахгүй бол (давхар үсэг, kh/ph/ck/zh/q/w/x байхгүй) шууд буцаана — үр дүн ижил, хурдан зам.
const FOLD_NEEDED = /([a-z])\1|kh|ph|ck|zh|[qwx]/;
function fold(text: string): string {
  if (!FOLD_NEEDED.test(text)) return text;
  let current = text;
  for (;;) {
    let next = current.replace(REPEATS, '$1');
    for (const [pattern, replacement] of FOLDS) next = next.replace(pattern, replacement);
    if (next === current) return current;
    current = next;
  }
}

// Холимог бичгийн токен (латин + кирилл нэг үгэнд): кирилл үсгийн латин ДҮРСТЭЙ ижил хувилбар (UTS #39 skeleton-ийн жижиг дэд олонлог).
// Дуудлагаар хөрвүүлбэл р→r, с→s, х→kh, н→n болж "Рaуpаl" мэт нэр оноо алддаг; хоёр хэлбэрийг хоёуланг нь оноож max авна.
export const CONFUSABLE_TO_LATIN: Readonly<Record<string, string | undefined>> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ј: 'j', ѕ: 's', ӏ: 'l', һ: 'h', ү: 'y', ѵ: 'v', ԁ: 'd', ԛ: 'q', ԝ: 'w',
};
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const HAS_LATIN = /\p{Script=Latin}/u;
const HAS_CYRILLIC = /\p{Script=Cyrillic}/u;

/** Зөвхөн латин ба кирилл үсэг ХОЁУЛАА агуулсан үг дэх кирилл төстэй үсгийг латин болгоно. Холимог үг байхгүй бол оролтыг буцаана. */
function skeletonize(lower: string): string {
  return lower.replace(WORD, (word) => {
    if (!HAS_LATIN.test(word) || !HAS_CYRILLIC.test(word)) return word;
    let out = '';
    for (const ch of word) out += CONFUSABLE_TO_LATIN[ch] ?? ch;
    return out;
  });
}

// Хөрвүүлсний дараах цэвэрлэгээ: латин үсгийн хүснэгт, NFKD, diacritic, тэмдэгт, зай, fold.
function finish(latin: string): string {
  const cleaned = latin
    .replace(LATIN_FOLD_CHARS, (ch) => LATIN_FOLD[ch] ?? ch)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(SEPARATORS, ' ')
    .replace(DROPPED, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return fold(cleaned);
}

/**
 * Нэрийг тулгалтын хэлбэрт оруулна: NFKC → lowercase → кирилл→латин → NFKD, diacritic устгах → тэмдэгт цэвэрлэх → fold.
 * NFKC эхэлж ороход ё, й нь нэг тэмдэгт хэвээр translit хүрнэ (NFKD эхэлбэл ё→е, й→и болж yo алдагдана).
 * Idempotent: normalizeName(normalizeName(x)) === normalizeName(x).
 */
export function normalizeName(input: string): string {
  return finish(transliterateCyrillic(input.normalize('NFKC').toLowerCase()));
}

/**
 * Тулгалтад оролцох бүх хэлбэр: [үндсэн (normalizeName), ...өөр хэлбэрүүд]; давхцахгүй, хоосон биш (үндсэн нь хоосон бол ['']).
 *  - Паспортын хэлбэр (нэрэнд ө байвал): Өлзий → "ulzi" (Монгол паспорт Ө-г U гэж бичдэг; үндсэн нь "olzi"). Jaro-Winkler-ийн
 *    тэсвэрлэлтэд найдахгүй, богино токен, хоёр ө-тэй нэрэнд ч яг таарна.
 *  - Холимог бичгийн үг (латин+кирилл нэг үгэнд) байвал кирилл төстэй үсгийг дүрсээр нь латин болгосон хэлбэр.
 * Харьцуулахдаа хэлбэр хос бүрийн хамгийн өндөр оноог авна.
 */
export function normalizeNameForms(input: string): string[] {
  const lower = input.normalize('NFKC').toLowerCase();
  const forms = [finish(transliterateCyrillic(lower))];
  const add = (form: string) => { if (form !== '' && !forms.includes(form)) forms.push(form); };
  if (lower.includes('ө')) add(finish(transliterateCyrillic(lower, { oeAsU: true })));
  const skeleton = skeletonize(lower);
  if (skeleton !== lower) add(finish(transliterateCyrillic(skeleton)));
  return forms;
}

// Араб нэрийн o/u ба e/a эгшгийн бичлэгийн зөрүү (Mohammed ~ Muhammad, Omar ~ Umar, Hossein ~ Hussein). Нэрийн ЭГШГИЙН ХУВИЛБАР нь
// тулгалтын нэмэлт хэлбэр (үндсэн хэлбэрийг орлохгүй): хоёр тал хоёулаа o→u, e→a болгосны дараа харьцуулагдаж max авна.
const VOWEL_O = /o/g;
const VOWEL_E = /e/g;
const VOWEL_VARIANT_NEEDED = /[oe]/;

/**
 * Нормчилсон токены эгшгийн хувилбар: o→u, e→a, дараа нь давхар үсгийг дахин нэгтгэнэ (moussa → muusa → musa).
 * o, e байхгүй токеныг өөрчлөхгүй. Үр дүн idempotent.
 */
export function vowelVariant(token: string): string {
  if (!VOWEL_VARIANT_NEEDED.test(token)) return token;
  return fold(token.replace(VOWEL_O, 'u').replace(VOWEL_E, 'a'));
}

/** Нормчилсон нэрийг токенд хуваана (хоосон бол []). */
export function tokenize(normalized: string): string[] {
  return normalized.split(/\s+/u).filter((token) => token !== '');
}

/**
 * Токенуудыг зайгүй залгаж (үгийн хил хязгаар хамаарахгүй: Abdul Rahman ~ Abdulrahman) дахин fold хийнэ.
 * Fold нь залгааны хилээр давхар үсэг/kh зэргийг нэгтгэнэ: normalizeName("Bat Tuvshin") залгавал "battuvshin" → "batuvshin",
 * normalizeName("Battuvshin") = "batuvshin" — хоёр тал ижил болно.
 */
export function joinTokens(tokens: readonly string[]): string {
  return fold(tokens.join(''));
}
