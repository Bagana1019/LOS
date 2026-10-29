import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type LoanApplication } from '.prisma/client-origination';
import { annuityPayment } from '@los/calc';
import {
  ScoreTerms, StressPolicy, UnderwritingPolicy,
  type CalcMethod, type MethodReason, type RequestContext, type ScoreLimits, type ScorePreviewRequest, type ScoreRequest, type SoscoInput, type UnderwriteResult,
} from '@los/contracts';
import { PrismaService } from '../../prisma.service';
import { OrgSettings } from '../../shared/org-settings';
import { CREDIT_HISTORY, type CreditHistory, type CreditHistoryPort } from './credit-history/credit-history.port';

// ───────────────────────────── Цэвэр туслахууд (DB-гүй, unit тесттэй) ─────────────────────────────

type Num = Prisma.Decimal | number | string | null | undefined;
const dec = (v: Num): Prisma.Decimal => new Prisma.Decimal(v ?? 0);
const numOrNull = (v: Num): number | null => (v === null || v === undefined ? null : dec(v).toNumber());
const money = (d: Prisma.Decimal): number => d.toDecimalPlaces(2).toNumber();
/** Сөрөг/тоо биш утгыг 0 болгоно: гараар оруулсан өгөгдлийн алдаа тооцоолол/гэрээг унагахгүй. */
const nonNegative = (d: Prisma.Decimal): Prisma.Decimal => (d.isFinite() && d.gt(0) ? d : new Prisma.Decimal(0));
const sum = (values: Num[]): Prisma.Decimal => values.reduce<Prisma.Decimal>((acc, v) => acc.plus(dec(v)), new Prisma.Decimal(0));

/** FR-8.6 · LOAN_TERMS_MISSING — алхам 4 (`loan`)-д заана. */
export const LOAN_TERMS_MISSING_REASON: MethodReason = {
  code: 'LOAN_TERMS_MISSING', step: 'loan', message: 'Зээлийн нөхцөл (дүн, хугацаа, хүү) бөглөгдөөгүй байна. 4-р алхамд бөглөнө үү',
};

export interface SavedTerms { amount: Num; termMonths: number | null | undefined; interestRate: Num }

export interface ResolvedTerms {
  /** Хүсэлтэд хадгалагдсан нөхцөл (бүрэн бол) */
  saved: ScoreTerms | null;
  /** Үр дүнтэй нөхцөл = хадгалагдсан + preview override. Дутуу бол null */
  terms: ScoreTerms | null;
  /** Үр дүнтэй нөхцөл хадгалагдсантай ялгаатай (slider) */
  overridden: boolean;
}

/** Өгөөгүй талбар = хүсэлтийн одоогийн нөхцөл (ScorePreviewRequest). Бүрэн биш нөхцөл → null. */
export function resolveTerms(saved: SavedTerms, overrides: ScorePreviewRequest = {}): ResolvedTerms {
  const parse = (amount: Num, termMonths: number | null | undefined, interestRate: Num): ScoreTerms | null => {
    const r = ScoreTerms.safeParse({ amount: numOrNull(amount), termMonths: termMonths ?? null, interestRate: numOrNull(interestRate) });
    return r.success ? r.data : null;
  };
  const savedTerms = parse(saved.amount, saved.termMonths, saved.interestRate);
  const terms = parse(overrides.amount ?? saved.amount, overrides.termMonths ?? saved.termMonths, overrides.interestRate ?? saved.interestRate);
  const overridden = !!terms && (!savedTerms || terms.amount !== savedTerms.amount || terms.termMonths !== savedTerms.termMonths || terms.interestRate !== savedTerms.interestRate);
  return { saved: savedTerms, terms, overridden };
}

export const termsBlockers = (terms: ScoreTerms | null): MethodReason[] => (terms ? [] : [LOAN_TERMS_MISSING_REASON]);

export interface ProductRow {
  minAmount: Num; maxAmount: Num; minTerm: number; maxTerm: number; minRate: Num; maxRate: Num;
  requiresCollateral: boolean; maxLtv: Num; maxDti: Num; minDscr: Num; calcWeightThreshold: Num;
}

/** BR-6 · slider-ийн хязгаар (product). Бүтээгдэхүүнгүй бол null. */
export function resolveLimits(product: ProductRow | null): ScoreLimits | null {
  if (!product) return null;
  return {
    minAmount: dec(product.minAmount).toNumber(), maxAmount: dec(product.maxAmount).toNumber(),
    minTermMonths: product.minTerm, maxTermMonths: product.maxTerm,
    minRate: dec(product.minRate).toNumber(), maxRate: dec(product.maxRate).toNumber(),
  };
}

