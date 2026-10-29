import Decimal from 'decimal.js';
import type { PosDecision, PosPolicy, PosPublicReason, PosQuote, PosReasonCode, PosReasonSeverity, PosScreeningResponse } from '@los/contracts';
import { dti } from './dti';
import { annuityPayment } from './schedule';
// Мерчант POS лизинг (docs/05-merchant-pos.md): үнийн санал, шууд шийдвэр, чадамж. I/O-гүй цэвэр функц.
// Хувь = бутархай (0.2399 = 23.99%). BR утгууд `policy` параметрээр ирнэ — hardcode хийхгүй.

const round2 = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

// ───────────── Үнийн санал ─────────────
export interface PosQuoteInput { planCode: string; goodsPrice: number; downPayment: number; termMonths: number; annualRate: number; feeRate: number; commissionRate: number }

/** F-ээс шимтгэл, зээлийн үндсэн дүн, сарын төлбөр. quotePosLease ба урьдчилгааны санал (suggestMinDownPayment) НЭГ томьёо ашиглана — санал бодит quote-той яг таарна. */
function financingOf(financed: Decimal, annualRate: number, feeRate: number, termMonths: number) {
  const feeAmount = round2(financed.mul(feeRate));
  const principal = round2(financed.plus(feeAmount));
  const monthlyPayment = round2(annuityPayment(principal, new Decimal(annualRate).mul(100).toNumber(), termMonths));
  return { feeAmount, principal, monthlyPayment };
}

/** Санхүүжилтийн дүн F = үнэ − урьдчилгаа; зээлийн үндсэн дүн = F + шимтгэл; сарын төлбөр = annuity. */
export function quotePosLease(i: PosQuoteInput): PosQuote {
  if (!(i.goodsPrice > 0)) throw new RangeError('goodsPrice must be > 0');
  if (!(i.downPayment >= 0 && i.downPayment < i.goodsPrice)) throw new RangeError('downPayment must be in [0, goodsPrice)');
  if (!Number.isInteger(i.termMonths) || i.termMonths < 1) throw new RangeError('termMonths must be a positive integer');
  if (!(i.annualRate >= 0 && i.annualRate <= 1) || !(i.feeRate >= 0 && i.feeRate <= 1) || !(i.commissionRate >= 0 && i.commissionRate <= 1)) throw new RangeError('rates must be within [0, 1]');
  const financed = new Decimal(i.goodsPrice).minus(i.downPayment);
  const { feeAmount, principal, monthlyPayment } = financingOf(financed, i.annualRate, i.feeRate, i.termMonths);
  const totalRepayment = round2(new Decimal(monthlyPayment).mul(i.termMonths));
  const commission = round2(financed.mul(i.commissionRate));
  return {
    planCode: i.planCode, goodsPrice: i.goodsPrice, downPayment: i.downPayment, downPaymentRate: new Decimal(i.downPayment).div(i.goodsPrice).toDecimalPlaces(4).toNumber(),
    financedAmount: financed.toNumber(), feeRate: i.feeRate, feeAmount, principal, termMonths: i.termMonths, annualRate: i.annualRate, monthlyPayment, totalRepayment,
    totalInterestAndFees: Math.max(0, round2(new Decimal(totalRepayment).minus(financed))), totalCostToBuyer: round2(new Decimal(totalRepayment).plus(i.downPayment)),
    effectiveAnnualRate: effectiveAnnualRate(financed.toNumber(), monthlyPayment, i.termMonths),
    merchantCommissionRate: i.commissionRate, merchantCommissionAmount: commission, merchantNetAmount: round2(financed.minus(commission)),
  };
}

/** Үр ашигт жилийн хүү: хүлээн авсан F = Σ pmt/(1+i)^k тэгшитгэлийн сарын i-г хоёр хуваах аргаар; жилд шилжүүлнэ. */
export function effectiveAnnualRate(received: number, monthlyPayment: number, termMonths: number): number {
  if (monthlyPayment * termMonths <= received) return 0;
  let lo = 0;
  let hi = 1; // сарын 100% — дээд хязгаар
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    const pv = (monthlyPayment * (1 - Math.pow(1 + mid, -termMonths))) / mid;
    if (pv > received) lo = mid; else hi = mid;
  }
  return Math.round((Math.pow(1 + (lo + hi) / 2, 12) - 1) * 10000) / 10000;
}

