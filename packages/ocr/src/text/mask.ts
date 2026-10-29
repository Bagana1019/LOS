// Лог дахь хувийн мэдээллийн (регистр, данс, нэр) далд хэлбэр — NFR-3 / CLAUDE.md §6.5. PII-г хэзээ ч бүтнээр нь логлохгүй.

/** Далдлалтын тэмдэгтийн дээд тоо: урт утгын уртыг ил гаргахгүй, лог том болохгүй */
export const MASK_MAX_STARS = 8;

/**
 * Утгыг далдлана: '*' + сүүлийн ≤ 2 тэмдэгт. Богино утга хамаагүй бага ил гаргана (< 4 → 0, 4..7 → 1, ≥ 8 → 2),
 * тиймээс сүүлийн 2 тэмдэгтээс илүүг ХЭЗЭЭ Ч харуулахгүй. Хоосон/string биш оролтод ''.
 */
export function maskForLog(input: string): string {
  if (typeof input !== 'string' || input === '') return '';
  // Урт утгад зөвхөн сүүл хэсэг хэрэгтэй; тэмдэгтийг code point-оор тоолно (surrogate pair таслахгүй)
  const chars = Array.from(input.length > 64 ? input.slice(-64) : input);
  const visible = chars.length >= 8 ? 2 : chars.length >= 4 ? 1 : 0;
  const stars = Math.min(MASK_MAX_STARS, Math.max(1, chars.length - visible));
  return '*'.repeat(stars) + chars.slice(chars.length - visible).join('');
}