export interface LimitViolation { field: 'amount' | 'termMonths' | 'interestRate'; value: number; min: number; max: number }

/** BR-6 · preview-ийн ӨГСӨН талбарыг л бүтээгдэхүүний хязгаартай тулгана (хадгалагдсан нөхцөл нь ЗЭЗ-ийн хариуцлага). */
export function limitViolations(overrides: ScorePreviewRequest, limits: ScoreLimits | null): LimitViolation[] {
  if (!limits) return [];
  const out: LimitViolation[] = [];
  const check = (field: LimitViolation['field'], value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (value < min || value > max)) out.push({ field, value, min, max });
  };
  check('amount', overrides.amount, limits.minAmount, limits.maxAmount);
  check('termMonths', overrides.termMonths, limits.minTermMonths, limits.maxTermMonths);
  check('interestRate', overrides.interestRate, limits.minRate, limits.maxRate);
  return out;
}

export interface PolicySettings { dtiMax: number; dscrMin: number; ltvMax: number; weightThreshold: number }

/** BR-1…BR-4: тохиргоо (`setting`), харин бүтээгдэхүүний өөрийн утга (null биш) давамгайлна. Хүчингүй (схемд нийцэхгүй) override-ыг үл хэрэгсэнэ. */
export function resolvePolicy(base: PolicySettings, product: ProductRow | null): UnderwritingPolicy {
  const pick = (field: keyof UnderwritingPolicy, fallback: number, override: Num): number => {
    const candidate = numOrNull(override);
    return candidate !== null && UnderwritingPolicy.shape[field].safeParse(candidate).success ? candidate : fallback;
  };
  return {
    maxDti: pick('maxDti', base.dtiMax, product?.maxDti),
    minDscr: pick('minDscr', base.dscrMin, product?.minDscr),
    maxLtv: pick('maxLtv', base.ltvMax, product?.maxLtv),
    weightThreshold: pick('weightThreshold', base.weightThreshold, product?.calcWeightThreshold),
  };
}

/** FR-8.5 · `stress.rate_delta` (бутархай 0.05) → п.п. 5; `stress.income_delta` (−0.2) → incomeChange. Схемд нийцэхгүй бол stress-гүй. */
export function resolveStress(rateDelta: number, incomeDelta: number): StressPolicy | undefined {
  const parsed = StressPolicy.safeParse({ rateDeltaPoints: dec(rateDelta).mul(100).toDecimalPlaces(6).toNumber(), incomeChange: incomeDelta });
  return parsed.success ? parsed.data : undefined;
}

export interface BorrowerRow { customerId: string; role: string; incomeIncluded: boolean }
export interface IncomeRow { customerId: string; avgSalaryMonthly: Num; businessNcfMonthly: Num; householdExpenseMonthly: Num }
export interface AggregatedIncome { primaryCustomerId: string | null; salaryMonthly: number; businessNcfMonthly: number; householdExpenseMonthly: number; contributors: string[] }

/**
 * FR-8 / Q-M8-10: цалин, ЦМУ = үндсэн зээлдэгч + `income_included=true` хамтран зээлдэгчийн нийлбэр; өрхийн зардал = ЗӨВХӨН үндсэн
 * зээлдэгчийнх (давхар тооцохгүй). Батлан даагч / барьцаалагчийн орлого хэзээ ч орохгүй.
 */
export function aggregateIncome(borrowers: BorrowerRow[], incomes: IncomeRow[]): AggregatedIncome {
  const primaryCustomerId = borrowers.find((b) => b.role === 'PRIMARY')?.customerId ?? null;
  const contributors = new Set<string>();
  if (primaryCustomerId) contributors.add(primaryCustomerId);
  for (const b of borrowers) if ((b.role === 'PRIMARY' || b.role === 'CO_BORROWER') && b.incomeIncluded) contributors.add(b.customerId);
  const rows = incomes.filter((i) => contributors.has(i.customerId));
  const primaryRow = incomes.find((i) => i.customerId === primaryCustomerId);
  return {
    primaryCustomerId,
    salaryMonthly: money(nonNegative(sum(rows.map((r) => r.avgSalaryMonthly)))),
    businessNcfMonthly: money(sum(rows.map((r) => r.businessNcfMonthly))), // алдагдалтай бол сөрөг
    householdExpenseMonthly: money(nonNegative(dec(primaryRow?.householdExpenseMonthly))),
    contributors: [...contributors],
  };
}

