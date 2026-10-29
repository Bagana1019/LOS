// BSA DTI тооцоолол (docs/02 §4, BSA-FR-4, BSA-BR-1…4). Цэвэр функц — I/O байхгүй; BR утгууд параметрээр ирнэ.
// `dti.ts` (weightedIncome / dtiIncome / dti)-ийн томьёог энд Decimal-аар (float drift-гүй) давтаж бүтэн шинжилгээг тооцно.
import Decimal from 'decimal.js';
import type { BsaScoringInput } from '@los/contracts';
import type { ScoreRequest } from '@los/contracts';
import type { SoscoInput } from './sosco-score';

export type BsaDtiRole = 'INCOME' | 'DEBT_SERVICE' | 'HOUSEHOLD' | 'BUSINESS_EXPENSE' | 'EXCLUDE' | 'INFO';
export type BsaDtiLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** dtiPercent-ийг JSON-д сериалчлахын тулд хязгаарлах дээд утга (DTI орлого ≤ 0 үед Infinity болдог) */
export const DTI_PERCENT_CAP = 999.9;

/** Ангилал тус бүрийн сарын нийлбэр. Өөрийн данс хоорондын шилжүүлгийг (isOwnTransfer) эндээс өмнө нь хассан байна. */
export interface BsaCategoryMonthly {
  code: string;
  name: string;
  direction: 'INCOME' | 'EXPENSE';
  groupCode: string;
  /** Дайчлах хувь 0..1 (зарлагад 1) */
  weight: number;
  dtiRole: BsaDtiRole;
  /** 'YYYY-MM' → тухайн сарын нийлбэр дүн (эерэг) */
  monthly: Record<string, number>;
  txnCount: number;
}

export interface BsaDtiParams {
  /** YYYY-MM-DD, хоёулаа оролцоно */
  periodFrom: string;
  periodTo: string;
  /** Санал болгосон сарын төлбөр (LOS ЭТХ-ээс, BSA-FR-4.8) */
  proposedMonthlyPayment: number;
  /** ББӨ 0..1 (BSA-BR-1) */
  costOfGoodsRate: number;
  /** ӨОХ-ийн дээд хязгаар 0..1 (BSA-BR-2, анхдагч 0.55) */
  maxDti: number;
  /** ratio ≤ lowMax → LOW; ≤ mediumMax → MEDIUM; бусад HIGH */
  levelThresholds: { lowMax: number; mediumMax: number };
  /** ЦМУ-д орох бизнесийн орлогын ангиллын кодууд */
  businessIncomeCodes: string[];
  /** Орлогын найдварыг бууруулах (хэвийн бус/тогтмол бус/сэжигтэй) ангиллын кодууд (BSA-BR-4) */
  irregularIncomeCodes: string[];
  /** Найдварын 3 бүрдлийн жин (нийлбэр 1) */
  reliabilityWeights: { frequency: number; consistency: number; cleanliness: number };
}

export interface BsaCategorySummary {
  code: string;
  name: string;
  direction: 'INCOME' | 'EXPENSE';
  groupCode: string;
  weight: number;
  dtiRole: BsaDtiRole;
  totalAmount: number;
  monthlyAvg: number;
  /** monthlyAvg × weight (зарлагад monthlyAvg) */
  weightedMonthly: number;
  /** Орлого/зарлага гарсан сарын тоо */
  monthsPresent: number;
  txnCount: number;
  /** Чиглэлийнхээ нийт дүнд эзлэх хувь 0..1 */
  share: number;
}

/** BSA-FR-4.3: тооцооллын аргачлал алхам бүрээр ил (audit trail) */
export interface BsaMethodologyStep {
  step: number;
  key: string;
  label: string;
  formula: string;
  inputs: Record<string, number | string>;
  value: number;
}

