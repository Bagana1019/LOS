// M10 — клиентийн утга (зам, header, username) Postgres-ийн хүлээж авахгүй тэмдэгтээр poison аудит мөр болохоос сэргийлнэ:
// NUL (22021) хасна, ганц UTF-16 surrogate (jsonb 22P05) → U+FFFD, урт хязгаарлана (surrogate хос таслахгүй).
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const HIGH_AT_END = /[\uD800-\uDBFF]$/;
const MAX_DEPTH = 8;

export function cleanText(s: string, max = Number.POSITIVE_INFINITY): string {
  const t = s.split(NUL).join('').replace(LONE_SURROGATE, '�');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return HIGH_AT_END.test(cut) ? cut.slice(0, -1) : cut;
}

export const cleanTextOpt = (s: string | null | undefined, max?: number): string | null => (s == null ? null : cleanText(s, max));

/** JSON payload-ын бүх string утга ба түлхүүрийг цэвэрлэнэ (бүтэц, тоо, boolean хэвээр). */
export function cleanJson(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return cleanText(v);
  if (v === null || typeof v !== 'object' || depth > MAX_DEPTH) return v;
  if (Array.isArray(v)) return v.map((x) => cleanJson(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [cleanText(k), cleanJson(x, depth + 1)]));
}