/** annuity-ийн урвуу: сарын төлбөрөөс зээлийн үндсэн дүн. */
export function principalFromPayment(monthlyPayment: number, annualRate: number, termMonths: number): number {
  if (annualRate === 0) return round2(new Decimal(monthlyPayment).mul(termMonths));
  const r = new Decimal(annualRate).div(12);
  return round2(new Decimal(monthlyPayment).mul(new Decimal(1).minus(r.plus(1).pow(-termMonths))).div(r));
}

// ───────────── Нас ─────────────
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `birth`-ээс `today` хүртэлх бүтэн сар (YYYY-MM-DD). */
export function ageInMonths(birth: string, today: string): number {
  const b = DATE_RE.exec(birth);
  const t = DATE_RE.exec(today);
  if (!b || !t) throw new RangeError('dates must be YYYY-MM-DD');
  const months = (Number(t[1]) - Number(b[1])) * 12 + (Number(t[2]) - Number(b[2])) - (Number(t[3]) < Number(b[3]) ? 1 : 0);
  return Math.max(0, months);
}

// ───────────── Шууд шийдвэр ─────────────
/** Урьдчилгааны санал хэрэгжих боломжтой байх хязгаар (POS-BR-1): хөтөлбөрийн санхүүжилтийн хүрээ, мерчантын тасалбарын дээд хязгаар, доод урьдчилгааны хувь. */
export interface PosSuggestionLimits { minAmount: number; maxAmount: number; maxTicketAmount: number; minDownPaymentRate: number }
export interface PosDecisionInput {
  quote: Pick<PosQuote, 'goodsPrice' | 'financedAmount' | 'monthlyPayment' | 'termMonths' | 'annualRate' | 'feeRate'>;
  screening: PosScreeningResponse;
  policy: PosPolicy;
  today: string; // YYYY-MM-DD
  /** Заавал биш: өгвөл `suggestedMinDownPayment` нь хөтөлбөр/мерчантын хязгаарт нийцсэн, ӨОХ-д хүрэлцэх урьдчилгаа байх ба боломжгүй бол null. */
  limits?: PosSuggestionLimits;
}
export interface PosReason { code: PosReasonCode; severity: PosReasonSeverity }
export interface PosAffordabilityResult { maxMonthlyPayment: number; maxFinancedAmount: number; suggestedMinDownPayment: number | null }
export interface PosDecisionResult { decision: PosDecision; reasons: PosReason[]; dtiRatio: number | null; affordability: PosAffordabilityResult | null }

const DOWN_PAYMENT_STEP = 1000;
const SUGGESTION_MAX_STEPS = 5; // шинжилгээний тооцоо хамгийн ихдээ 1–2 алхмаар зөрнө; хязгаартай давталт

/**
 * Урьдчилгааны санал: ӨОХ-д хүрэлцэх хамгийн бага урьдчилгаа (1,000₮-ийн нарийвчлалаар дээш) ба хөтөлбөрийн доод урьдчилгааны хувийн том нь.
 * Санал бүрийг бодит quote-ийн томьёогоор (financingOf) дахин бодож шалгана → санал болгосон урьдчилгаагаар quote хийвэл ӨОХ ≤ maxDti, хүрээ/тасалбар/доод урьдчилгаа хангагдана.
 * Ямар ч урьдчилгаа ӨОХ ба хүрээг зэрэг хангахгүй бол null.
 */
function suggestMinDownPayment(q: PosDecisionInput['quote'], income: number, existingDebtService: number, maxDti: number, maxFinancedAmount: number, limits?: PosSuggestionLimits): number | null {
  if (!(maxFinancedAmount > 0)) return null;
  const price = new Decimal(q.goodsPrice);
  let lowest = new Decimal(0); // хүрээнээс шалтгаалсан доод хязгаар
  let highest = price; // тэгш бус: урьдчилгаа < үнэ (санхүүжилт > 0)
  let strictHighest = true;
  if (limits) {
    lowest = Decimal.max(price.mul(limits.minDownPaymentRate).toDecimalPlaces(6).ceil(), price.minus(Math.min(limits.maxAmount, limits.maxTicketAmount)), 0);
    highest = price.minus(limits.minAmount); // санхүүжилт ≥ minAmount → урьдчилгаа ≤ үнэ − minAmount (хамгийн их зөвшөөрөгдөх)
    strictHighest = limits.minAmount <= 0;
  }
  const within = (d: Decimal) => d.gte(lowest) && (strictHighest ? d.lt(highest) : d.lte(highest));
  const works = (d: Decimal) => within(d) && dti(financingOf(price.minus(d), q.annualRate, q.feeRate, q.termMonths).monthlyPayment, existingDebtService, income) <= maxDti;

  const needed = Decimal.max(price.minus(maxFinancedAmount), lowest);
  let d = needed.div(DOWN_PAYMENT_STEP).ceil().mul(DOWN_PAYMENT_STEP);
  for (let i = 0; i < SUGGESTION_MAX_STEPS && within(d); i++, d = d.plus(DOWN_PAYMENT_STEP)) {
    if (works(d)) return d.toNumber();
  }
  // 1,000₮-ийн алхам хүрээг давсан бол хүрээнд зөвшөөрөгдөх хамгийн их урьдчилгаа (санхүүжилт = minAmount) ч хүрэлцэх эсэхийг шалгана.
  if (limits && !strictHighest && works(highest)) return highest.toNumber();
  return null;
}