export interface BsaDtiResult {
  /** Дундажлах хуваагч: round(өдрийн тоо / 30.4375), доод тал нь 1 */
  periodMonths: number;
  /** Хугацаанд хамрагдсан хуанлийн сарууд 'YYYY-MM' */
  monthKeys: string[];
  /** Бүх INCOME-role ангиллын сарын дундаж нийлбэр (жингүй) */
  totalMonthlyIncome: number;
  /** Жинлэсэн орлого = Σ(monthlyAvg × weight) (docs/02: "баталгаажсан орлого") */
  verifiedMonthlyIncome: number;
  /** verifiedMonthlyIncome × (1 − ББӨ) */
  dtiIncome: number;
  /** Дайчилсан бизнесийн орлого (businessIncomeCodes) */
  businessIncomeMonthly: number;
  /** BUSINESS_EXPENSE role-ын сарын дундаж */
  businessExpenseMonthly: number;
  /** ЦМУ = businessIncomeMonthly − businessExpenseMonthly */
  netCashFlowMonthly: number;
  /** DEBT_SERVICE role-ын сарын дундаж */
  existingDebtServiceMonthly: number;
  /** HOUSEHOLD role-ын сарын дундаж */
  householdExpenseMonthly: number;
  /** 0..100, 1 орон (BSA-BR-4) */
  incomeReliability: number;
  /** (proposed + existingDebtService) / dtiIncome; dtiIncome ≤ 0 үед Infinity */
  dtiRatio: number;
  /** dtiRatio × 100, 1 оронд, DTI_PERCENT_CAP-аар хязгаарлагдсан */
  dtiPercent: number;
  dtiLevel: BsaDtiLevel;
  /** dtiRatio ≤ maxDti */
  meetsLimit: boolean;
  categories: BsaCategorySummary[];
  methodology: BsaMethodologyStep[];
}

// ───────────────────────── Дотоод туслахууд (экспортлогдохгүй) ─────────────────────────

/** Хуанлийн сарын дундаж өдөр = 365.25 / 12 (дундажлах хуваагч; docs/02 §7: 2026-03-10..2026-09-10 → 6) */
const DAYS_PER_MONTH = 30.4375;
const MS_PER_DAY = 86_400_000;
/** reliabilityWeights нийлбэрийн зөвшөөрөгдөх хазайлт (BSA-BR-4) */
const WEIGHT_SUM_TOLERANCE = 1e-9;
const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
/** dtiRole тодорхой чиглэлтэй: INCOME → орлого; DEBT_SERVICE/HOUSEHOLD/BUSINESS_EXPENSE → зарлага (EXCLUDE/INFO аль ч чиглэлд болно) */
const ROLE_DIRECTION: Partial<Record<BsaDtiRole, 'INCOME' | 'EXPENSE'>> = {
  INCOME: 'INCOME', DEBT_SERVICE: 'EXPENSE', HOUSEHOLD: 'EXPENSE', BUSINESS_EXPENSE: 'EXPENSE',
};

/** Глобал Decimal тохиргоонд нөлөөлөхгүй тусдаа clone: 40 орон, ROUND_HALF_UP (мөнгө бүх хэмжээнд float-гүй) */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Бүрэн нарийвчлалтай утгыг тайланд гаргахдаа нэг л удаа бөөрөнхийлнө; `+ 0` нь -0-г 0 болгоно */
const round = (x: Decimal, dp: number): number => x.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toNumber() + 0;
const money = (x: Decimal): number => round(x, 2);
const sumOf = (xs: Iterable<number | Decimal>): Decimal => {
  let s = new D(0);
  for (const x of xs) s = s.plus(x);
  return s;
};

