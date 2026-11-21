// F11-4(b): Excel татах файлын нэр. Монгол тайлангийн нэрийг RFC 5987 `filename*`-ээр, ASCII нөөцийг `filename`-ээр өгнө.
// Node нь >255 кодтой тэмдэгттэй толгойг няцаадаг тул `filename` заавал ASCII; `filename*` нь percent-encoded тул ASCII.
const ILLEGAL_IN_FILENAME = /[\\/:*?"<>|\p{Cc}]/gu;
const compactDate = (asOf: string): string => asOf.replace(/-/g, '');

/** ASCII нөөц нэр: LOS_<key>_<asOf YYYYMMDD>.xlsx */
export const exportAsciiName = (key: string, asOf: string): string => `LOS_${key}_${compactDate(asOf)}.xlsx`;

/** Хэрэглэгчид харагдах нэр: <монгол тайлангийн нэр>_<asOf YYYYMMDD>.xlsx. Файлын нэрэнд хориотой тэмдэгтийг зайгаар солино. */
export function exportDisplayName(title: string, asOf: string): string {
  const safe = title.replace(ILLEGAL_IN_FILENAME, ' ').replace(/\s+/g, ' ').trim() || 'Тайлан';
  return `${safe}_${compactDate(asOf)}.xlsx`;
}

/** RFC 5987 attr-char-д ордоггүй ' ( ) * тэмдэгтүүдийг encodeURIComponent орхидог тул нэмж encode хийнэ. */
const rfc5987 = (s: string): string => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * `filename*` ЭХЭНД: RFC 6266 дагуу хоёуланг нь ойлгодог клиент `filename*`-ийг сонгоно; web `apiDownload`-ийн regex хамгийн зүүн утгыг авдаг тул мөн монгол нэр гарна.
 * ASCII нөөцөд ASCII биш, `"`, `\` тэмдэгт байвал `_` болгоно (толгойг хэзээ ч эвдэхгүй).
 */
export function contentDisposition(asciiFallback: string, displayName: string): string {
  const fallback = asciiFallback.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename*=UTF-8''${rfc5987(displayName)}; filename="${fallback}"`;
}
