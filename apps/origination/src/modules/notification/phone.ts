// FR-13.2: SMS хүлээн авагчийн утсыг E.164 (+976XXXXXXXX) болгон нормчилно. Монголын гар утас 8 оронтой, 5–9-өөр эхэлнэ.

/** "99112233", "9911-2233", "+976 9911 2233", "976 99112233", "00976-99112233" → "+97699112233"; буруу бол null. */
export function normalizeMnPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s\-.()]/g, '');
  if (s.startsWith('+976')) s = s.slice(4);
  else if (s.startsWith('00976')) s = s.slice(5);
  else if (s.startsWith('976') && s.length === 11) s = s.slice(3);
  return /^[5-9]\d{7}$/.test(s) ? `+976${s}` : null;
}

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Имэйлийн энгийн шалгалт (жинхэнэ баталгаажуулалт нь SMTP-ийн хариу). */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  return s && s.length <= 254 && SIMPLE_EMAIL.test(s) ? s : null;
}
