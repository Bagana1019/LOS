// SainScore (ЗМС) `inquiry[]` мөр → LOS CIB `ProviderResult` (FR-3.1). Цэвэр функц: I/O байхгүй.
// Мөрийн утга учир (Python лавлагааны domain/services.py + тест fixture-ээс баталгаажсан): dutytype LN (зээл) | LS (лизинг) | LINE (зээлийн шугам),
// cls_status 0 хэвийн | 1 хугацаа хэтэрсэн ≤90 хоног | 2 >90 хоног (vendor хоногийн тоо өгдөггүй), int_rate = жилийн %, maturity_date YYYY-MM-DD | YYYY.MM.DD.
// Зарчим: vendor-т байхгүй зүйлийг ЗОХИОХГҮЙ (null = мэдэгдэхгүй), задлагдахгүй мөрийг чимээгүй алгасаж үүргийг дутуу тооцохгүй (payment_complete=false → WARNING).
import { annuityPayment } from '@los/calc';
import type { InquiryWarningLevel } from '@los/contracts';
import type { ProviderResult } from '../inquiry.provider';

/** Хүүгүй LN-ийн таамагласан хүү (политик) — BR утга тул sainscore.config.ts-ээр env-ээс дарагдана. Анхдагч нь Python лавлагааны утга; бизнесээр батлуулна. */
export interface CibPolicy {
  /** Хүүгүй / 0% LN-д таамагласан сарын хүү (%) */
  assumedMonthlyRatePct: number;
  /** `largeLoanThresholdMnt`-ээс том зээлийн (барьцаатай гэж үзсэн) сарын хүү (%) */
  largeLoanMonthlyRatePct: number;
  largeLoanThresholdMnt: number;
}
export const DEFAULT_CIB_POLICY: CibPolicy = { assumedMonthlyRatePct: 2.5, largeLoanMonthlyRatePct: 1.6, largeLoanThresholdMnt: 50_000_000 };

const ELIGIBLE = new Set(['LN', 'LS', 'LINE']);
type Row = Record<string, unknown>;
type RateSource = 'VENDOR' | 'ASSUMED' | 'UNKNOWN';

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const r2 = (n: number): number => Math.round(n * 100) / 100;
const annual = (monthlyPct: number): number => Number((monthlyPct * 12).toFixed(6)); // 1.6 × 12 = 19.200000000000003 → 19.2

/** Тоо эсвэл тоон string; бусад (null, '', NaN, Infinity) → null. */
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 0 | 1 | 2; задлагдахгүй / тодорхойгүй → null (хоцрогдолгүй гэж таамаглахгүй). */
function overdueClass(v: unknown): 0 | 1 | 2 | null {
  const n = num(v);
  return n === 0 || n === 1 || n === 2 ? n : null;
}

function parseMaturity(v: unknown): { year: number; month: number } | null {
  const m = typeof v === 'string' ? /^(\d{4})([-.])(\d{2})\2(\d{2})$/.exec(v.trim()) : null;
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[3]), Number(m[4])];
  const valid = new Date(Date.UTC(year, month - 1, day));
  return valid.getUTCFullYear() === year && valid.getUTCMonth() === month - 1 && valid.getUTCDate() === day ? { year, month } : null;
}

interface Skipped { loancode: string; dutytype: string; reason: string }

interface Acc {
  loans: Array<Record<string, unknown>>;
  skipped: Skipped[];
  active: number;
  closed: number;
  totalDisbursed: number;
  outstanding: number;
  monthly: number;
  overdueDaysMax: number;
  paymentComplete: boolean;
  attention: boolean;
}

