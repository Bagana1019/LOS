// FR-11.4 Баталгаажуулах код: 12 тэмдэгт Crockford base32 (I L O U-гүй), 60 бит санамсаргүй. Ungrouped хэлбэрээр хадгална,
// хүнд `XXXX-XXXX-XXXX` хэлбэрээр харуулна. QR payload: `${ESIGN_PUBLIC_BASE_URL}/verify/${code}`.
import { randomBytes } from 'node:crypto';

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const VERIFICATION_CODE_LENGTH = 12;
const GROUP_SIZE = 4;
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

export function generateVerificationCode(): string {
  // 256 нь 32-д хуваагддаг тул `byte & 31` нь хазайлтгүй (modulo bias байхгүй)
  const bytes = randomBytes(VERIFICATION_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += CROCKFORD_ALPHABET[byte & 31];
  return code;
}

export function isVerificationCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_SHAPE.test(value);
}

/** `7K3QXM9ZB4TN` → `7K3Q-XM9Z-B4TN`. Хэлбэр буруу бол алдаа (дуудагч өөрийн үүсгэсэн кодыг л дамжуулна) */
export function formatVerificationCode(code: string): string {
  if (!isVerificationCode(code)) throw new TypeError('verification code must be 12 Crockford base32 characters');
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += GROUP_SIZE) groups.push(code.slice(i, i + GROUP_SIZE));
  return groups.join('-');
}

/**
 * Хэрэглэгчийн оруулсан кодыг (бүлэглэсэн/бүлэглээгүй, жижиг үсэг, зайтай) хадгалсан хэлбэрт буцаана; хүчингүй бол `null`.
 * Crockford-ийн тохиролцоо: O→0, I/L→1 (хүн андуурч бичих үсэг). Үүсгэсэн код эдгээр тэмдэгтийг агуулдаггүй тул хоёрдмол утгагүй.
 */
export function parseVerificationCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_SHAPE.test(cleaned) ? cleaned : null;
}
