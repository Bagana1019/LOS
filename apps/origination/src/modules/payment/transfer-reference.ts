// Банкны гүйлгээний утгаас манай senderInvoiceNo (`LOS-<appNo>-<seq>`) болон гэрээний дугаарын нэр дэвшигчийг гаргана. Цэвэр функц.

/** `LOS-APP-00001-1` — том үсгээр нормчилсон текстээс. Хэт шунахай таарсан үед (араас нь үг залгагдсан) сүүлийн сегментүүдийг хасаж богино хувилбаруудыг ч өгнө. */
export function extractInvoiceCandidates(description: string): string[] {
  const text = description.toUpperCase();
  const out: string[] = [];
  for (const m of text.matchAll(/LOS-[A-Z0-9]+(?:-[A-Z0-9]+)*/g)) {
    const parts = m[0].split('-');
    for (let n = parts.length; n >= 3; n--) {
      const candidate = parts.slice(0, n).join('-');
      if (!out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

/** Гэрээний дугаарын нэр дэвшигч: үсэг/цифрийн ≥ 6 тэмдэгттэй токенууд (том үсгээр). */
export function extractContractCandidates(description: string): string[] {
  const tokens = description.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 6 && /\d/.test(t));
  return [...new Set(tokens)];
}