export function mapCibRows(vendor: { decision: string | null; rows: readonly unknown[] }, today: Date, policy: CibPolicy = DEFAULT_CIB_POLICY): ProviderResult {
  const acc: Acc = { loans: [], skipped: [], active: 0, closed: 0, totalDisbursed: 0, outstanding: 0, monthly: 0, overdueDaysMax: 0, paymentComplete: true, attention: false };
  for (const item of vendor.rows) {
    if (!isRow(item)) { acc.skipped.push({ loancode: '', dutytype: '', reason: 'MALFORMED_ROW' }); acc.paymentComplete = false; continue; }
    mapRow(item, today, policy, acc);
  }
  const warningLevel: InquiryWarningLevel = acc.overdueDaysMax > 90 ? 'RED' : acc.overdueDaysMax > 0 || acc.attention || !acc.paymentComplete ? 'WARNING' : 'NONE';
  return {
    summary: {
      active_loan_count: acc.active, open_loan_count: acc.active, closed_loan_count: acc.closed,
      total_disbursed: r2(acc.totalDisbursed), outstanding: r2(acc.outstanding), monthly_payment: r2(acc.monthly),
      overdue_days_max: acc.overdueDaysMax, // доод хязгаар: vendor зөвхөн ангилал (cls_status) өгдөг
      overdue_months: null, inquiries_last_90d: null, // vendor-ийн хариунд байхгүй — зохиохгүй
      payment_complete: acc.paymentComplete,
    },
    detail: { loans: acc.loans, skipped: acc.skipped, inquiryHistory: [], obligations: [], collateral: [], raw: { decision: vendor.decision, inquiry: vendor.rows } },
    warningLevel,
  };
}

function mapRow(item: Row, today: Date, policy: CibPolicy, acc: Acc): void {
  const dutytype = text(item.dutytype);
  const loancode = text(item.loancode);
  if (!ELIGIBLE.has(dutytype)) { acc.skipped.push({ loancode, dutytype, reason: 'INELIGIBLE_DUTYTYPE' }); return; }

  const adv = num(item.adv_amount);
  const balance = num(item.balance);
  const currency = text(item.curr_code).toUpperCase();
  const cls = overdueClass(item.cls_status);
  const closedDate = text(item.closed_date).trim();
  const isLine = dutytype === 'LINE';
  const base = {
    lender: [text(item.clientname), text(item.clientlastname)].map((s) => s.trim()).filter(Boolean).join(' '), kind: dutytype, currency,
    disbursedAmount: adv, outstanding: balance, openedOn: text(item.adv_date) || null, maturityOn: text(item.maturity_date) || null, overdueClass: cls,
  };

  // closed_date + үлдэгдэл > 0 = зөрчилтэй өгөгдөл (дахин бүтэцлэсэн / шилжүүлсэн …): хаагдсан гэж таамаглахгүй, идэвхтэй гэж тоолж анхааруулна.
  const closedWithBalance = closedDate !== '' && balance !== null && balance > 0;
  if ((closedDate !== '' && !closedWithBalance) || (!isLine && balance !== null && balance <= 0)) {
    acc.closed++;
    acc.loans.push({ ...base, status: 'CLOSED', monthlyPayment: 0, annualRatePct: null, rateSource: null });
    return;
  }
  // Үлдэгдэл задлагдахгүй LN/LS-ийг хаагдсан гэж таамаглахгүй (идэвхтэй зээлийг чимээгүй алдах нь үүргийг дутуу тооцно).
  if (!isLine && balance === null) { acc.skipped.push({ loancode, dutytype, reason: 'UNPARSEABLE_BALANCE' }); acc.paymentComplete = false; return; }
  if (isLine && (adv === null || adv < 0)) { acc.skipped.push({ loancode, dutytype, reason: 'UNPARSEABLE_ADV_AMOUNT' }); acc.paymentComplete = false; return; }

  acc.active++;
  if (cls === null) acc.attention = true;
  else acc.overdueDaysMax = Math.max(acc.overdueDaysMax, cls === 2 ? 91 : cls === 1 ? 1 : 0);

  const extra: Record<string, unknown> = closedWithBalance ? { closedDateWithBalance: true } : {};
  if (closedWithBalance) acc.attention = true;
  let monthly = 0;
  let annualRatePct: number | null = null;
  let rateSource: RateSource | null = null;

  if (currency !== 'MNT') {
    // FX хөрвүүлэлтгүй тул MNT нийлбэрт оруулж чадахгүй. Гэхдээ бодит үүрэг — чимээгүй орхихгүй: нийлбэр дутуу гэж тэмдэглэж, анхааруулна.
    extra.excludedFromTotals = 'NON_MNT';
    acc.paymentComplete = false;
    acc.attention = true;
  } else if (isLine) {
    monthly = adv as number; // зээлийн шугам: лимит бүхлээрээ үүрэг
  } else {
    const priced = priceTerm(item, balance as number, adv, today, policy);
    if (priced.kind === 'UNPARSEABLE_MATURITY') { acc.skipped.push({ loancode, dutytype, reason: 'UNPARSEABLE_MATURITY_DATE' }); acc.paymentComplete = false; }
    else {
      ({ annualRatePct, rateSource } = priced);
      monthly = annuityPayment(balance as number, priced.annualRatePct, priced.remainingMonths);
      if (priced.rateSource === 'UNKNOWN') acc.attention = true; // 0% = зөвхөн үндсэн төлбөр → дутуу байж болзошгүй
      if (priced.matured) { extra.matured = true; acc.attention = true; } // хугацаа дууссан боловч үлдэгдэлтэй: 0 БИШ, 1 сарын дотор төлөх үүрэг
    }
  }

  if (currency === 'MNT') {
    acc.totalDisbursed += adv ?? 0;
    acc.outstanding += balance ?? 0;
    acc.monthly += monthly;
  }
  acc.loans.push({ ...base, status: 'ACTIVE', monthlyPayment: monthly, annualRatePct, rateSource, ...extra });
}