export interface BsaFacts {
  analyzed: boolean;
  existingDebtServiceMonthly: number | null;
  dtiPercent: number | null;
  incomeReliability: number | null;
  pendingSuspiciousCount: number | null;
}
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `loan_application.bsa_summary_json` (INT-4) — уян задлалт: муу талбар зөвхөн өөрийгөө "мэдэгдэхгүй" болгоно. dti/найдвар/сэжигтэй нь зөвхөн ANALYZED үед. */
export function readBsaFacts(json: unknown): BsaFacts {
  const o = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const analyzed = o.status === 'ANALYZED';
  const nonNeg = (v: unknown): number | null => { const n = finite(v); return n !== null && n >= 0 ? n : null; };
  const reliability = finite(o.incomeReliability);
  const pending = nonNeg(o.pendingSuspiciousCount);
  return {
    analyzed,
    existingDebtServiceMonthly: nonNeg(o.existingDebtServiceMonthly),
    dtiPercent: analyzed ? nonNeg(o.dtiPercent) : null,
    incomeReliability: analyzed && reliability !== null ? Math.min(100, Math.max(0, reliability)) : null,
    pendingSuspiciousCount: analyzed && pending !== null ? Math.trunc(pending) : null,
  };
}

/** Идэвхтэй өрийн сарын төлбөр = ЗМС ба BSA-ийн ИХ нь (консерватив: хоёр эх сурвалж давхардаж болох тул нэмэхгүй, дутуу тооцохгүй). */
export function existingDebtService(credit: CreditHistory | null, bsa: BsaFacts): number {
  return money(nonNegative(new Prisma.Decimal(Math.max(credit?.existingDebtServiceMonthly ?? 0, bsa.existingDebtServiceMonthly ?? 0))));
}

export interface ScheduleFacts { isStale: boolean; rows: Array<{ principal: Num; total: Num }> }
export interface NewPayment { value: number; source: 'SCHEDULE' | 'ANNUITY' }

/** Тэнцүү төлбөр гэж үзэх зөрүү (сүүлийн мөрийн бөөрөнхийлөлт ₮-өөр зөрж болно) */
const CONSTANT_TOLERANCE = 1;

/**
 * Шинэ зээлийн сарын төлбөр. TODO(M07): ЭТХ-ийн модуль ороход `buildSchedule`-аас шууд авна — одоо:
 *  - хадгалагдсан нөхцөлтэй ижил, хуучраагүй, мөр бүхий ЭТХ байгаа бөгөөд тэнцүү төлбөртэй (annuity-төст) бол эхний мөрийн `total`;
 *  - үгүй бол annuity (`annuityPayment`).
 */
export function newMonthlyPayment(terms: ScoreTerms, schedule: ScheduleFacts | null, useSchedule: boolean): NewPayment {
  if (useSchedule && schedule && !schedule.isStale && schedule.rows.length === terms.termMonths) {
    const totals = schedule.rows.map((r) => dec(r.total));
    const principal = sum(schedule.rows.map((r) => r.principal));
    const first = totals[0]!;
    const constant = totals.slice(0, -1).every((t) => t.minus(first).abs().lte(CONSTANT_TOLERANCE));
    if (constant && principal.minus(terms.amount).abs().lte(CONSTANT_TOLERANCE) && first.gt(0)) return { value: money(first), source: 'SCHEDULE' };
  }
  return { value: money(new Prisma.Decimal(annuityPayment(terms.amount, terms.interestRate, terms.termMonths))), source: 'ANNUITY' };
}

export interface RequestParts {
  applicationId: string;
  terms: ScoreTerms;
  monthlyPayment: number;
  income: AggregatedIncome;
  existingDebtServiceMonthly: number;
  collateralValueTotal: number;
  collateralRequired: boolean;
  policy: UnderwritingPolicy;
  stress?: StressPolicy;
}

