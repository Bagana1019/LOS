// FR-11.4 Гарын үсэг зурагчийн таних мэдээлэл: регистр нормчлох/тулгах, PII далдлах. CLAUDE.md §6.5 — регистр, утас, нэрийг
// лог/алдаа/audit/public хариунд ЗӨВХӨН энд буй далдалсан хэлбэрээр л гаргана.
import { createHash, timingSafeEqual } from 'node:crypto';

/** Кирилл үсэгтэй ижил харагддаг латин үсгүүд (хэрэглэгч, provider-ийн гэрчилгээ аль алинд нь андуурагддаг) */
const LATIN_TO_CYRILLIC: Readonly<Record<string, string>> = {
  A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х', Y: 'У',
};
// Зай, тусгаарлагч зураас (бүх төрлийн), үл үзэгдэх тэмдэгтүүд
const REGISTER_NOISE = /[\s\p{Pd}\u200B-\u200D\u2060\uFEFF]+/gu;
const MASK = '****';

/** Хоосон зай/зураас хасаж, том үсэг болгож, латин look-alike-ыг кирилл болгоно. Жишээ: `уа 12345678`, `UA-12345678` → `УА12345678` */
export function normalizeRegister(input: string): string {
  const upper = input.normalize('NFC').replace(REGISTER_NOISE, '').toUpperCase();
  let folded = '';
  for (const char of upper) folded += LATIN_TO_CYRILLIC[char] ?? char;
  return folded;
}

/** Нормчилсон хэлбэрээр нь тогтмол хугацаанд тулгана. Аль нэг нь хоосон бол үргэлж `false` */
export function registersMatch(a: string, b: string): boolean {
  const left = normalizeRegister(a);
  const right = normalizeRegister(b);
  // Урт ялгаатай байсан ч timingSafeEqual ажиллахын тулд тогтмол урттай digest-ээр тулгана
  const equal = timingSafeEqual(createHash('sha256').update(left, 'utf8').digest(), createHash('sha256').update(right, 'utf8').digest());
  return equal && left !== '';
}

/** `УА12345678` → `УА****5678` (эхний 2 + сүүлийн 4). Богино (<8) бол бүгдийг далдална — уртыг ч илрүүлэхгүй */
export function maskRegister(register: string): string {
  const chars = Array.from(normalizeRegister(register));
  if (chars.length < 8) return MASK;
  return `${chars.slice(0, 2).join('')}${MASK}${chars.slice(-4).join('')}`;
}

/** `99112233` / `+97699112233` → `+976 ****2233` (сүүлийн 4 цифр) */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length < 4 ? `+976 ${MASK}` : `+976 ${MASK}${digits.slice(-4)}`;
}

/** `Бат-Эрдэнэ Болд` → `Б. Болд` (эхний үгийн үсэг + сүүлийн үг); нэг үгтэй бол `Б***` */
export function maskName(fullName: string): string {
  const words = fullName.normalize('NFC').trim().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return MASK;
  const initial = Array.from(words[0])[0].toUpperCase();
  if (words.length === 1) return `${initial}***`;
  return `${initial}. ${words[words.length - 1]}`;
}
