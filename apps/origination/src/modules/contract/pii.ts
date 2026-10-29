// Хувийн мэдээллийг лог/алдаа/хариунд ХЭЗЭЭ Ч бүтнээр нь гаргахгүй — CLAUDE.md §6.5.
/** Утасны дугаарын сүүлийн 4 оронг л үлдээнэ: `****2233`. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `****${digits.slice(-4)}`;
}

/** Алдааны нэр (message-гүй) — гуравдагч талын алдаа PII/URL агуулж болзошгүй тул логт зөвхөн нэрийг бичнэ. */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