/** Хүлээж болох дээд сарын төлбөрөөс санхүүжилтийн дээд дүн ба хамгийн бага урьдчилгааг санал болгоно. */
export function affordability(q: PosDecisionInput['quote'], income: number, existingDebtService: number, maxDti: number, limits?: PosSuggestionLimits): PosAffordabilityResult {
  const maxMonthlyPayment = Math.max(0, round2(new Decimal(income).mul(maxDti).minus(existingDebtService)));
  const maxPrincipal = principalFromPayment(maxMonthlyPayment, q.annualRate, q.termMonths);
  const maxFinancedAmount = round2(new Decimal(maxPrincipal).div(new Decimal(1).plus(q.feeRate)));
  return { maxMonthlyPayment, maxFinancedAmount, suggestedMinDownPayment: suggestMinDownPayment(q, income, existingDebtService, maxDti, maxFinancedAmount, limits) };
}

/**
 * Зөвшөөрлийн суваг (consent OTP очсон утас) иргэнийх гэдэг нь kyc-ээр баталгаажсан эсэх. OTP-г кассир оруулсан утсанд илгээдэг тул утас нь
 * регистрийн эзнийх гэдгийг зөвхөн `identity.phoneMatches === true` л батлана (POS-BR-6, POS-BR-7a). Сервис энэ нэг функцээр нэр хадгалах эсэхээ шийднэ.
 */