type Priced = { kind: 'UNPARSEABLE_MATURITY' } | { kind: 'PRICED'; remainingMonths: number; annualRatePct: number; rateSource: RateSource; matured: boolean };

/** LN/LS: үлдсэн сар (сарын зөрүү, өдрийг үл тооно) ба хүүг тодорхойлно. */
function priceTerm(item: Row, balance: number, adv: number | null, today: Date, policy: CibPolicy): Priced {
  const maturity = parseMaturity(item.maturity_date);
  if (!maturity) return { kind: 'UNPARSEABLE_MATURITY' };
  const monthsToMaturity = (maturity.year - today.getUTCFullYear()) * 12 + (maturity.month - (today.getUTCMonth() + 1));
  // Хугацаа дууссан / энэ сард дуусах (≤ 0): үлдэгдэл ЯГ ОДОО төлөгдөх үүрэг → 1 сарын дотор (0 БИШ). Дараа сарын (үлдсэн 1 сар) дүнтэй тасралтгүй.
  const matured = monthsToMaturity <= 0;
  const remainingMonths = Math.max(monthsToMaturity, 1);

  const vendorRate = num(item.int_rate);
  const stated = vendorRate !== null && vendorRate > 0;
  if (stated) return { kind: 'PRICED', remainingMonths, matured, annualRatePct: vendorRate, rateSource: 'VENDOR' };
  if (item.dutytype === 'LN') {
    // Хүүгүй / 0% LN: 0% нь зөвхөн үндсэн төлбөрт буулган чадавхийг хэтрүүлнэ → таамагласан хүү (Python-той ижил)
    const size = adv ?? balance;
    const monthlyPct = size >= policy.largeLoanThresholdMnt ? policy.largeLoanMonthlyRatePct : policy.assumedMonthlyRatePct;
    return { kind: 'PRICED', remainingMonths, matured, annualRatePct: annual(monthlyPct), rateSource: 'ASSUMED' };
  }
  // LS: vendor 0% гэж тодорхой өгсөн бол тэр (VENDOR 0), үгүй бол мэдэгдэхгүй (UNKNOWN, 0%)
  return { kind: 'PRICED', remainingMonths, matured, annualRatePct: 0, rateSource: vendorRate === 0 ? 'VENDOR' : 'UNKNOWN' };
}
