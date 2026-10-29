import { z } from 'zod';
import { BlacklistEntryInput, BlacklistEntryUpdate } from '@los/contracts';
import { normalizeRegisterNo } from '@los/database';

/** Жагсаалтын дээд offset (хуудаслалт). */
export const MAX_LIST_OFFSET = 1_000_000;

/** FR-13.1: нэг импортод орох дээд мөр (CSV-ийн body дээд хэмжээ нь csv-body.middleware.ts-д). */
export const MAX_IMPORT_ROWS = 5000;

// Нормчлогч (normalizeRegisterNo) дараах тэмдэгтүүдийг ЧИМЭЭГҮЙ хаядаг: тусгаарлагч (зай, зураас, _ . / ,) болон үл үзэгдэх Cf.
// Бусад тэмдэгт (? * # ( ) U+FFFD гэх мэт) үсэг/цифр биш тул hash-ээс алга болж, kyc-д хэзээ ч таарахгүй хуурамч CLEAR үүсгэнэ.
const SEPARATORS = /[\s\p{Pd}_./,]/gu;
const INVISIBLE = /\p{Cf}/gu;
const LETTERS_DIGITS_MARKS = /^[\p{L}\p{Nd}\p{M}]*$/u;
const MODIFIER_LETTER = /\p{Lm}/u;

/**
 * Тусгаарлагч (+ үл үзэгдэх) тэмдэгтийг л хасахад үлдсэн бүх тэмдэгт нормчлогдсон хэлбэрт үсэг/цифрээр үлдэх эсэх.
 * NFKC-г эхэлж хийнэ (нормчлогчтой адил): fullwidth зураас/зай тусгаарлагч болно, "½" шиг тэмдэгт "1⁄2" болж "⁄"-ээр илэрнэ.
 * Mark (нийлэхгүй үлдсэн) нь нормчлогчид хэвийн хаягддаг, үсэг/цифр алдагдуулахгүй тул зөвшөөрнө; \p{Lm} нь нормчлогчид хаягддаг тул үгүй.
 */
export function hasOnlyRegisterChars(registerNo: string): boolean {
  const rest = registerNo.replace(INVISIBLE, '').normalize('NFKC').replace(SEPARATORS, '');
  return LETTERS_DIGITS_MARKS.test(rest) && !MODIFIER_LETTER.test(rest);
}

// "---" шиг тэмдэгт нормчлогдоод хоосон болвол hash нь бүх ийм регистрт таарна.
const hasContent = (registerNo: string) => normalizeRegisterNo(registerNo).length > 0;

/** Contracts-ийн схем дээр нэмэх регистрийн шалгалт (POST, PATCH, импортын мөр бүр). */
function checkRegister(registerNo: string, ctx: z.RefinementCtx): void {
  const path = ['registerNo'];
  if (!hasOnlyRegisterChars(registerNo)) ctx.addIssue({ code: 'custom', path, message: 'registerNo contains unsupported characters' });
  else if (!hasContent(registerNo)) ctx.addIssue({ code: 'custom', path, message: 'registerNo must contain letters or digits' });
}

export const BlacklistCreateBody = BlacklistEntryInput.superRefine((v, ctx) => checkRegister(v.registerNo, ctx));
export const BlacklistPatchBody = BlacklistEntryUpdate.superRefine((v, ctx) => {
  if (v.registerNo !== undefined) checkRegister(v.registerNo, ctx);
});

/** JSON импорт: мөр бүр тусдаа шалгагдах тул энд зөвхөн массив эсэхийг шалгана. */
export const BlacklistImportJsonBody = z.object({ rows: z.array(z.unknown()) });

export const BlacklistListQuery = z.object({
  q: z.string().trim().max(200).optional().transform((v) => v || undefined),
  listType: z.string().trim().max(32).optional().transform((v) => v?.toUpperCase() || undefined),
  isActive: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Хэт том offset нь Prisma/Postgres-д 500 өгдөг тул дээд хязгаартай.
  offset: z.coerce.number().int().min(0).max(MAX_LIST_OFFSET).default(0),
});
export type BlacklistListQuery = z.infer<typeof BlacklistListQuery>;