export function isConsentChannelVerified(identity: Pick<PosScreeningResponse['identity'], 'found' | 'phoneMatches'>): boolean {
  return identity.found && identity.phoneMatches === true;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function decidePosLease(input: PosDecisionInput): PosDecisionResult {
  const { quote, screening, policy } = input;
  const reasons: PosReason[] = [];
  const add = (code: PosReasonCode, severity: PosReasonSeverity) => reasons.push({ code, severity });

  // Хувь хүн, нас
  const identity = screening.identity;
  if (!identity.found) add('IDENTITY_NOT_FOUND', 'REFER');
  else if (identity.birthDate) {
    const months = ageInMonths(identity.birthDate, input.today);
    if (Math.floor(months / 12) < policy.minAge) add('UNDERAGE', 'DECLINE');
    if ((months + quote.termMonths) / 12 > policy.maxAgeAtMaturity) add('AGE_AT_MATURITY_EXCEEDED', 'DECLINE');
  } else add('BIRTH_DATE_MISSING', 'REFER'); // нас шалгагдаагүй хүнийг автоматаар батлахгүй — fail-closed
  if (identity.phoneMatches === false) add('PHONE_MISMATCH', 'REFER');
  else if (identity.found && identity.phoneMatches === null) add('PHONE_UNVERIFIED', 'REFER');

  // ЗМС
  const cib = screening.cib;
  if (!cib.available) add('CREDIT_DATA_UNAVAILABLE', 'REFER');
  else {
    if (cib.maxDpdDays >= policy.declineDpd) add('DPD_EXCEEDED', 'DECLINE');
    else if (cib.maxDpdDays >= policy.referDpd) add('DPD_WATCH', 'REFER');
    if (cib.ficoScore === null) add('CREDIT_DATA_UNAVAILABLE', 'REFER');
    else if (cib.ficoScore < policy.declineFico) add('FICO_TOO_LOW', 'DECLINE');
    else if (cib.ficoScore < policy.referFico) add('FICO_LOW', 'REFER');
    if (cib.activeLoanCount > policy.maxActiveLoansAuto) add('TOO_MANY_ACTIVE_LOANS', 'REFER');
  }

  // BR-9: хар жагсаалт — зөвхөн анхааруулга, батлагч шийднэ → REFER
  if (screening.blacklist.hit) add('BLACKLISTED', 'REFER');
  if (screening.pep) add('PEP', 'REFER');

  // ӨОХ (BR-1)
  let dtiRatio: number | null = null;
  let afford: PosAffordabilityResult | null = null;
  const income = screening.income.monthlyAmount;
  if (income === null || income <= 0 || screening.income.source === 'NONE') add('INCOME_UNVERIFIED', 'REFER');
  else if (cib.available) {
    // Шийдвэрийг ТОЙРУУЛААГҮЙ ӨОХ-оор гаргана (affordability-ийн income×maxDti − өр томьёотой нийцнэ); хадгалах/харуулах утга л 4 оронд тойрно.
    // Тиймээс босго хэтэрсэн (жишээ нь 0.55004 > 0.55) боловч dtiRatio = 0.55 гэж харагдах нь зөв — шийдвэр нь REFER.
    const rawDti = dti(quote.monthlyPayment, cib.monthlyDebtService, income);
    dtiRatio = round4(rawDti);
    if (rawDti > policy.maxDti) {
      const hard = rawDti > policy.referDti;
      add(hard ? 'DTI_EXCEEDED_HARD' : 'DTI_EXCEEDED', hard ? 'DECLINE' : 'REFER');
      afford = affordability(quote, income, cib.monthlyDebtService, policy.maxDti, input.limits);
    }
  }

  if (quote.financedAmount > policy.autoApproveMaxAmount) add('AMOUNT_ABOVE_AUTO_LIMIT', 'REFER');

  // DECLINE → REFER: автомат татгалзалт идэвхгүй, эсвэл зөвшөөрлийн суваг баталгаажаагүй үед. Суваг баталгаажаагүй (утас таарахгүй/тодорхойгүй/иргэн олдоогүй) бол
  // кассирын оруулсан регистрийн зээлийн байдлыг мерчантад (ангиллаар ч) ил гаргахгүй: үр дүн үргэлж REFER (ямар ч APPROVE/DECLINE ялгаагүй → "оракул" байхгүй). Дотоод шалтгаан хадгалагдана.
  const demote = !policy.autoDeclineEnabled || !isConsentChannelVerified(identity);
  const finalReasons = demote ? reasons.map((r) => (r.severity === 'DECLINE' ? { ...r, severity: 'REFER' as const } : r)) : reasons;
  const decision: PosDecision = finalReasons.some((r) => r.severity === 'DECLINE') ? 'DECLINE' : finalReasons.some((r) => r.severity === 'REFER') ? 'REFER' : 'APPROVE';
  return { decision, reasons: finalReasons, dtiRatio, affordability: afford };
}

// ───────────── Мерчантад харуулах хэсэг (POS-BR-6: зээлийн мэдээллийн нууцлал) ─────────────
// DECLINE-д хүргэж болох кодууд (REFER үргэлж MANUAL_REVIEW).
const PUBLIC_REASON_PRIORITY: Array<[PosPublicReason, readonly PosReasonCode[]]> = [
  ['AFFORDABILITY', ['DTI_EXCEEDED_HARD']],
  ['CREDIT_POLICY', ['DPD_EXCEEDED', 'FICO_TOO_LOW']],
  ['ELIGIBILITY', ['UNDERAGE', 'AGE_AT_MATURITY_EXCEEDED']],
];

/** APPROVE → null; REFER → MANUAL_REVIEW (дотоод шалтгааныг задруулахгүй); DECLINE → ерөнхий ангилал. */
export function publicReasonOf(r: Pick<PosDecisionResult, 'decision' | 'reasons'>): PosPublicReason | null {
  if (r.decision === 'APPROVE') return null;
  if (r.decision === 'REFER') return 'MANUAL_REVIEW';
  const codes = new Set(r.reasons.filter((x) => x.severity === 'DECLINE').map((x) => x.code));
  return PUBLIC_REASON_PRIORITY.find(([, list]) => list.some((c) => codes.has(c)))?.[0] ?? 'CREDIT_POLICY';
}

/** Урьдчилгаа нэмбэл батлагдах боломжтой үед л (бүх саад нь ӨОХ-той холбоотой) мерчантад санал болгоно. */
export function suggestedDownPaymentFor(r: Pick<PosDecisionResult, 'reasons' | 'affordability'>): number | null {
  const blocking = r.reasons.filter((x) => x.severity !== 'INFO');
  if (blocking.length === 0 || !blocking.every((x) => x.code === 'DTI_EXCEEDED' || x.code === 'DTI_EXCEEDED_HARD')) return null;
  return r.affordability?.suggestedMinDownPayment ?? null;
}
