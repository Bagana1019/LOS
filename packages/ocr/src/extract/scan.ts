// Текст доторх бүтэцтэй утгуудыг хайх (регистр, IBAN, утас, дүн, огноо). Бүгд хязгаарлагдмал квантортой regex;
// оролтын текст нь хуудасны OCR (≤ хэдэн мянган тэмдэгт). Олдсон хэсгийг maskSpans-аар далдалж дараагийн хайлтад давхардуулахгүй.
import { findDates, isValidIban, normalizeAccountNo, parseMnAmount, parseRegisterNo, type RegisterNoInfo } from '../text';
import { IBAN_LENGTHS } from '../text/account';
import { foldCyrillicLookalikesToLatin } from '../text/script';

export interface Span {
  start: number;
  end: number;
  raw: string;
}

/** Олдсон хэсгүүдийг ЯГ ИЖИЛ урттай зайгаар солино (шинэ мөр хэвээр) — offset өөрчлөгдөхгүй. */
export function maskSpans(text: string, spans: readonly Span[]): string {
  let out = text;
  for (const s of spans) out = out.slice(0, s.start) + out.slice(s.start, s.end).replace(/[^\n]/g, ' ') + out.slice(s.end);
  return out;
}

// ---- Регистр ----
// 2-3 үсэг (3 дахь нь OCR-ийн илүү тэмдэгт байж болно) + зөвшөөрөгдөх тусгаарлагч + 8 цифр-тэй тэмдэгт (цифр ба O/I/l/S/B)
const REGISTER_RE = /(?<![\p{L}\p{N}])([\p{L}]{2,3})[ \-._]{0,2}((?:[0-9OoОоIlSB][ \-._]?){7}[0-9OoОоIlSB])(?!\d)/gu;

export interface RegisterCandidate extends Span {
  info: RegisterNoInfo;
  /** Үсгийн хэсэг 3 тэмдэгт байсан тул эхний 2-г авсан */
  extraLetter: boolean;
  /** Латин 'B' байсан тул Б/В ойлгомжгүй — боломжит өөр үсэг */
  alternatives: string[];
}

/** Бүх бүтцийн хувьд тохирох регистрийн нэр дэвшигч (valid эсэхийг info.valid-д). Хуулбар текстийг ашиглана (numText БИШ). */
export function findRegisterCandidates(text: string): RegisterCandidate[] {
  const out: RegisterCandidate[] = [];
  for (const m of text.matchAll(REGISTER_RE)) {
    const letters = m[1];
    const digits = m[2].replace(/[ \-._]/g, '');
    const tries = letters.length === 3 ? [letters.slice(0, 2), letters.slice(1)] : [letters];
    let info: RegisterNoInfo = parseRegisterNo(`${tries[0]}${digits}`);
    let used = tries[0];
    for (const t of tries) {
      const r = parseRegisterNo(`${t}${digits}`);
      if (r.valid) {
        info = r;
        used = t;
        break;
      }
    }
    const start = m.index ?? 0;
    const alternatives: string[] = [];
    if (info.valid && info.value && used.includes('B')) alternatives.push(`${info.value.slice(0, 2).replace(/В/g, 'Б')}${info.value.slice(2)}`);
    out.push({ start, end: start + m[0].length, raw: m[0], info, extraLetter: letters.length === 3, alternatives });
  }
  return out;
}

// ---- IBAN ----
const IBAN_RE = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){11,32}(?![A-Za-z0-9])/g;

/** Баталгаажсан IBAN-ууд (mod-97). Кирилл look-alike (А, В, Е, К, М, О, Р, С, Т, Х...) латин болгож хайна ('МN' = кирилл М + латин N); offset хадгална. */
export function findIbans(text: string): Array<Span & { iban: string }> {
  const latin = foldCyrillicLookalikesToLatin(text);
  const out: Array<Span & { iban: string }> = [];
  for (const m of latin.matchAll(IBAN_RE)) {
    const base = m.index ?? 0;
    const positions: number[] = [];
    for (let i = 0; i < m[0].length; i++) if (m[0][i] !== ' ') positions.push(base + i);
    const expected = IBAN_LENGTHS[m[0].slice(0, 2).toUpperCase()];
    if (!expected || positions.length < expected) continue;
    const used = positions.slice(0, expected);
    const compact = used.map((p) => latin[p]).join('').toUpperCase(); // зөвхөн ASCII тул урт хадгалагдана
    if (!isValidIban(compact)) continue;
    const start = used[0];
    const end = used[used.length - 1] + 1;
    out.push({ start, end, raw: text.slice(start, end), iban: normalizeAccountNo(compact) });
  }
  return out;
}

// ---- Утас ----
// 8 цифр, 6-9-өөр эхлэх; +976 угтвартай/үгүй; 4+4 хэлбэрээр зай/зураастай байж болно
const PHONE_RE = /(?<![\d.,])(?:\+?976[ -]?)?([6-9]\d{3})[ -]?(\d{4})(?!\d)/g;

export function findPhones(text: string): Array<Span & { phone: string }> {
  const out: Array<Span & { phone: string }> = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, raw: m[0], phone: `${m[1]}${m[2]}` });
  }
  return out;
}

// ---- Огноо ----
export function findIsoDates(text: string): Array<Span & { iso: string }> {
  return findDates(text).map((d) => ({ start: d.index, end: d.index + d.raw.length, raw: d.raw, iso: d.iso }));
}

// ---- Цаг ----
const TIME_RE = /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?(?![\d:])/g;

export function findTimes(text: string): Span[] {
  return [...text.matchAll(TIME_RE)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, raw: m[0] }));
}

// ---- Дүн ----
// таслалаар мянгатлагдсан | зайгаар (1+ бүлэг; ганц бүлгийг мөнгөн тэмдэггүй бол хасна) | цэгээр (EU) | энгийн цифр; сүүлд .NN аравтын
const AMOUNT_RE =
  /(?<![\d.,])(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?: \d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d])/g;
// Дүнгийн дараах мөнгөн тэмдэг. Монгол албан бичигт дүнг үсгээр хаалтанд давтдаг: "1,800,000 (нэг сая найман зуун мянган) төгрөг"
const CURRENCY_AFTER_RE = /^\s{0,2}(?:\([^()]{0,100}\)\s{0,2})?(?:₮|т[оө]г(?:р[оө]г)?(?![\p{L}])|mnt(?![\p{L}])|tugrug(?![\p{L}]))/iu;

export interface AmountCandidate extends Span {
  value: number;
  /** Дүнгийн дараа шууд мөнгөн тэмдэг (₮, төгрөг, MNT) байна */
  currency: boolean;
  /** Мянгатын тусгаарлагч эсвэл аравтын хэсэгтэй (мөнгөн дүнгийн хэлбэр) */
  formatted: boolean;
}

export function findAmounts(text: string): AmountCandidate[] {
  const out: AmountCandidate[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const value = parseMnAmount(m[0]);
    if (value === null) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const currency = CURRENCY_AFTER_RE.test(text.slice(end, end + 130));
    // "12 345" (нэг л 3 оронтой бүлэг, зайгаар) нь мөнгөн тэмдэггүй бол хоёрдмол (хоёр тусдаа тоо байж болно) → алгасна
    if (!currency && /^\d{1,3} \d{3}$/.test(m[0])) continue;
    out.push({ start, end, raw: m[0], value, currency, formatted: /[,. ]/.test(m[0]) });
  }
  return out;
}
