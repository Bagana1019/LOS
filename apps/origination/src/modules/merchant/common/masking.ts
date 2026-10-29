// POS-BR-7: PII API/лог/event-д зөвхөн маскалж гарна.

/** `УЕ12345601` → `УЕ******01` (эхний 2 үсэг + од + сүүлийн 2 цифр). */
export function maskRegister(register: string): string {
  const chars = Array.from(register.trim().toUpperCase());
  if (chars.length <= 4) return '*'.repeat(chars.length);
  return `${chars.slice(0, 2).join('')}${'*'.repeat(chars.length - 4)}${chars.slice(-2).join('')}`;
}

/** `99112233` → `99****33` (эхний 2 + сүүлийн 2 цифр). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\s+/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`;
}

/** Дансны дугаар → `****1234`. Зөвхөн сүүлийн 4 цифр хадгалагдана/харагдана. */
export function maskAccountLast4(last4OrAccount: string): string {
  return `****${last4OrAccount.slice(-4)}`;
}

export function last4(accountNo: string): string {
  return accountNo.slice(-4);
}

// ───────────── Чөлөөт текстээс PII арилгах (POS-BR-7) ─────────────
// Defense-in-depth: кассир/хянагч регистр, утсыг дураар (зайтай, зураастай, латин үсэгтэй, +976 угтвартай) бичиж болно.
// Нэг regex-ийн 3 салаа: (lease) лизингийн дугаар — ХАМГААЛАГДАНА (өөрчлөхгүй), (register), (phone). Зүүнээс баруун скан хийх тул лизингийн дугаар түрүүлж идэгдэнэ.
// Худал эерэг бага байлгана: 8-аас цөөн/олон цифртэй дүн (1 500 000, 2,400,000, 226943.03), огноо, цаг, UUID-г хөндөхгүй.
const REGISTER_LETTER = String.raw`[A-Za-zА-ЯӨҮЁа-яөүё]`; // латин ижил дүрс (U/E/Y/O …) орно
const PII_IN_TEXT = new RegExp(
  [
    String.raw`(?<lease>\bPOS-\d{6}-[0-9A-Z]{6}\b)`,
    // Регистр: тусдаа үг (өмнө нь үсэг/цифр биш) 2 үсэг + (≤2 зай/зураас/цэг/_) + 8 цифр (цифр хооронд нэг зай/зураас/цэг зөвшөөрнө) — эсвэл өмнөх шиг үгийн дундах кирилл 2 үсэг + 8 цифр
    String.raw`(?<register>(?<![\p{L}\d])${REGISTER_LETTER}{2}[\s.\-_/]{0,2}\d(?:[\s.\-]?\d){7}|[А-ЯӨҮЁа-яөүё]{2}\d{8})`,
    // Утас: [6-9]-ээр эхэлсэн 8 цифр (бүтнээрээ | 4-4 | 2-2-2-2 цэгтэй | зай/зураастай дурын бүлэглэлт), +976 / 00976 / (976) / 976 угтвартай байж болно
    String.raw`(?<phone>(?<!\d)(?:\(?(?:(?:\+|00)\s?)?976\)?[\s.\-]*)?(?:[6-9]\d(?:[\s\-]?\d){6}|[6-9]\d{3}\.\d{4}|[6-9]\d(?:\.\d{2}){3})(?!\d))`,
  ].join('|'),
  'gu',
);
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g; // нуугдмал тэмдэгтээр цифрийг таслахаас хамгаална

/**
 * Чөлөөт текст (алдааны мессеж, цуцлалтын шалтгаан, хянагчийн тайлбар …) дахь регистр/утсыг маскална.
 * Эхлээд NFKC (бүтэн өргөнтэй цифр/үсэг → ердийн) + нуугдмал тэмдэгт арилгана. Утасны +976 угтвар хасагдаж `99****33` болно.
 */
export function scrubPii(text: string): string {
  const clean = text.normalize('NFKC').replace(INVISIBLE, '');
  return clean.replace(PII_IN_TEXT, (match, ...args: unknown[]) => {
    const groups = args[args.length - 1] as { lease?: string; register?: string; phone?: string };
    if (groups.lease !== undefined) return match;
    const digits = match.replace(/\D/g, '');
    if (groups.register !== undefined) return maskRegister(`${match.slice(0, 2)}${digits}`);
    return maskPhone(digits.slice(-8));
  });
}
