// BSA-BR-3: шинжилгээний хугацааг тодорхойлох цэвэр функцүүд (огноо = 'YYYY-MM-DD', UTC). I/O, цаг, санамсаргүй утга байхгүй.
//  - MONTHS: «сүүлийн N сар» — хуулгын хамрах хугацааны төгсгөлд дуусна. Сарын сүүлийн өдөр бол N БҮТЭН сар (Apr 1..Sep 30), эс бол
//    (төгсгөл − N сар + 1 өдөр). Хоёулаа @los/calc periodMonthsBetween-ээр N гарна.
//  - EXPLICIT: хэрэглэгчийн өгсөн муж; хуулгын хамрах хугацаанаас хэтэрвэл богиносгоно (BSA-BR-3 «хуулгын хугацаанаас хэтрэхгүй»).
//  - AUTO: хугацаа өгөөгүй — тохиргооны зөвшөөрөгдсөн сарын жагсаалтаас minStatementMonths-ээс багагүй хамгийн бага нь.
import { periodMonthsBetween } from '@los/calc';
import type { BsaAnalysisWarning } from '@los/contracts';
import { isIsoDate } from '../dti';
import type { BsaSettings } from '../common/infra.ports';

export interface DateSpan {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const toUtc = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string => fromUtc(toUtc(iso) + days * DAY_MS);

/** Сарын сүүлийн өдөр эсэх */
export const isMonthEnd = (iso: string): boolean => addDays(iso, 1).slice(8, 10) === '01';

/** Сар нэмнэ; өдөр сарын уртыг давбал сарын сүүлийн өдөр (01-31 + 1 сар = 02-28) */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(ny, nm, Math.min(d, last)));
}

/** `to`-д дуусах N сарын цонхны эхлэл (дээрх дүрэм) */
export function windowStart(to: string, months: number): string {
  if (isMonthEnd(to)) {
    const first = `${to.slice(0, 7)}-01`;
    return addMonths(first, -(months - 1));
  }
  return addDays(addMonths(to, -months), 1);
}

/** Хоёр мужийн огтлолцол; байхгүй бол null */
export function intersect(a: DateSpan, b: DateSpan): DateSpan | null {
  const from = a.from > b.from ? a.from : b.from;
  const to = a.to < b.to ? a.to : b.to;
  return from <= to ? { from, to } : null;
}

export type PeriodMode = 'MONTHS' | 'EXPLICIT' | 'AUTO';

export interface PeriodRequest {
  periodMonths: number | null;
  periodFrom: string | null;
  periodTo: string | null;
}

export interface ResolvedPeriod extends DateSpan {
  /** @los/calc-ийн периодMonthsBetween (дундажлах хуваагч) */
  months: number;
  mode: PeriodMode;
  requestedMonths: number | null;
  clamped: boolean;
  warnings: BsaAnalysisWarning[];
}

/** Хугацааны хүсэлтийг үндэслэн «зөвшөөрөгдсөн сар» дүрмийг шалгах (service-ийн оролтод) */
export function isAllowedMonths(months: number, settings: Pick<BsaSettings, 'allowedPeriodMonths'>): boolean {
  return Number.isInteger(months) && settings.allowedPeriodMonths.includes(months);
}

/** Тохиргооны анхдагч сар: minStatementMonths-ээс багагүй хамгийн бага зөвшөөрөгдсөн; байхгүй бол хамгийн их нь */
export function defaultPeriodMonths(settings: Pick<BsaSettings, 'allowedPeriodMonths' | 'minStatementMonths'>): number {
  const sorted = [...settings.allowedPeriodMonths].sort((a, b) => a - b);
  return sorted.find((m) => m >= settings.minStatementMonths) ?? sorted[sorted.length - 1];
}

export function validExplicitPeriod(from: string | null, to: string | null): boolean {
  return from !== null && to !== null && isIsoDate(from) && isIsoDate(to) && from <= to;
}

/**
 * Хүсэлт + хуулгын хамрах хугацаа → бодит хугацаа. `coverage` = бүх COMPLETED хуулгын нэгдсэн [эхлэл, төгсгөл] (дотор нь завсар байж болно).
 * Хамрах хугацаа байхгүй бол null (тооцоолох юм алга).
 */
export function resolvePeriod(
  request: PeriodRequest,
  coverage: DateSpan | null,
  settings: Pick<BsaSettings, 'allowedPeriodMonths' | 'minStatementMonths'>,
): ResolvedPeriod | null {
  if (coverage === null) return null;
  const warnings: BsaAnalysisWarning[] = [];
  const explicit = validExplicitPeriod(request.periodFrom, request.periodTo) && request.periodMonths === null;

  if (explicit) {
    const want: DateSpan = { from: request.periodFrom as string, to: request.periodTo as string };
    const inter = intersect(want, coverage);
    if (inter === null) {
      warnings.push({
        code: 'PERIOD_OUTSIDE_COVERAGE',
        message: 'Сонгосон хугацаа хуулгын хамрах хугацаатай огт огтлолцохгүй тул хуулгын бүх хугацааг ашиглалаа.',
      });
      return { ...coverage, months: periodMonthsBetween(coverage.from, coverage.to), mode: 'EXPLICIT', requestedMonths: null, clamped: true, warnings };
    }
    const clamped = inter.from !== want.from || inter.to !== want.to;
    if (clamped) {
      warnings.push({ code: 'PERIOD_CLAMPED', message: 'Сонгосон хугацаа хуулгын хамрах хугацаанаас хэтэрсэн тул хуулгын хугацаагаар хязгаарлалаа.' });
    }
    return { ...inter, months: periodMonthsBetween(inter.from, inter.to), mode: 'EXPLICIT', requestedMonths: periodMonthsBetween(want.from, want.to), clamped, warnings };
  }

  const requested = request.periodMonths;
  const months = requested ?? defaultPeriodMonths(settings);
  const to = coverage.to;
  const start = windowStart(to, months);
  const clamped = start < coverage.from;
  const from = clamped ? coverage.from : start;
  if (clamped) {
    warnings.push({
      code: 'PERIOD_CLAMPED',
      message: `Хүссэн ${months} сарын хугацаанд хуулга дутуу тул хуулгын боломжит хугацаагаар (${periodMonthsBetween(from, to)} сар) тооцлоо.`,
    });
  }
  return { from, to, months: periodMonthsBetween(from, to), mode: requested === null ? 'AUTO' : 'MONTHS', requestedMonths: requested ?? months, clamped, warnings };
}
