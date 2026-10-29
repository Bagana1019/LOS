// Монгол регистрийн дугаар (иргэний РД): 2 кирилл том үсэг + 8 цифр (BSA-FR-2.2 нэр/регистр тулгалт, FR-1.2 харилцагч холбох).
import { INVISIBLE_CHARS_RE } from './charmap';
import { buildIsoDate } from './date';
import { foldLatinLookalikesToCyrillic } from './script';

export interface RegisterNoInfo {
  valid: boolean;
  /** Каноник 'УБ90010203' (valid=true үед л) */
  value: string | null;
  /** 'YYYY-MM-DD' */
  birthDate: string | null;
  gender: 'M' | 'F' | null;
}

const REGISTER_LETTERS_RE = /^[А-ЯЁӨҮ]{2}$/;
const REGISTER_MAX_INPUT_LENGTH = 40;
// OCR-ийн цифрийн андуурал: зөвхөн цифрийн хэсэгт, мөн үр дүн нь бүтнээрээ зөв байвал л хүлээн авна
const DIGIT_CONFUSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[OoОо]/g, '0'], // латин/кирилл O
  [/[Il]/g, '1'],
  [/[Ss]/g, '5'],
  [/B/g, '8'],
];

/** Нэг тогтвортой "буруу" үр дүн: valid=false бол value, birthDate, gender ГУРАВ ЧУ null (хагас-зөв төлөв байхгүй). */
const invalid = (): RegisterNoInfo => ({ valid: false, value: null, birthDate: null, gender: null });

function build(letters: string, digits: string): RegisterNoInfo | null {
  if (!REGISTER_LETTERS_RE.test(letters) || !/^\d{8}$/.test(digits)) return null;
  // Төрсөн огноо = YYMMDD (эхний 6 цифр). Сар 01-12 → 19YY; сар 21-32 (сар+20) → 20YY. Бусад сар → буруу.
  const yy = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  let year: number;
  let month: number;
  if (mm >= 1 && mm <= 12) {
    year = 1900 + yy;
    month = mm;
  } else if (mm >= 21 && mm <= 32) {
    year = 2000 + yy;
    month = mm - 20;
  } else return null;
  const birthDate = buildIsoDate(year, month, dd);
  if (!birthDate) return null;
  // ТАМААГ (docs-д заагаагүй): хүйс = 8 цифрийн 7-р цифрийн тэгш/сондгой — сондгой = эрэгтэй, тэгш = эмэгтэй.
  const gender = Number(digits[6]) % 2 === 1 ? 'M' : 'F';
  return { valid: true, value: letters + digits, birthDate, gender };
}

/**
 * Регистрийн дугаар задлах. Зай/зураас/цэг тэвчнэ; жижиг үсэг, латин look-alike үсгийг (A,B,E,H,K,M,O,P,T,X,Y...) кирилл болгоно
 * ('YБ' → 'УБ'). Цифрийн хэсэгт OCR-ийн андуурал (O→0, I/l→1, S→5, B→8) зөвхөн засаад бүтэн дугаар ЗӨВ болох үед.
 * ТОГТВОРТОЙ ДҮРЭМ: төрсөн огноо хуанлийн хувьд буруу (30 хоногтой 2-р сар г.м.) бол БҮТЭН дугаар valid:false
 * (value/birthDate/gender бүгд null); valid:true үед гурвуулаа заавал утгатай. 'UB' гэх мэт латин транслитыг таамаглахгүй.
 */
export function parseRegisterNo(input: string): RegisterNoInfo {
  if (typeof input !== 'string') return invalid();
  const raw = input.normalize('NFKC').replace(INVISIBLE_CHARS_RE, '');
  if (raw.length > REGISTER_MAX_INPUT_LENGTH) return invalid();
  const compact = raw.replace(/[\s\-._]/g, '');
  if (compact.length !== 10) return invalid();
  const letters = foldLatinLookalikesToCyrillic(compact.slice(0, 2).toUpperCase());
  const rawDigits = compact.slice(2);
  const strict = build(letters, rawDigits);
  if (strict) return strict;
  if (/^\d{8}$/.test(rawDigits)) return invalid(); // цифр бүрэн ч огноо/үсэг буруу — засах зүйлгүй
  const repaired = DIGIT_CONFUSIONS.reduce((acc, [re, to]) => acc.replace(re, to), rawDigits);
  return build(letters, repaired) ?? invalid();
}