export function buildScoreRequest(p: RequestParts): ScoreRequest {
  return {
    applicationId: p.applicationId,
    amount: p.terms.amount, termMonths: p.terms.termMonths, interestRate: p.terms.interestRate,
    monthlyPayment: p.monthlyPayment,
    salaryMonthly: p.income.salaryMonthly, businessNcfMonthly: p.income.businessNcfMonthly, householdExpenseMonthly: p.income.householdExpenseMonthly,
    existingDebtServiceMonthly: p.existingDebtServiceMonthly,
    collateralValueTotal: p.collateralValueTotal, collateralRequired: p.collateralRequired,
    policy: p.policy,
    ...(p.stress ? { stress: p.stress } : {}),
  };
}

/**
 * Sosco-ийн оролт (docs/05 §3, §5). `method` = сонгогдох (гараар хэвээр үлдсэн эсвэл автомат) арга: BSA шинжилгээ байхгүй үед түүний `burdenPercent` нь dtiPercent болно.
 * ЗМС/BSA-д байхгүй зүйл `null` (мэдэгдэхгүй) — зохиомол утга өгөхгүй. Харин орлого байхгүйгээс ӨОХ тооцогдохгүй бол хамгийн муу утга (доор).
 */
/** Орлого байхгүй / суурь орлого ≤ 0 → өр төлөх чадваргүй: Sosco-д «мэдэгдэхгүй» (жин дахин хуваарилагдаж оноо өснө) биш, хамгийн муу ӨОХ гэж өгнө (BSA-ийн cap-тай ижил). */
export const SOSCO_UNSERVICEABLE_DTI_PERCENT = 999.9;

export function buildSoscoInput(credit: CreditHistory | null, bsa: BsaFacts, result: UnderwriteResult, method: CalcMethod | null): SoscoInput {
  const verdict = method ? result.methods.find((m) => m.method === method) : undefined;
  return {
    ficoScore: credit?.ficoScore ?? null,
    dtiPercent: bsa.analyzed && bsa.dtiPercent !== null ? bsa.dtiPercent : (verdict?.burdenPercent ?? SOSCO_UNSERVICEABLE_DTI_PERCENT),
    incomeReliability: bsa.incomeReliability,
    pendingSuspiciousCount: bsa.pendingSuspiciousCount,
    activeLoanCount: credit?.activeLoanCount ?? null,
    overdueHistoryMonths: credit?.overdueHistoryMonths ?? null,
    ltv: result.collateral.ltv,
  };
}

/** ЗМС-ийн утгыг SoscoInput/ScoreRequest-ийн муж руу шахна (бодит adapter буруу утга өгсөн ч гэрээг эвдэхгүй). */
export function sanitizeCreditHistory(c: CreditHistory | null): CreditHistory | null {
  if (!c) return null;
  const int = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
  const fico = c.ficoScore !== null && Number.isFinite(c.ficoScore) && c.ficoScore >= 0 && c.ficoScore <= 1000 ? c.ficoScore : null;
  const debt = c.existingDebtServiceMonthly !== null && Number.isFinite(c.existingDebtServiceMonthly) && c.existingDebtServiceMonthly >= 0 ? c.existingDebtServiceMonthly : null;
  return { ficoScore: fico, activeLoanCount: int(c.activeLoanCount), overdueHistoryMonths: int(c.overdueHistoryMonths), existingDebtServiceMonthly: debt };
}

// ───────────────────────────── DB-ээс цуглуулалт ─────────────────────────────

export interface AssembledTerms {
  terms: ScoreTerms | null;
  saved: ScoreTerms | null;
  overridden: boolean;
  limits: ScoreLimits | null;
  blockers: MethodReason[];
  product: ProductRow | null;
}

export interface AssembledInput extends AssembledTerms {
  applicationId: string;
  /** Үндсэн зээлдэгч (Sosco-ийн субьект) */
  customerId: string | null;
  /** `terms` дутуу бол null */
  request: ScoreRequest | null;
  credit: CreditHistory | null;
  bsa: BsaFacts;
  paymentSource: NewPayment['source'] | null;
}

@Injectable()
export class ScoreInputAssembler {
  private readonly logger = new Logger(ScoreInputAssembler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OrgSettings,
    @Inject(CREDIT_HISTORY) private readonly creditHistory: CreditHistoryPort,
  ) {}

  /** Хөнгөн хувилбар (GET overview): нөхцөл, хязгаар, саад. */
  async terms(app: LoanApplication, overrides: ScorePreviewRequest = {}): Promise<AssembledTerms> {
    const product = await this.loadProduct(app);
    const resolved = resolveTerms(app, overrides);
    return { terms: resolved.terms, saved: resolved.saved, overridden: resolved.overridden, limits: resolveLimits(product), blockers: termsBlockers(resolved.terms), product };
  }