function assertAmount(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a finite number >= 0, got ${v}`);
}

function assertUnit(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`${name} must be a number within 0..1, got ${v}`);
}

interface ParsedDate { year: number; month: number; day: number; dayNumber: number }

/** Зөвхөн бодит хуанлийн 'YYYY-MM-DD' (UTC; цагийн бүс/DST нөлөөлөхгүй) */
function parseDate(label: string, iso: string): ParsedDate {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new RangeError(`${label} must be a YYYY-MM-DD date, got "${String(iso).slice(0, 32)}"`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(0);
  t.setUTCFullYear(year, month - 1, day);
  // 2026-02-30 шиг байхгүй өдөр дараагийн сар руу гүйдэг → өдөр таарахгүй
  if (t.getUTCDate() !== day) throw new RangeError(`${label} is not a calendar date: "${iso}"`);
  return { year, month, day, dayNumber: t.getTime() / MS_PER_DAY };
}

const monthKey = (index: number): string =>
  `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;

/** Хугацааны шалгалт + өдөр, дундажлах хуваагч, хуанлийн сарууд (BSA-BR-3) */
function analyzePeriod(from: string, to: string): { days: number; periodMonths: number; monthKeys: string[]; reliabilityMonthKeys: string[] } {
  const start = parseDate('period start', from);
  const end = parseDate('period end', to);
  if (start.dayNumber > end.dayNumber) throw new RangeError(`period start ${from} is after period end ${to}`);
  const days = end.dayNumber - start.dayNumber + 1;
  const monthKeys: string[] = [];
  for (let i = start.year * 12 + start.month - 1; i <= end.year * 12 + end.month - 1; i++) monthKeys.push(monthKey(i));
  // BSA-BR-4: хугацаа сарын дундаас эхэлбэл/дуусвал эхний/сүүлийн сар хэсэгчилсэн — тогтмол цалинг «байхгүй сар» гэж
  // буруу үзэхгүйн тулд найдварыг зөвхөн бүтэн сараар үнэлнэ. Бүтэн сар 2-оос цөөн бол бүх сарыг үнэлнэ (илүү мэдээлэл байхгүй).
  const lastDay = new Date(Date.UTC(end.year, end.month, 0)).getUTCDate();
  const full = monthKeys.filter((_, i) => !(i === 0 && start.day > 1) && !(i === monthKeys.length - 1 && end.day < lastDay));
  return { days, periodMonths: Math.max(1, Math.round(days / DAYS_PER_MONTH)), monthKeys, reliabilityMonthKeys: full.length >= 2 ? full : monthKeys };
}

function assertLevelThresholds(t: { lowMax: number; mediumMax: number }): void {
  assertAmount('levelThresholds.lowMax', t.lowMax);
  assertAmount('levelThresholds.mediumMax', t.mediumMax);
  if (t.lowMax > t.mediumMax) throw new RangeError(`levelThresholds.lowMax (${t.lowMax}) must not exceed mediumMax (${t.mediumMax})`);
}

function assertReliabilityWeights(w: BsaDtiParams['reliabilityWeights']): void {
  assertUnit('reliabilityWeights.frequency', w.frequency);
  assertUnit('reliabilityWeights.consistency', w.consistency);
  assertUnit('reliabilityWeights.cleanliness', w.cleanliness);
  const total = w.frequency + w.consistency + w.cleanliness;
  if (Math.abs(total - 1) > WEIGHT_SUM_TOLERANCE) throw new RangeError(`reliabilityWeights must sum to 1 (+-1e-9), got ${total}`);
}

function assertParams(p: BsaDtiParams): void {
  assertAmount('proposedMonthlyPayment', p.proposedMonthlyPayment);
  assertUnit('costOfGoodsRate', p.costOfGoodsRate);
  assertUnit('maxDti', p.maxDti);
  assertLevelThresholds(p.levelThresholds);
  assertReliabilityWeights(p.reliabilityWeights);
}

function assertMonthKeys(monthKeys: string[]): void {
  if (monthKeys.length === 0) throw new RangeError('monthKeys must not be empty');
  if (new Set(monthKeys).size !== monthKeys.length) throw new RangeError('monthKeys must be unique');
  for (const k of monthKeys) if (!MONTH_KEY.test(k)) throw new RangeError(`month key must be YYYY-MM, got "${String(k).slice(0, 32)}"`);
}

/** Ангиллын оролтын шалгалт. Алдаатай оролтыг чимээгүй залруулахгүй — RangeError (мөнгөн тооцоонд чимээгүй буруу байж болохгүй). */
function assertCategories(categories: BsaCategoryMonthly[], monthKeys: string[], allowOtherMonths = false): void {
  const allowedMonths = new Set(monthKeys);
  const codes = new Set<string>();
  for (const c of categories) {
    if (codes.has(c.code)) throw new RangeError(`duplicate category code "${c.code}"`);
    codes.add(c.code);
    assertUnit(`category ${c.code} weight`, c.weight);
    if (!Number.isInteger(c.txnCount) || c.txnCount < 0) {
      throw new RangeError(`category ${c.code} txnCount must be an integer >= 0, got ${c.txnCount}`);
    }
    const requiredDirection = ROLE_DIRECTION[c.dtiRole];
    if (requiredDirection && requiredDirection !== c.direction) {
      throw new RangeError(`category ${c.code}: dtiRole ${c.dtiRole} requires direction ${requiredDirection}, got ${c.direction}`);
    }
    for (const [key, amount] of Object.entries(c.monthly)) {
      // BSA-BR-3: хугацаанаас гадуурх сарын дүн дундажийг бүдгэрүүлнэ → дуудагч өдрөөр шүүх ёстой
      if (!allowOtherMonths && !allowedMonths.has(key)) throw new RangeError(`category ${c.code}: month ${key} is outside the analysis period`);
      assertAmount(`category ${c.code} amount for ${key}`, amount);
    }
  }
}

interface ReliabilityParts { frequency: Decimal; consistency: Decimal; cleanliness: Decimal; score: number }

/**
 * BSA-BR-4. Баталгаажсан орлого = INCOME-role, weight > 0 ангиллын (дүн × weight), сар бүрээр.
 * cleanliness-ийн verifiedGross = irregular-д ороогүй, weight > 0 INCOME-role ангиллын жингүй нийт дүн (irregular-тай огтлолцохгүй).
 */
function reliabilityParts(categories: BsaCategoryMonthly[], params: BsaDtiParams, monthKeys: string[]): ReliabilityParts {
  const irregularCodes = new Set(params.irregularIncomeCodes);
  const verifiedByMonth = monthKeys.map(() => new D(0));
  let verifiedGross = new D(0);
  let irregular = new D(0);
  for (const c of categories) {
    if (c.dtiRole !== 'INCOME') continue;
    const total = sumOf(monthKeys.map((k) => c.monthly[k] ?? 0)); // зөвхөн үнэлэгдэх саруудын дүн
    if (irregularCodes.has(c.code)) irregular = irregular.plus(total);
    else if (c.weight > 0) verifiedGross = verifiedGross.plus(total);
    if (c.weight > 0) {
      monthKeys.forEach((k, i) => { verifiedByMonth[i] = verifiedByMonth[i].plus(new D(c.monthly[k] ?? 0).mul(c.weight)); });
    }
  }
  const n = monthKeys.length;
  const verifiedTotal = sumOf(verifiedByMonth);
  const none = { frequency: new D(0), consistency: new D(0), cleanliness: new D(0), score: 0 };
  if (verifiedTotal.lte(0)) return none; // Баталгаажсан орлого байхгүй бол 0
  const mean = verifiedTotal.div(n);
  // Популяцийн стандарт хазайлт (÷ n), 0-тэй сар оролцоно
  const sigma = sumOf(verifiedByMonth.map((v) => v.minus(mean).pow(2))).div(n).sqrt();
  const frequency = new D(verifiedByMonth.filter((v) => v.gt(0)).length).div(n);
  const consistency = D.max(0, new D(1).minus(sigma.div(mean))); // 1 − CV ≤ 1 (CV ≥ 0) тул дээд заагийг тусад нь тавихгүй
  const cleanliness = new D(1).minus(irregular.div(verifiedGross.plus(irregular))); // verified > 0 ⇒ хуваагч > 0
  const w = params.reliabilityWeights;
  const score = round(frequency.mul(w.frequency).plus(consistency.mul(w.consistency)).plus(cleanliness.mul(w.cleanliness)).mul(100), 1);
  return { frequency, consistency, cleanliness, score };
}

// ───────────────────────────────── Экспортлогдох функцууд ─────────────────────────────────

/** Хоёр огнооны хоорондох хуанлийн сарууд ('YYYY-MM'), хоёр үзүүр оролцоно. */
export function monthKeysBetween(from: string, to: string): string[] {
  return analyzePeriod(from, to).monthKeys;
}

/** round(өдөр(from..to хоёул оролцоно) / 30.4375), доод тал нь 1. 2026-03-10..2026-09-10 → 6 */
export function periodMonthsBetween(from: string, to: string): number {
  return analyzePeriod(from, to).periodMonths;
}

/** BSA-BR-2: ratio ≤ lowMax → LOW; ≤ mediumMax → MEDIUM; бусад (Infinity орно) HIGH. Босго буруу бол RangeError. */
export function classifyDtiLevel(ratio: number, t: { lowMax: number; mediumMax: number }): BsaDtiLevel {
  assertLevelThresholds(t);
  if (!(ratio >= 0)) throw new RangeError(`ratio must be a number >= 0 (Infinity allowed), got ${ratio}`); // NaN-г мөн барина
  if (ratio <= t.lowMax) return 'LOW';
  return ratio <= t.mediumMax ? 'MEDIUM' : 'HIGH';
}

/**
 * BSA-BR-4: найдвар % = 100 × (wF·frequency + wC·consistency + wK·cleanliness)
 *  - frequency   = баталгаажсан орлого (weight>0) гарсан сар / хугацааны сарын тоо
 *  - consistency = clamp(1 − CV, 0, 1); CV = σ/μ (сар бүрийн жинлэсэн баталгаажсан орлого, 0-тэй сар оролцоно)
 *  - cleanliness = 1 − irregular / (verifiedGross + irregular); irregularIncomeCodes-ын нийт дүн
 * Баталгаажсан орлого байхгүй бол 0.
 * "Хугацааны сарын тоо" = дуудагчийн өгсөн monthKeys.length. computeBsaDti нь хэсэгчилсэн эхний/сүүлийн сарыг хасаж
 * (бүтэн сар ≥ 2 бол) зөвхөн бүтэн саруудыг дамжуулдаг.
 */
export function incomeReliability(categories: BsaCategoryMonthly[], params: BsaDtiParams, monthKeys: string[]): number {
  assertMonthKeys(monthKeys);
  assertReliabilityWeights(params.reliabilityWeights);
  // monthKeys нь ҮНЭЛЭХ саруудын дэд олонлог (бүтэн сар) байж болно — бусад сарын дүн зүгээр л тооцогдохгүй
  assertCategories(categories, monthKeys, true);
  return reliabilityParts(categories, params, monthKeys).score;
}

/**
 * docs/02 §4 + BSA-FR-4: ангилалын сарын нийлбэрээс DTI-ийн бүтэн үр дүн.
 *  - Тооцоо бүхэлдээ Decimal (40 орон); мөнгө 2 орон, хувь 1 орон (ROUND_HALF_UP) —
 *    тайлагдах утга бүр бүрэн нарийвчлалаас НЭГ удаа бөөрөнхийлөгдөнө.
 *  - dtiRole EXCLUDE (өөрийн данс гэх мэт) хаана ч тооцогдохгүй: нийлбэр, share, найдвар. categories[]-д харин жагсагдана
 *    (share = 0, weightedMonthly = 0).
 *  - dtiIncome ≤ 0 үед: төлбөр > 0 → dtiRatio = Infinity (dtiPercent = DTI_PERCENT_CAP); төлбөр огт байхгүй (0/0) → 0, LOW.
 *  - meetsLimit нь бөөрөнхийлөөгүй dtiRatio-оор шийдэгдэнэ (dtiPercent 55.0 харагдаж ч 55.04% бол false).
 * Алдаатай оролт (огноо, жин/ББӨ ∉ 0..1, сөрөг дүн, хугацаанаас гадуурх сар, давхардсан код…) → RangeError.
 */
export function computeBsaDti(categories: BsaCategoryMonthly[], params: BsaDtiParams): BsaDtiResult {
  const { days, periodMonths, monthKeys, reliabilityMonthKeys } = analyzePeriod(params.periodFrom, params.periodTo);
  assertParams(params);
  assertCategories(categories, monthKeys);

  const pm = new D(periodMonths);
  const businessCodes = new Set(params.businessIncomeCodes);
  const rows = categories.map((c) => {
    const total = sumOf(Object.values(c.monthly));
    const avg = total.div(pm);
    // Зарлагад дайчлах хувь байхгүй (monthlyAvg); EXCLUDE юунд ч нөлөөлөхгүй тул 0
    const weighted = c.dtiRole === 'EXCLUDE' ? new D(0) : c.direction === 'INCOME' ? avg.mul(c.weight) : avg;
    return { c, total, avg, weighted, monthsPresent: Object.values(c.monthly).filter((v) => v > 0).length };
  });
  type Row = (typeof rows)[number];
  const where = (pred: (r: Row) => boolean) => rows.filter(pred);
  const inRole = (role: BsaDtiRole) => where((r) => r.c.dtiRole === role);
  const sumAvg = (rs: Row[]) => sumOf(rs.map((r) => r.avg));
  const sumWeighted = (rs: Row[]) => sumOf(rs.map((r) => r.weighted));

  // BSA-FR-4.3 / docs/02 §4 томьёо
  const incomeRows = inRole('INCOME');
  const totalIncome = sumAvg(incomeRows);
  const verifiedIncome = sumWeighted(incomeRows);
  const dtiIncome = verifiedIncome.mul(new D(1).minus(params.costOfGoodsRate)); // BSA-BR-1
  const businessIncomeRows = incomeRows.filter((r) => businessCodes.has(r.c.code));
  const businessIncome = sumWeighted(businessIncomeRows);
  const businessExpenseRows = inRole('BUSINESS_EXPENSE');
  const businessExpense = sumAvg(businessExpenseRows);
  const netCashFlow = businessIncome.minus(businessExpense);
  const debtRows = inRole('DEBT_SERVICE');
  const debtService = sumAvg(debtRows);
  const householdRows = inRole('HOUSEHOLD');
  const household = sumAvg(householdRows);

  // BSA-BR-2: DTI = (санал болгосон төлбөр + өрийн үйлчилгээ) ÷ DTI орлого
  const numerator = new D(params.proposedMonthlyPayment).plus(debtService);
  const dtiRatio = dtiIncome.gt(0) ? numerator.div(dtiIncome).toNumber() : numerator.gt(0) ? Infinity : 0;
  const dtiPercent = Number.isFinite(dtiRatio) ? Math.min(DTI_PERCENT_CAP, round(new D(dtiRatio).mul(100), 1)) : DTI_PERCENT_CAP;
  const dtiLevel = classifyDtiLevel(dtiRatio, params.levelThresholds);
  const meetsLimit = dtiRatio <= params.maxDti;
  const reliability = reliabilityParts(categories, params, reliabilityMonthKeys);

  // Чиглэл бүрийн нийт дүн (EXCLUDE-ээс бусад, INFO орно) — share-ийн суурь
  const directionTotal = (direction: BsaCategoryMonthly['direction']): Decimal =>
    sumOf(where((r) => r.c.direction === direction && r.c.dtiRole !== 'EXCLUDE').map((r) => r.total));
  const base = { INCOME: directionTotal('INCOME'), EXPENSE: directionTotal('EXPENSE') };

  const summaries: BsaCategorySummary[] = rows.map((r) => ({
    code: r.c.code,
    name: r.c.name,
    direction: r.c.direction,
    groupCode: r.c.groupCode,
    weight: r.c.weight,
    dtiRole: r.c.dtiRole,
    totalAmount: money(r.total),
    monthlyAvg: money(r.avg),
    weightedMonthly: money(r.weighted),
    monthsPresent: r.monthsPresent,
    txnCount: r.c.txnCount,
    share: r.c.dtiRole === 'EXCLUDE' || base[r.c.direction].isZero() ? 0 : r.total.div(base[r.c.direction]).toNumber(),
  }));
  // Орлого түрүүлж, дараа нь зарлага; тус бүр totalAmount буурахаар, тэнцвэл код өсөхөөр (код давтагдахгүй тул тодорхой)
  const directionRank = (c: BsaCategorySummary): number => (c.direction === 'INCOME' ? 0 : 1);
  summaries.sort((a, b) => directionRank(a) - directionRank(b) || b.totalAmount - a.totalAmount || (a.code < b.code ? -1 : 1));

  // BSA-FR-4.3: аргачлал алхам бүрээр
  const methodology: BsaMethodologyStep[] = [];
  const add = (key: string, label: string, formula: string, inputs: BsaMethodologyStep['inputs'], value: number): void => {
    methodology.push({ step: methodology.length + 1, key, label, formula, inputs, value });
  };
  const pct = (x: number): number => new D(x).mul(100).toNumber();
  const reliabilityPct = (x: Decimal): number => round(x.mul(100), 1);
  const w = params.reliabilityWeights;
  const monthlyIncome = money(totalIncome);
  const verified = money(verifiedIncome);
  const dtiIncomeOut = money(dtiIncome);
  const businessIncomeOut = money(businessIncome);
  const businessExpenseOut = money(businessExpense);
  const debtServiceOut = money(debtService);

  add('period_months', 'Шинжилгээний хугацаа (сар)', 'max(1, round(өдрийн тоо ÷ 30.4375))',
    { periodFrom: params.periodFrom, periodTo: params.periodTo, days, daysPerMonth: DAYS_PER_MONTH }, periodMonths);
  add('total_income', 'Нийт орлого (сарын дундаж)', 'Σ орлогын ангиллын нийт дүн ÷ хугацааны сар',
    { incomeTotal: money(sumOf(incomeRows.map((r) => r.total))), periodMonths, categoryCount: incomeRows.length }, monthlyIncome);
  add('total_expense', 'Нийт зарлага (сарын дундаж)', 'Σ зарлагын ангиллын нийт дүн ÷ хугацааны сар (хасагдах ангиллыг оруулаагүй)',
    { expenseTotal: money(base.EXPENSE), periodMonths }, money(base.EXPENSE.div(pm)));
  add('weighted_income', 'Жинлэсэн (баталгаажсан) орлого', 'Σ (ангилал бүрийн сарын дундаж × дайчлах хувь)',
    { totalMonthlyIncome: monthlyIncome, weightedCategoryCount: incomeRows.filter((r) => r.c.weight > 0).length }, verified);
  add('cogs_adjustment', 'ББӨ хассан орлого (DTI орлого)', 'жинлэсэн орлого × (1 − ББӨ)',
    { verifiedMonthlyIncome: verified, costOfGoodsRate: params.costOfGoodsRate }, dtiIncomeOut);
  add('business_income', 'Дайчилсан бизнесийн орлого', 'Σ (бизнесийн орлогын ангиллын сарын дундаж × дайчлах хувь)',
    { businessIncomeCodes: params.businessIncomeCodes.join(','), categoryCount: businessIncomeRows.length }, businessIncomeOut);
  add('business_expense', 'Бизнесийн зардал (сарын дундаж)', 'Σ бизнесийн зардлын ангиллын сарын дундаж',
    { categoryCount: businessExpenseRows.length }, businessExpenseOut);
  add('net_cash_flow', 'Цэвэр мөнгөн урсгал (ЦМУ)', 'дайчилсан бизнесийн орлого − бизнесийн зардал',
    { businessIncomeMonthly: businessIncomeOut, businessExpenseMonthly: businessExpenseOut }, money(netCashFlow));
  add('debt_service', 'Одоогийн өрийн үйлчилгээ (сарын)', 'Σ өрийн үйлчилгээний ангиллын сарын дундаж',
    { categoryCount: debtRows.length }, debtServiceOut);
  add('household_expense', 'Өрхийн зардал (сарын)', 'Σ өрхийн зардлын ангиллын сарын дундаж',
    { categoryCount: householdRows.length }, money(household));
  add('dti_numerator', 'Нийт сарын төлбөр', 'санал болгосон сарын төлбөр + одоогийн өрийн үйлчилгээ',
    { proposedMonthlyPayment: params.proposedMonthlyPayment, existingDebtServiceMonthly: debtServiceOut }, money(numerator));
  add('dti_ratio', 'Өр/орлогын харьцаа (ӨОХ, DTI), %',
    `нийт сарын төлбөр ÷ DTI орлого × 100; DTI орлого ≤ 0 үед төлбөртэй бол ${DTI_PERCENT_CAP}% (хязгаар), төлбөргүй бол 0%`,
    { totalMonthlyPayment: money(numerator), dtiIncome: dtiIncomeOut }, dtiPercent);
  add('dti_level', 'ӨОХ-ийн түвшин ба хязгаар', 'DTI ≤ бага хязгаар → LOW; ≤ дунд → MEDIUM; бусад HIGH; DTI ≤ дээд хязгаар бол хангана',
    {
      dtiPercent, lowMaxPercent: pct(params.levelThresholds.lowMax), mediumMaxPercent: pct(params.levelThresholds.mediumMax),
      maxDtiPercent: pct(params.maxDti), level: dtiLevel, meetsLimit: String(meetsLimit),
    }, dtiPercent);
  add('income_reliability', 'Орлогын найдвар, %', '100 × (wF × давтамж + wC × тогтвортой байдал + wK × цэвэр байдал)',
    {
      frequencyPercent: reliabilityPct(reliability.frequency), consistencyPercent: reliabilityPct(reliability.consistency),
      cleanlinessPercent: reliabilityPct(reliability.cleanliness), wFrequency: w.frequency, wConsistency: w.consistency,
      wCleanliness: w.cleanliness, monthsAssessed: reliabilityMonthKeys.length,
    }, reliability.score);

  return {
    periodMonths,
    monthKeys,
    totalMonthlyIncome: monthlyIncome,
    verifiedMonthlyIncome: verified,
    dtiIncome: dtiIncomeOut,
    businessIncomeMonthly: businessIncomeOut,
    businessExpenseMonthly: businessExpenseOut,
    netCashFlowMonthly: money(netCashFlow),
    existingDebtServiceMonthly: debtServiceOut,
    householdExpenseMonthly: money(household),
    incomeReliability: reliability.score,
    dtiRatio,
    dtiPercent,
    dtiLevel,
    meetsLimit,
    categories: summaries,
    methodology,
  };
}

/** BSA-ийн үр дүн → Тооцоолол/Sosco Score-ийн оролтын хэсэг (INT-5: LOS дээр гараар засахгүй) */
export interface BsaScoringPatch {
  scoreRequest: Pick<ScoreRequest, 'businessNcfMonthly' | 'existingDebtServiceMonthly' | 'householdExpenseMonthly'>;
  sosco: Pick<SoscoInput, 'dtiPercent' | 'incomeReliability' | 'pendingSuspiciousCount'>;
}

/** INT-5: BsaScoringInput → ScoreRequest + SoscoInput-ийн хэсэг. Утгыг өөрчлөхгүй, зөвхөн зураглана
 *  (шинжилгээ ANALYZED эсэхийг дуудагч шалгана). */
export function toScoringPatch(input: BsaScoringInput): BsaScoringPatch {
  return {
    scoreRequest: {
      businessNcfMonthly: input.businessNcfMonthly,
      existingDebtServiceMonthly: input.existingDebtServiceMonthly,
      householdExpenseMonthly: input.householdExpenseMonthly,
    },
    sosco: {
      dtiPercent: input.dtiPercent,
      incomeReliability: input.incomeReliability,
      pendingSuspiciousCount: input.pendingSuspiciousCount,
    },
  };
}
