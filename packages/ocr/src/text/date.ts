// Огноо, цаг задлах (BSA-FR-2.2, FR-2.4 хугацаа). Цэвэр функц; цаг/локаль уншихгүй. Бүх regex хязгаарлагдмал квантортой
// (хөндлөнгийн давталтгүй) тул урт адверсари мөрөнд шугаман хугацаанд ажиллана.
import { normalizeWhitespace } from './script';

/** Огнооны оролтын дарааллын ойлголт. 'MDY' нь нэмэлт (AS-IS гэрээнд 'YMD' | 'DMY' байсан — additive). */
export type DateOrder = 'YMD' | 'DMY' | 'MDY';

export interface ParseDateOptions {
  /**
   * Жил СҮҮЛД байгаа тоон огнооны (10/03/2026) өдөр-сарын дараалал: 'DMY' (анхдагч) → өдөр/сар/жил, 'MDY' → сар/өдөр/жил.
   * 'YMD' нь эх сурвалж жил-эхэлсэн гэдгийг мэдэгдэнэ → жил сүүлд байгаа тоон огноо null болно. Жил ЭХЭНД байвал (2026-03-10) үргэлж Y-M-D.
   */
  order?: DateOrder;
}

export interface FoundDate {
  iso: string;
  /** Оролтын мөр доторх эхлэх индекс (UTF-16) */
  index: number;
  raw: string;
}

/** Бодит байдлын шалгалт: статементийн огноо энэ хязгаараас гадуур бол OCR/задлалтын алдаа */
export const DATE_YEAR_MIN = 1900;
export const DATE_YEAR_MAX = 2100;
/** parseDateIso/parseTime-ийн оролтын дээд урт */
export const DATE_MAX_INPUT_LENGTH = 100;

const pad2 = (n: number): string => String(n).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Хуанлийн хувьд зөв өдөр бол 'YYYY-MM-DD', үгүй бол null (2026-02-30 → null). */
export function buildIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < DATE_YEAR_MIN || year > DATE_YEAR_MAX || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

// ---- Тоон хэлбэрүүд (тусгаарлагч: - / . ; хоёр тусгаарлагч ижил) ----
const YMD_CORE = String.raw`(\d{4})([-/.])(\d{1,2})\2(\d{1,2})`;
const DMY_CORE = String.raw`(\d{1,2})([-/.])(\d{1,2})\2(\d{4})`;
// '2026 оны 3 дугаар сарын 10', '2026 оны 03-р сарын 10-ны өдөр', '2026 он 3 сар 10'
const MN_CORE =
  String.raw`(\d{4})\s{0,2}он(?:ы)?\s{0,2}(\d{1,2})\s{0,2}(?:-?\s{0,2}(?:р|дугаар|дүгээр|дахь))?\s{0,2}сар(?:ын)?\s{0,2}(\d{1,2})` +
  String.raw`(?!\d)(?:-?(?:ны|ний|нд))?(?:\s{0,2}өдөр(?:ийн)?)?`;
// Хайлтын хил: өмнө/хойно нь цифр эсвэл "цифр+тусгаарлагч" байж болохгүй (урт тоон дарааллын хэсгийг огноо гэж авахгүй)
const LB = String.raw`(?<!\d)(?<!\d[-/.])`;
const LA = String.raw`(?!\d)(?![-/.]\d)`;

const YMD_ANCHORED = new RegExp(`^${YMD_CORE}`);
const DMY_ANCHORED = new RegExp(`^${DMY_CORE}`);
const MN_ANCHORED = new RegExp(`^${MN_CORE}`, 'iu');
const YMD_SCAN = new RegExp(`${LB}${YMD_CORE}${LA}`, 'g');
const DMY_SCAN = new RegExp(`${LB}${DMY_CORE}${LA}`, 'g');
const MN_SCAN = new RegExp(`(?<!\\d)${MN_CORE}`, 'giu');

