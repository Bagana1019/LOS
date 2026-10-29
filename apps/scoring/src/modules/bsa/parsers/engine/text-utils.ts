// Мөр/нүд/дүнгийн жижиг цэвэр туслахууд (engine дотор л ашиглана). Бүх regex хязгаарлагдмал → урт адверсари мөрөнд шугаман.
import { normalizeAccountNo, parseMnAmount, parseTime } from '@los/ocr';
import type { StatementTextLine } from '../statement.types';
import type { EngineConfig } from './defaults';

/** Мөрийг хязгаартай урттай болгоно */
export const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

/**
 * Мөрийн нүднүүд. Олон нүдтэй бол PDF/OCR/CSV-ийн нүдийг (хоосон нүдийг ч) хэвээр; нэг нүдтэй бол TAB эсвэл 2+ зайгаар таслана
 * (plain text dump); тасарсангүй бол [бүтэн мөр] (token горим).
 */
export function rowCells(line: StatementTextLine, cfg: EngineConfig): string[] {
  if (line.cells.length > 1) return line.cells.map((c) => clip(c, cfg.maxCellLength));
  const text = clip(line.cells.length === 1 ? line.cells[0] : line.text, cfg.maxLineLength).trim();
  const parts = text.split(/\t| {2,}/);
  return parts.length > 1 ? parts : [text];
}

/** Хоосон, зураас ('-', '–', '—'), цэг: "энэ нүдэнд утга байхгүй" */
export const isBlankish = (s: string): boolean => /^[\s\-‐-―−.]*$/.test(s);

export interface AmountCell {
  /** Тэмдэгтэй утга ('-500', '(500)' = -500) */
  value: number;
  /** Мянгатын тусгаарлагч/аравтын цэг орсон */
  formatted: boolean;
  /** Задгай бүхэл тоо ≥ idLikeMinDigits — дансны дугаар/ID, дүн биш */
  idLike: boolean;
  /** Задгай бүхэл тоо ≥ plainLongAmountMinDigits — утас/ID байж болно */
  plainLong: boolean;
  /** Тодорхой '+' тэмдэгтэй ('+500.00') — орлогын дохио */
  plus: boolean;
}

/** Нэг нүд/token дүн мөн эсэх. Огноо, цаг, текст, > 15 оронтой тоо → null. */
export function amountCell(raw: string, cfg: EngineConfig): AmountCell | null {
  const s = raw.trim();
  if (s === '' || s.length > 40) return null;
  const value = parseMnAmount(s);
  if (value === null) return null;
  const formatted = /\d[ ,.']\d/.test(s);
  const digits = s.replace(/\D/g, '').length;
  return {
    value,
    formatted,
    idLike: !formatted && digits >= cfg.idLikeMinDigits,
    plainLong: !formatted && digits >= cfg.plainLongAmountMinDigits,
    plus: s.startsWith('+') && value > 0,
  };
}

const TIME_ONLY_RE = /^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,6})?(?: ?[AaPp]\.?[Mm]\.?)?$/;
/** Нүд бүхэлдээ цаг бол 'HH:mm[:ss]', үгүй бол null */
export function timeCell(raw: string): string | null {
  const s = raw.trim();
  return s.length <= 16 && TIME_ONLY_RE.test(s) ? parseTime(s) : null;
}

// ---- Харьцсан данс (гүйлгээний утга/нүднээс) ----
const IBAN_IN_TEXT_RE = /(?<![A-Za-z0-9])MN\d{2}(?: ?\d{4}){4}(?!\d)/;
const ACCOUNT_CUE_RE = /(?:данс|dans|acc|a\/c|account|iban)\W{0,3}$/iu;
const RUN_RE_CACHE = new Map<string, RegExp>();
const COMPACT_DATE_RE = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;

/**
 * Нүд бүхэлдээ дансны дугаар (8-20 цифр эсвэл MN IBAN) бол каноник дугаар, үгүй бол null.
 * dedicated=false (багана тодорхойгүй) үед 8 оронтой [6-9]-өөр эхэлсэн тоог утас гэж үзээд хаяна.
 */
export function accountCell(raw: string, cfg: EngineConfig, dedicated = true): string | null {
  const s = raw.trim();
  if (s.length < cfg.counterpartyAccountDigits.min || s.length > 40) return null;
  const compact = s.replace(/[\s-]/g, '');
  if (/^MN\d{18}$/i.test(compact)) return normalizeAccountNo(compact);
  const { min, max } = cfg.counterpartyAccountDigits;
  if (compact.length < min || compact.length > max || !/^\d+$/.test(compact)) return null;
  return !dedicated && compact.length === 8 && /^[6-9]/.test(compact) ? null : compact;
}

/**
 * Гүйлгээний утгаас харьцсан дансыг олно (docs: 8-20 оронтой цифр). Худал эерэг багасгах: 8 оронтой [6-9]-өөр эхэлсэн тоо = утас
 * (өмнө нь "данс/acc" үг байвал данс), YYYYMMDD огноо, аравтын бутархайн хэсэг, өөр цифрийн дунд байгаа тоо. MN IBAN-г эхэлж хайна.
 */
export function findAccountInText(text: string, cfg: EngineConfig): string | null {
  const iban = IBAN_IN_TEXT_RE.exec(text);
  if (iban) return normalizeAccountNo(iban[0]);
  const { min, max } = cfg.counterpartyAccountDigits;
  const cacheKey = `${min},${max}`;
  let re = RUN_RE_CACHE.get(cacheKey);
  if (!re) RUN_RE_CACHE.set(cacheKey, (re = new RegExp(`(?<![\\d.,])\\d{${min},${max}}(?!\\d|[.,]\\d)`, 'g')));
  for (const m of text.matchAll(re)) {
    const run = m[0];
    if (run.length === 8) {
      if (/^[6-9]/.test(run) && !ACCOUNT_CUE_RE.test(text.slice(Math.max(0, (m.index as number) - 14), m.index))) continue;
      if (COMPACT_DATE_RE.test(run)) continue;
    }
    return run;
  }
  return null;
}

const DECIMAL_AMOUNT_TOKEN_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/;
/** Мөрийн сүүл нь хоёр "аравтын бутархайтай" дүн (дүн + үлдэгдэл) бол гүйлгээний мөр байж болзошгүй (огноо нь уншигдаагүй). Хязгаартай урт. */
export function endsWithAmountPair(text: string): boolean {
  const tail = text.slice(-80).trim().split(/\s+/);
  const n = tail.length;
  return n >= 3 && DECIMAL_AMOUNT_TOKEN_RE.test(tail[n - 1]) && DECIMAL_AMOUNT_TOKEN_RE.test(tail[n - 2]);
}
