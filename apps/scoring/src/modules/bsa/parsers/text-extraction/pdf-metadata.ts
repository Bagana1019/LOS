// PDF Info толгойн талбар → PdfMetadata (BSA-FR-2.3). Цэвэр функцүүд: огноо ISO болгох, мөр цэвэрлэх.

const MAX_FIELD_LENGTH = 256;
// PDF огноо: D:YYYYMMDDHHmmSSOHH'mm' — сүүлийн хэсгүүд заавал биш; цагийн бүс Z | Z00'00' | +HH'mm' | +HH'mm | +HHmm | +HH
const PDF_DATE_RE = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:Z(?:00'?(?:00'?)?)?|([+-])(\d{2})(?:'?(\d{2})'?)?)?\s*$/i;
const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const MIN_YEAR = 1900;

/**
 * PDF огноог ISO 8601 (UTC, `toISOString`) болгоно. Цагийн бүс заагаагүй бол UTC гэж үзнэ (таамаг).
 * Буруу огноо (13-р сар, 2-р сарын 30, жил < 1900, тоо биш) → null. Зарим үүсгэгч Info-д ISO бичдэг тул ISO-г мөн хүлээн авна.
 */
export function parsePdfDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '') return null;
  const m = PDF_DATE_RE.exec(s);
  if (!m) {
    if (!ISO_LIKE_RE.test(s)) return null;
    const t = Date.parse(s);
    return Number.isNaN(t) || new Date(t).getUTCFullYear() < MIN_YEAR ? null : new Date(t).toISOString();
  }
  const [year, month, day, hour, minute, second] = [m[1], m[2] ?? '01', m[3] ?? '01', m[4] ?? '00', m[5] ?? '00', m[6] ?? '00'].map(Number);
  if (year < MIN_YEAR) return null;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC нь 2-р сарын 30-ыг 3-р сар болгодог тул бүрэлдэхүүнийг буцааж тулгана
  if (
    local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day ||
    local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second
  ) return null;
  let offsetMinutes = 0;
  if (m[7]) {
    const oh = Number(m[8]);
    const om = m[9] === undefined ? 0 : Number(m[9]);
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (m[7] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return new Date(local.getTime() - offsetMinutes * 60_000).toISOString();
}

/** Info дахь мөр талбар: хоосон/мөр биш → null; удирдлагын тэмдэгт хасч, урт нь хязгаарлагдана. */
export function pdfInfoString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s.slice(0, MAX_FIELD_LENGTH);
}