  /** Бүрэн оролт (preview / calculate). Нөхцөл дутуу бол `request = null`, `blockers` дүүрэн. */
  async assemble(ctx: RequestContext, app: LoanApplication, overrides: ScorePreviewRequest = {}): Promise<AssembledInput> {
    const base = await this.terms(app, overrides);
    const bsa = readBsaFacts(app.bsaSummaryJson);
    const [borrowers, incomes, collaterals] = await Promise.all([
      this.prisma.loanApplicationBorrower.findMany({ where: { applicationId: app.id, orgId: app.orgId }, select: { customerId: true, role: true, incomeIncluded: true } }),
      this.prisma.incomeSummary.findMany({ where: { applicationId: app.id, orgId: app.orgId }, select: { customerId: true, avgSalaryMonthly: true, businessNcfMonthly: true, householdExpenseMonthly: true } }),
      this.prisma.collateral.findMany({ where: { applicationId: app.id, orgId: app.orgId, releasedAt: null }, select: { collateralValue: true } }),
    ]);
    const income = aggregateIncome(borrowers, incomes);
    const credit = await this.loadCredit(ctx, app.id, income.primaryCustomerId);
    if (!base.terms) return { ...base, applicationId: app.id, customerId: income.primaryCustomerId, request: null, credit, bsa, paymentSource: null };

    const schedule = base.overridden ? null : await this.loadSchedule(app);
    const payment = newMonthlyPayment(base.terms, schedule, !base.overridden);
    const [dtiMax, dscrMin, ltvMax, weightThreshold, rateDelta, incomeDelta] = await Promise.all([
      this.settings.get(app.orgId, 'br1.dti_max'), this.settings.get(app.orgId, 'br2.dscr_min'), this.settings.get(app.orgId, 'br3.ltv_max'),
      this.settings.get(app.orgId, 'br4.method_weight_threshold'), this.settings.get(app.orgId, 'stress.rate_delta'), this.settings.get(app.orgId, 'stress.income_delta'),
    ]);
    const stress = resolveStress(rateDelta, incomeDelta);
    if (!stress) this.logger.warn({ msg: 'stress settings are outside the contract range; stress test is skipped', applicationId: app.id, correlationId: ctx.correlationId });

    const request = buildScoreRequest({
      applicationId: app.id,
      terms: base.terms,
      monthlyPayment: payment.value,
      income,
      existingDebtServiceMonthly: existingDebtService(credit, bsa),
      collateralValueTotal: money(nonNegative(sum(collaterals.map((c) => c.collateralValue)))),
      collateralRequired: base.product?.requiresCollateral ?? true, // бүтээгдэхүүнгүй бол консерватив: барьцаа шаардлагатай
      policy: resolvePolicy({ dtiMax, dscrMin, ltvMax, weightThreshold }, base.product),
      stress,
    });
    return { ...base, applicationId: app.id, customerId: income.primaryCustomerId, request, credit, bsa, paymentSource: payment.source };
  }

  private async loadProduct(app: LoanApplication): Promise<ProductRow | null> {
    if (!app.productId) return null;
    return this.prisma.product.findFirst({ where: { id: app.productId, orgId: app.orgId } });
  }

  private loadSchedule(app: LoanApplication): Promise<ScheduleFacts | null> {
    return this.prisma.repaymentSchedule.findFirst({
      where: { applicationId: app.id, orgId: app.orgId }, orderBy: { generatedAt: 'desc' },
      select: { isStale: true, rows: { orderBy: { seq: 'asc' }, select: { principal: true, total: true } } },
    });
  }

  /** ЗМС дуудлага унавал "мэдэгдэхгүй" (null) — зохиомол утгаар нөхөхгүй, тооцоолол үргэлжилнэ. */
  private async loadCredit(ctx: RequestContext, applicationId: string, customerId: string | null): Promise<CreditHistory | null> {
    if (!customerId) return null;
    try {
      return sanitizeCreditHistory(await this.creditHistory.get(ctx, applicationId, customerId));
    } catch (e) {
      this.logger.warn({ msg: 'credit history lookup failed; treated as unknown', applicationId, error: e instanceof Error ? e.name : 'unknown', correlationId: ctx.correlationId });
      return null;
    }
  }
}
