// Хуулгын хамрах хугацааны шинжилгээ (BSA-FR-2.4): дутуу сар, цоорхой, давхцал + давхцсан хуулгын давхар мөрийг арилгах түлхүүр.
// Цэвэр функцууд (өгөгдөл → тайлан). Данс/банкны мэдээллийг лог руу бичихгүй: тайланд ердөө дуудагчийн өгсөн шошго буцна.
import { toMatchKey } from '@los/ocr';
import type { ParsedTransaction } from './statement.types';

/** Анхдагч — НЭГ газар (дуудагч дарж болно) */
export const COVERAGE_DEFAULTS = {
  /** Энэ ба түүнээс богино хоосон хугацааг цоорхой гэж тоолохгүй (хуулгын хугацаа эхний/сүүлийн гүйлгээнээс уламжилсан үед) */
  gapToleranceDays: 0,
};
export type CoverageOptions = typeof COVERAGE_DEFAULTS;

export interface StatementPeriod {
  /** YYYY-MM-DD (оролцсон) */
  from: string;
  /** YYYY-MM-DD (оролцсон) */
  to: string;
  bank?: string;
  account?: string;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface CoverageGap extends DateRange {
  /** Тодорхой дансны завсар (account/bank шошго); бүх хуулгаар нийтдээ хамрагдаагүй хугацаа бол байхгүй */
  account?: string;
}

export interface CoverageOverlap extends DateRange {
  /** Давхцсан хуулгууд хамаарах дансны шошго(ууд). Данс тодорхойгүй хуулгууд бол хоосон */
  accounts: string[];
}

export interface CoverageReport {
  /** Шаардсан хугацааны хэдэн календарь сар БҮРЭН хамрагдсан */
  coveredMonths: number;
  /** Бүрэн хамрагдаагүй сарууд 'YYYY-MM' */
  missingMonths: string[];
  /** Шаардсан хугацаанд ямар ч хуулгаар хамрагдаагүй завсрууд (нэгтгэсэн), хугацааны дарааллаар */
  gaps: CoverageGap[];
  /** Нэг дансны хоёр ба түүнээс олон хуулга давхцсан муж (шаардсан хугацаагаар хязгаарласан) */
  overlaps: CoverageOverlap[];
  /** "N сарын хуулга дутуу" — missingMonths.length */
  shortfallMonths: number;
  /** Нэг данс доторх хуулгуудын завсар (өөр данс нөхсөн ч): "тухайн дансны X сарын хуулга дутуу" */
  accountGaps: CoverageGap[];
  /** Буруу огноотой/эргэсэн (from > to) тул орхигдсон хугацааны тоо */
  ignoredPeriods: number;
}

const DAY_MS = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD → өдрийн дугаар (UTC), буруу бол null */
function dayOf(iso: string): number | null {
  const m = ISO_RE.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

const isoOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
const monthKey = (day: number): string => isoOf(day).slice(0, 7);

interface Span {
  from: number;
  to: number;
}

/** Эрэмбэлж, зэргэлдээ/давхцсан (завсар ≤ tolerance) хэсгүүдийг нэгтгэнэ */
function mergeSpans(spans: Span[], tolerance: number): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from - last.to - 1 <= tolerance) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/** merged (эрэмбэтэй, нэгтгэсэн) хэсгүүдээс window дотор үлдсэн хоосон хэсгүүд */
function uncovered(merged: Span[], window: Span): Span[] {
  const out: Span[] = [];
  let cursor = window.from;
  for (const s of merged) {
    if (s.to < window.from) continue;
    if (s.from > window.to) break;
    if (s.from > cursor) out.push({ from: cursor, to: Math.min(s.from - 1, window.to) });
    cursor = Math.max(cursor, s.to + 1);
    if (cursor > window.to) break;
  }
  if (cursor <= window.to) out.push({ from: cursor, to: window.to });
  return out;
}

const clip = (s: Span, window: Span): Span | null => {
  const from = Math.max(s.from, window.from);
  const to = Math.min(s.to, window.to);
  return from <= to ? { from, to } : null;
};

/** ≥2 хуулгад хамрагдсан хэсгүүд (sweep) */
function overlapSpans(spans: Span[]): Span[] {
  const events: Array<[number, number]> = [];
  for (const s of spans) events.push([s.from, 1], [s.to + 1, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ижил өдөр: -1 түрүүлж (өмнөх дууссаны дараа)
  const out: Span[] = [];
  let count = 0;
  let start = 0;
  for (const [day, delta] of events) {
    const before = count;
    count += delta;
    if (before < 2 && count >= 2) start = day;
    else if (before >= 2 && count < 2) out.push({ from: start, to: day - 1 });
  }
  return mergeSpans(out, 0);
}

const labelOf = (p: StatementPeriod): string => [p.bank, p.account].filter((x): x is string => !!x).join(':');

/**
 * Хуулгын хамрах хугацааг шаардсан хугацаатай тулгана. Сар = календарь сар (шаардсан хугацаатай огтлолцсон хэсэг нь БҮТЭН
 * хамрагдсан бол л хамрагдсан). Хуулгууд бүх дансны нэгдлээр хамрах хугацааг тооцно; давхцал зөвхөн НЭГ дансны хуулгуудын
 * хооронд (өөр дансны хуулга зэрэгцээ байх нь хэвийн). Буруу огноотой хуулгыг орхиж ignoredPeriods-д тоолно. Шаардсан хугацаа
 * буруу бол RangeError.
 */
export function analyzeCoverage(
  periods: StatementPeriod[],
  required: DateRange,
  options: Partial<CoverageOptions> = {},
): CoverageReport {
  const tolerance = Math.max(0, options.gapToleranceDays ?? COVERAGE_DEFAULTS.gapToleranceDays);
  const reqFrom = dayOf(required.from);
  const reqTo = dayOf(required.to);
  if (reqFrom === null || reqTo === null || reqFrom > reqTo) throw new RangeError('required period is invalid');
  const window: Span = { from: reqFrom, to: reqTo };

  let ignored = 0;
  const valid: Array<{ span: Span; key: string; label: string }> = [];
  for (const p of periods) {
    const from = dayOf(p.from);
    const to = dayOf(p.to);
    if (from === null || to === null || from > to) {
      ignored++;
      continue;
    }
    valid.push({ span: { from, to }, key: `${p.bank ?? ''}|${p.account ?? ''}`, label: labelOf(p) });
  }

  // ---- Нэгдсэн хамрах хугацаа → сар, цоорхой ----
  const union = mergeSpans(valid.map((v) => v.span), tolerance);
  const gaps: CoverageGap[] = uncovered(union, window).map((g) => ({ from: isoOf(g.from), to: isoOf(g.to) }));

  const missingMonths: string[] = [];
  let covered = 0;
  const first = new Date(reqFrom * DAY_MS);
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth();
  for (;;) {
    const start = Math.round(Date.UTC(year, month, 1) / DAY_MS);
    const end = Math.round(Date.UTC(year, month + 1, 0) / DAY_MS);
    if (start > reqTo) break;
    const part = clip({ from: start, to: end }, window);
    if (part) {
      if (uncovered(union, part).length === 0) covered++;
      else missingMonths.push(monthKey(part.from));
    }
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }

  // ---- Данс тутмын давхцал, завсар ----
  const byKey = new Map<string, Array<{ span: Span; label: string }>>();
  for (const v of valid) {
    const list = byKey.get(v.key) ?? [];
    list.push({ span: v.span, label: v.label });
    byKey.set(v.key, list);
  }
  const overlaps: CoverageOverlap[] = [];
  const accountGaps: CoverageGap[] = [];
  for (const list of byKey.values()) {
    const label = list[0].label;
    for (const o of overlapSpans(list.map((x) => x.span))) {
      const c = clip(o, window);
      if (c) overlaps.push({ from: isoOf(c.from), to: isoOf(c.to), accounts: label ? [label] : [] });
    }
    if (list.length >= 2) {
      const merged = mergeSpans(list.map((x) => x.span), tolerance);
      const inner: Span = { from: merged[0].from, to: merged[merged.length - 1].to };
      for (const g of uncovered(merged, inner)) {
        const c = clip(g, window);
        if (c) accountGaps.push({ from: isoOf(c.from), to: isoOf(c.to), ...(label ? { account: label } : {}) });
      }
    }
  }
  overlaps.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.accounts.join().localeCompare(b.accounts.join()));
  accountGaps.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return { coveredMonths: covered, missingMonths, gaps, overlaps, shortfallMonths: missingMonths.length, accountGaps, ignoredPeriods: ignored };
}

// ---- Давхар мөр (хоёр хуулга давхцахад) ----

export type DedupeInput = Pick<ParsedTransaction, 'txnDate' | 'txnTime' | 'amount' | 'direction' | 'balanceAfter' | 'description'>;

/**
 * Гүйлгээг ижилсүүлэх тогтвортой түлхүүр: (огноо, цаг:минут, дүн, чиглэл, үлдэгдэл, нормчилсон утга). Утгыг toMatchKey-ээр
 * нормчилдог тул кирилл/латин, том/жижиг, илүү зай хамаарахгүй. Түлхүүр нь PII агуулна (утга) — лог руу бичихгүй.
 */
export function dedupeKey(t: DedupeInput): string {
  const time = t.txnTime ? t.txnTime.slice(0, 5) : '';
  const balance = t.balanceAfter === null ? '' : t.balanceAfter.toFixed(2);
  return [t.txnDate, time, t.amount.toFixed(2), t.direction, balance, toMatchKey(t.description)].join('|');
}

/**
 * Давхцсан хуулгуудаас давхар мөрийг хасна. Хуулга БҮРИЙН дотор давтагдсан мөр жинхэнэ (ижил дүнтэй хоёр төлбөр) байж болох тул
 * түлхүүр бүрийн хамгийн их давтамжийг (multiset union) үлдээнэ — зөвхөн ӨӨР хуулгад давхар орсныг хасна.
 * Хуулгуудын дарааллыг, хуулга доторх дарааллыг хадгална.
 */
export function dedupeAcrossStatements<T extends DedupeInput>(statements: T[][]): { merged: T[]; dropped: number } {
  const kept = new Map<string, number>();
  const merged: T[] = [];
  let dropped = 0;
  for (const list of statements) {
    const prior = new Map(kept);
    const local = new Map<string, number>();
    for (const t of list) {
      const key = dedupeKey(t);
      const n = (local.get(key) ?? 0) + 1;
      local.set(key, n);
      if (n > (prior.get(key) ?? 0)) {
        merged.push(t);
        kept.set(key, Math.max(kept.get(key) ?? 0, n));
      } else dropped++;
    }
  }
  return { merged, dropped };
}
