// Регистрийн дугаар: normalize / mask / blind-index hash. Plain регистр лог, event, хайлтын индексэд орохгүй (CLAUDE.md §6.5, NFR-5).
// Hash нь сервис хоорондын lookup-д (origination.blacklist → kyc projection) ашиглагдах тул DATA_INDEX_KEY (crypto.ts) бүх сервист нэг.
import { blindIndex } from './crypto';

// Латин үсгээр бичсэн, кирилл үсэгтэй ДҮРСЭЭРЭЭ адил тэмдэгтүүд (AO1234 → АО1234). Дуудлагаар биш: Б-д дүрс төстэй латин үсэг б
// Кирилл Ү (U+04AE) энд ОРОХГҮЙ: хүчинтэй регистрт Ү өөрөө бодит үсэг бөгөөд customer.registerNoHash (@los/contracts normalizeRegisterNo)
// түүнийг хэвээр хадгалдаг — blacklist hash тэрний хэштэй таарах ёстой. Ү/У/Y-ийн төөрөгдлийг foldRegisterNo, registerNoHashVariants зохицуулна.
const LOOKALIKE: Record<string, string> = {
  A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х',
};

// Үсэг эсвэл аравтын цифр биш бүх тэмдэгт (зай, тусгаарлагч, зураас, _ . / ,, mark, үл үзэгдэх Cf) мөн \p{Lm} (ʼ гэх мэт апостроф-үсэг) устна.
const NOT_ALNUM = /[^\p{L}\p{Nd}]|\p{Lm}/gu;
const FORMAT_CHARS = /\p{Cf}/gu;
const DECIMAL = /^\p{Nd}$/u;
const ASCII_DIGIT = /^[0-9]$/;

// Unicode: аравтын цифрүүд үргэлж 0..9 дараалсан 10-н мужид кодлогдоно, тиймээс залгаа Nd мужийн эхнээс зөрөөг 10-аар авбал утга гарна.
// (Араб-Энэтхэг, Деванагари… цифр → ASCII. NFKC нь fullwidth/математик цифрийг аль хэдийн ASCII болгосон.)
function decimalValue(ch: string): string {
  const cp = ch.codePointAt(0)!;
  let zero = cp;
  while (zero > 0 && DECIMAL.test(String.fromCodePoint(zero - 1))) zero--;
  return String((cp - zero) % 10);
}

/**
 * Регистрийг харьцуулах/hash хийх нэг хэлбэрт оруулна. Үр дүн: зөвхөн том үсэг ба ASCII цифр.
 * Дараалал чухал: Cf (ZWSP, ZWJ, soft hyphen, bidi) → NFKC (fullwidth, Й/Ё-г нэг тэмдэгт болгож нийлүүлнэ) → том үсэг → NFKC
 * → үсэг/цифр биш бүгдийг устгах (mark нь NFKC-ийн дараа л устна, тэгэхгүй бол Й → И болно) → цифр ASCII → look-alike.
 * Idempotent: normalizeRegisterNo(normalizeRegisterNo(x)) === normalizeRegisterNo(x).
 */
export function normalizeRegisterNo(raw: string): string {
  const stripped = raw
    .replace(FORMAT_CHARS, '')
    .normalize('NFKC')
    .toUpperCase()
    .normalize('NFKC')
    .replace(NOT_ALNUM, '');
  let out = '';
  for (const ch of stripped) {
    if (ASCII_DIGIT.test(ch)) out += ch;
    else if (DECIMAL.test(ch)) out += decimalValue(ch);
    else out += LOOKALIKE[ch] ?? ch;
  }
  return out;
}

/**
 * Харьцуулалтын (hash биш) түлхүүр: normalizeRegisterNo-д Ү-г У-тай нэгтгэсэн. Латин Y, кирилл Ү, кирилл У гурав нэг дугаар болно
 * (UN жагсаалтын таних тэмдэгтийн тулгалт). Хадгалах/hash-д ашиглахгүй.
 */
export const foldRegisterNo = (raw: string): string => normalizeRegisterNo(raw).replaceAll('Ү', 'У');

/**
 * Хар жагсаалтын хайлтад ашиглах hash-ууд: эхнийх нь `hashRegisterNo` (customer.registerNoHash-тай ижил). Оператор Ү-ийн оронд У (эсвэл
 * латин Y) бичсэн байж болох тул регистрийн эхний хоёр үсгийн У/Ү хослол бүрийн hash-ийг нэмнэ (дээд тал нь 4).
 */
export function registerNoHashVariants(raw: string): string[] {
  const canonical = normalizeRegisterNo(raw);
  const forms = new Set([canonical]);
  for (const i of [0, 1]) {
    for (const form of [...forms]) {
      const ch = form[i];
      if (ch === 'У' || ch === 'Ү') forms.add(form.slice(0, i) + (ch === 'У' ? 'Ү' : 'У') + form.slice(i + 1));
    }
  }
  return [...forms].map((form) => blindIndex(form));
}

/**
 * Нууцлал: нийт тэмдэгтийн ~1/3-ээс илүүг хэзээ ч ил гаргахгүй. Ил гарах нь зөвхөн сүүлийн min(4, ⌊n/3⌋) тэмдэгт,
 * угтвар үсэг ил гарахгүй; n ≤ 6 бол бүгдийг нууцална. Үр дүн нь нормчилсон утгатай ижил урттай, дор хаяж нэг '*'-тай.
 * УБ12345678 → *******678; 1234567 → *****67.
 */
export function maskRegisterNoStrict(raw: string): string {
  const chars = [...normalizeRegisterNo(raw)];
  const n = chars.length;
  if (n <= 6) return '*'.repeat(n);
  const visible = Math.min(4, Math.floor(n / 3));
  return '*'.repeat(n - visible) + chars.slice(n - visible).join('');
}

/** Blind index (HMAC-SHA256, DATA_INDEX_KEY — crypto.ts) нормчилсон регистрээр: хар жагсаалт, AML-ийн тулгалтын түлхүүр. */
export function hashRegisterNo(raw: string): string {
  return blindIndex(normalizeRegisterNo(raw));
}