// ---- Цаг ----
const TIME_RE = /(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?(?: ?([AaPp])\.?[Mm]\.?)?(?![\d:])/;
const TZ_TAIL_RE = /^ ?(?:Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$/i;

function timeFromMatch(m: RegExpExecArray): string | null {
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] === undefined ? null : Number(m[3]);
  const meridiem = m[4]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || (second !== null && second > 59)) return null;
  return second === null ? `${pad2(hour)}:${pad2(minute)}` : `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

/** Мөр доторх ЭХНИЙ цагийг 'HH:mm' эсвэл 'HH:mm:ss' болгоно ('9:05', '14:25:07.123', '2:25 PM', '2026-03-10 14:25'). 24:00, 12:60 → null. */
export function parseTime(input: string): string | null {
  if (typeof input !== 'string') return null;
  const m = TIME_RE.exec(input.normalize('NFKC'));
  return m ? timeFromMatch(m) : null;
}

/** Огнооны дараах үлдэгдэл: хоосон, эсвэл 'T'/зайгаар тусгаарласан цаг (+ бүс). */
function tailOk(rest: string): boolean {
  if (rest === '') return true;
  if (!/^[Tt ]/.test(rest)) return false;
  const body = rest.slice(1);
  const m = TIME_RE.exec(body);
  return m !== null && m.index === 0 && timeFromMatch(m) !== null && TZ_TAIL_RE.test(body.slice(m[0].length));
}

function applyOrder(a: number, b: number, order: DateOrder): { month: number; day: number } | null {
  if (order === 'DMY') return { day: a, month: b };
  if (order === 'MDY') return { month: a, day: b };
  return null; // 'YMD': жил сүүлд байгаа огноог хүлээн авахгүй
}

/**
 * Огноог 'YYYY-MM-DD' болгоно. Хэлбэр: YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD, DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY,
 * '2026 оны 3 дугаар сарын 10', ISO datetime угтвар ('2026-03-10T12:30:45Z', '10.03.2026 14:25'). Цагийн бүсийг хөрвүүлэхгүй.
 * Хуанлийн хувьд буруу (2026-02-30), 2 оронтой жил, 12/13/2026 (DMY-д сар 13) → null: таамаглахгүй.
 */
export function parseDateIso(input: string, opts: ParseDateOptions = {}): string | null {
  if (typeof input !== 'string') return null;
  const s = normalizeWhitespace(input.normalize('NFKC'));
  if (s === '' || s.length > DATE_MAX_INPUT_LENGTH) return null;
  const order = opts.order ?? 'DMY';

  const ymd = YMD_ANCHORED.exec(s);
  if (ymd) return tailOk(s.slice(ymd[0].length)) ? buildIsoDate(+ymd[1], +ymd[3], +ymd[4]) : null;

  const dmy = DMY_ANCHORED.exec(s);
  if (dmy) {
    const parts = applyOrder(+dmy[1], +dmy[3], order);
    return parts && tailOk(s.slice(dmy[0].length)) ? buildIsoDate(+dmy[4], parts.month, parts.day) : null;
  }

  const mn = MN_ANCHORED.exec(s);
  if (mn) return tailOk(s.slice(mn[0].length)) ? buildIsoDate(+mn[1], +mn[2], +mn[3]) : null;
  return null;
}

/**
 * Мөр доторх бүх зөв огноог олно (OCR текстээс хугацаа тодорхойлоход). Хуанлийн хувьд буруу таарсан хэсэг орхигдоно.
 * Үр дүн давхцахгүй, index өсөхөөр эрэмбэлэгдсэн.
 */
export function findDates(input: string, opts: ParseDateOptions = {}): FoundDate[] {
  if (typeof input !== 'string' || input === '') return [];
  // NFKC индексийг өөрчилж болзошгүй тул оролтыг хэвээр нь (normalize хийхгүй) хайна: raw/index эх мөртэй таарна
  const s = input;
  const order = opts.order ?? 'DMY';
  const found: FoundDate[] = [];
  for (const m of s.matchAll(YMD_SCAN)) {
    const iso = buildIsoDate(+m[1], +m[3], +m[4]);
    if (iso) found.push({ iso, index: m.index as number, raw: m[0] });
  }
  for (const m of s.matchAll(DMY_SCAN)) {
    const parts = applyOrder(+m[1], +m[3], order);
    const iso = parts && buildIsoDate(+m[4], parts.month, parts.day);
    if (iso) found.push({ iso, index: m.index as number, raw: m[0] });
  }
  for (const m of s.matchAll(MN_SCAN)) {
    const iso = buildIsoDate(+m[1], +m[2], +m[3]);
    if (iso) found.push({ iso, index: m.index as number, raw: m[0] });
  }
  // Хил (LB/LA) ба хэлбэрүүдийн бүтцээс болж өөр өөр хэлбэр хоорондоо давхцдаггүй (date.test.ts-д санамсаргүй нийлүүлэлтээр шалгасан)
  return found.sort((a, b) => a.index - b.index);
}
