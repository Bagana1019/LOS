// Дансны дугаар / IBAN (BSA-FR-2.2 verifier: IBAN; BSA-BR-5: өөрийн дансны тулгалт). Цэвэр функц.
import { INVISIBLE_CHARS_RE } from './charmap';
import { foldCyrillicLookalikesToLatin } from './script';

/**
 * IBAN бүртгэл (SWIFT IBAN Registry): улсын код → нийт урт. Монгол (MN) = 20, жишээ MN580050099123456789
 * (https://iban.com/structure.html-ээр баталгаажсан). Бүртгэлд байхгүй улсын IBAN-ыг буруу гэж үзнэ (хатуу).
 * TODO(registry): шинэ улс нэмэгдэхэд энд нэмнэ — өөр газар давтахгүй.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AL: 28, AD: 24, AT: 20, AZ: 28, BH: 22, BE: 16, BA: 20, BR: 29, BG: 22, CR: 22, HR: 21, CY: 28, CZ: 24, FO: 18, GL: 18, DK: 18,
  DO: 28, EE: 20, EG: 29, FI: 18, FR: 27, GE: 22, DE: 22, GI: 23, GR: 27, GT: 28, HU: 28, IS: 26, IE: 22, IL: 23, IT: 27, JO: 30,
  KZ: 20, XK: 20, KW: 30, LV: 21, LB: 28, LI: 21, LT: 20, LU: 20, MK: 19, MT: 31, MR: 27, MU: 30, MD: 24, MC: 27, ME: 22, NL: 18,
  NO: 15, PK: 24, PS: 29, PL: 28, PT: 25, QA: 29, RO: 24, SM: 27, LC: 32, ST: 25, SA: 24, RS: 22, SK: 24, SI: 19, ES: 24, SE: 24,
  CH: 21, TL: 23, TN: 24, TR: 26, AE: 23, GB: 22, VA: 22, VG: 24, UA: 29, SC: 31, IQ: 23, BY: 28, SV: 28, LY: 25, SD: 18, BI: 27,
  DJ: 27, RU: 33, SO: 23, NI: 28, MN: 20, FK: 18, OM: 23, YE: 30, HN: 28,
};

/**
 * MN: BBAN = 4!n (банкны код) + 12!n (данс) — зөвхөн цифр. Бүртгэлийн хуудас BBAN бүтцийг өгдөггүй;
 * 20 урт ба жишээний цифрээс гаргасан таамаг (DECISIONS-д бүртгэнэ).
 */
const MN_IBAN_RE = /^MN\d{18}$/;
const IBAN_SHAPE_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
/** Оролтын дээд урт: үүнээс урт нь дансны дугаар биш */
const ACCOUNT_MAX_INPUT_LENGTH = 64;

/** IBAN хэлбэртэй ('MN12...' ) бол том үсэг, зайгүй хувилбарыг буцаана; үгүй бол null. Кирилл look-alike (МН) латин болно. */
function ibanCandidate(input: string): string | null {
  if (typeof input !== 'string') return null;
  const s = input.normalize('NFKC').replace(INVISIBLE_CHARS_RE, '').trim();
  if (s === '' || s.length > ACCOUNT_MAX_INPUT_LENGTH) return null;
  const compact = foldCyrillicLookalikesToLatin(s.replace(/^iban\s*[:\uFF1A]?\s*/i, '').replace(/[\s\-._]/g, '').toUpperCase());
  return IBAN_SHAPE_RE.test(compact) ? compact : null;
}

/** mod-97-10: тоон үлдэгдлийг цифр цифрээр тооцно (BigInt-гүй). Зөв IBAN → 1. */
function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const code = rearranged.charCodeAt(i);
    rem = code <= 57 ? (rem * 10 + code - 48) % 97 : (rem * 100 + code - 55) % 97; // A=10 ... Z=35
  }
  return rem;
}

/**
 * Дансны дугаарыг каноник болгоно: IBAN бол ТОМ ҮСЭГ, зайгүй ('mn12 3456...' → 'MN123456...'); дотоодын данс бол зөвхөн цифр
 * ('5011-234 567' → '5011234567'). Хэт урт (> 64) эсвэл string биш оролтод ''.
 */
export function normalizeAccountNo(input: string): string {
  if (typeof input !== 'string') return '';
  const iban = ibanCandidate(input);
  if (iban) return iban;
  const s = input.normalize('NFKC');
  return s.length > ACCOUNT_MAX_INPUT_LENGTH ? '' : s.replace(/\D/g, '');
}

/** IBAN-ы бүтэн шалгалт: бүртгэлийн улсын урт, MN-ийн цифр бүтэц, шалгах цифр 02..98, mod-97-10 = 1. */
export function isValidIban(input: string): boolean {
  const iban = ibanCandidate(input);
  if (!iban) return false;
  const country = iban.slice(0, 2);
  if (IBAN_LENGTHS[country] !== iban.length) return false;
  if (country === 'MN' && !MN_IBAN_RE.test(iban)) return false;
  const check = Number(iban.slice(2, 4));
  return check >= 2 && check <= 98 && mod97(iban) === 1;
}
