import { CalcMethod, SCORING_ERROR_CODES } from '@los/contracts';
import type {
  CalculationRecord,
  MethodReason,
  MethodVerdict,
  ReasonStep,
  ScoreLimits,
  ScoreOverview,
  ScoreTerms,
  SoscoComponentKey,
  SoscoGrade,
  UnderwriteResult,
  CollateralVerdict,
} from '@los/contracts';
import { EMPTY_VALUE, formatMnt, formatNumber, formatPercent } from '../../lib/format';
import { hasMessage } from '../../lib/i18n';

// Цэвэр логик (React, antd-аас хамааралгүй) — vitest-ээр тестлэнэ. FR-8.1…8.6, BR-1…BR-5.
// ЧУХАЛ: UI-д санхүүгийн тооцоолол ХИЙХГҮЙ (docs/00 §7). Энд зөвхөн (а) форматлалт, (б) өнгө/тон хөрвүүлэлт, (в) формын оролтын шалгалт,
// (г) аль үр дүнг харуулахыг сонгох логик байна. Харьцаа, төлбөр, нийлбэр, хязгаар бүгд серверээс ирнэ.

export type Translate = (key: string, params?: Record<string, string | number>) => string;

// ───────────────────────────── аргууд ─────────────────────────────

export const METHODS: readonly CalcMethod[] = CalcMethod;
export const methodKey = (m: CalcMethod): string => `score.method.${m}`;
export const methodHintKey = (m: CalcMethod): string => `score.method.${m}.hint`;
/** 'A_SALARY' → 'A' (таблын толгойн том үсэг) */
export const methodLetter = (m: CalcMethod): string => m.charAt(0);

// ───────────────────────────── тоон форматлалт ─────────────────────────────

/** Хөвөгч таслалын "шуугианыг" арилгана: 55.00000000000001 → 55, 550.4999999999999 → 550.5 */
const clean = (n: number): number => Number(n.toPrecision(12));
const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export const formatMoney = (v: number | null | undefined): string => formatMnt(v);

/** Sosco онооны хувь нэмэр (1 орон): 146.3 → '146.3', 215 → '215' */
export const formatPoints = (v: number | null | undefined): string => (isNum(v) ? String(Math.round(clean(v) * 10) / 10) : EMPTY_VALUE);

/** Хувь (аль хэдийн хувиар): 55.9 → '55.9%'. `digits` оронтой, хөвөгч шуугиангүй. */
export function formatPercentValue(percent: number | null | undefined, digits = 1): string {
  return isNum(percent) ? `${clean(percent).toFixed(digits)}%` : EMPTY_VALUE;
}

/**
 * ӨОХ / LTV (дээд хязгаартай харьцаа): бутархай × 100, 1 орон, ДЭЭШ тоймлоно — сервер ч ӨОХ-ийг дээш тоймлодог (консерватив, docs/05 §2).
 * Ингэснээр хязгаараас хэтэрсэн (55.01%) харьцаа "55.0%" болж хязгаартай тэнцэх мэт харагдахгүй.
 * 0.5589 → '55.9%', 0.55 → '55.0%', 0.5501 → '55.1%'.
 */
export function formatUpperPercent(ratio: number | null | undefined): string {
  if (!isNum(ratio)) return EMPTY_VALUE;
  const tenths = Math.ceil(clean(clean(ratio * 100) * 10));
  return `${(tenths / 10).toFixed(1)}%`;
}

/** ӨТЧХ (доод хязгаартай харьцаа): 2 орон, ДООШ тоймлоно (сервертэй адил консерватив). 6.9853 → '6.98' */
export function formatDscr(ratio: number | null | undefined): string {
  if (!isNum(ratio)) return EMPTY_VALUE;
  return (Math.floor(clean(ratio * 100)) / 100).toFixed(2);
}

/** Хязгаар/босго/жин: 0.55 → '55%', 0.525 → '52.5%'. Хэт урт орон гаргахгүй. */
export const formatShare = (ratio: number | null | undefined): string => formatPercent(ratio, 1);

/** Орлогын өөрчлөлт: -0.2 → '-20%', 0.05 → '+5%'. */
export function formatSignedPercent(change: number): string {
  const p = clean(change * 100);
  return `${p > 0 ? '+' : ''}${trimZeros(p)}%`;
}
const trimZeros = (n: number): string => String(Math.round(n * 10) / 10);

/** Аргын харьцаа: A → '55.9%', B/C → '6.98'; тооцох боломжгүй бол '—'. */
export const formatRatio = (m: Pick<MethodVerdict, 'ratioKind' | 'ratio'>): string => (m.ratioKind === 'DTI' ? formatUpperPercent(m.ratio) : formatDscr(m.ratio));

/** Хязгаар: A → '≤ 55%', B/C → '≥ 1.25' */
export function formatLimit(m: Pick<MethodVerdict, 'ratioKind' | 'limit'>): { sign: '≤' | '≥'; value: string } {
  return m.ratioKind === 'DTI' ? { sign: '≤', value: formatShare(m.limit) } : { sign: '≥', value: formatDscr(m.limit) };
}

/** Хязгааргүй бол '—'. */
export const formatNullableMoney = (v: number | null | undefined): string => (isNum(v) ? formatMoney(v) : EMPTY_VALUE);

export { formatDateTime } from '../../lib/format';

/** InputNumber: 1250000 → '1,250,000' */
export function groupDigits(value: number | string | undefined | null): string {
  if (value === undefined || value === null || value === '') return '';
  const [int, dec] = String(value).split('.');
  const grouped = (int ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? `${grouped}.${dec}` : grouped;
}
/** InputNumber parser: '1,250,000 ₮' → '1250000' (string буцаана: хоосон оролт 0 болгохгүй) */
export const parseGrouped = (display: string | undefined): string => (display ?? '').replace(/[,\s₮]/g, '');

// ───────────────────────────── тон (өнгө) ─────────────────────────────

/** Өнгөөр ганцаараа ялгахгүй: tone бүр дүрс + текст дагалдана (VerdictTag). */
export type Tone = 'pass' | 'fail' | 'na';
export const TONE_TAG_COLOR: Record<Tone, string> = { pass: 'success', fail: 'error', na: 'default' };
export const toneKey = (tone: Tone): string => `score.verdict.${tone}`;

/** Харьцааны дүгнэлт (ӨОХ/ӨТЧХ): хамаарахгүй → na; үгүй бол `pass` (бөөрөнхийлөөгүй утгаар сервер шийдсэн). */
export const ratioTone = (m: Pick<MethodVerdict, 'applicable' | 'pass'>): Tone => (!m.applicable ? 'na' : m.pass ? 'pass' : 'fail');

/** Нийт дүгнэлт: `eligible` = хамаарна && харьцаа хангана && барьцаа хангана. */
export const verdictTone = (m: Pick<MethodVerdict, 'applicable' | 'eligible'>): Tone => (!m.applicable ? 'na' : m.eligible ? 'pass' : 'fail');

/** Харьцаа хангасан ч барьцааны LTV хангаагүй тул нийт дүгнэлт улаан болсон. */
export const isBlockedByCollateral = (m: Pick<MethodVerdict, 'applicable' | 'pass' | 'eligible'>): boolean => m.applicable && m.pass && !m.eligible;

/** Барьцаа шаардахгүй ба хөрөнгөгүй (ltv=null, pass=true) бол LTV хамаарахгүй. */
export const collateralTone = (c: Pick<CollateralVerdict, 'required' | 'ltv' | 'pass'>): Tone => (!c.required && c.ltv === null ? 'na' : c.pass ? 'pass' : 'fail');

export const GRADE_COLOR: Record<SoscoGrade, string> = { A: 'green', B: 'cyan', C: 'gold', D: 'orange', E: 'red' };

// ───────────────────────────── шалтгаан (FR-8.6) ─────────────────────────────

export const reasonKey = (code: string): string => `score.reason.${code}`;
export const stepKey = (step: ReasonStep): string => `score.step.${step}`;

/** `score.reason.<CODE>` монгол текст; каталогт байхгүй код ирвэл серверийн мессеж. */
export function reasonText(reason: Pick<MethodReason, 'code' | 'message'>, tr: Translate, has: (key: string) => boolean = hasMessage): string {
  const key = reasonKey(reason.code);
  return has(key) ? tr(key) : reason.message;
}

/** Шалтгааныг засах wizard-ийн алхам: `/los/loan-application/:id/<step>` */
export const stepHref = (applicationId: string, step: ReasonStep): string => `/los/loan-application/${encodeURIComponent(applicationId)}/${step}`;

// ───────────────────────────── slider / формын оролт (FR-8.3) ─────────────────────────────

export interface SliderSpec {
  min: number;
  max: number;
  step: number;
  /** min ≥ max: сонгох зүйлгүй */
  fixed: boolean;
}
export interface SliderSpecs {
  amount: SliderSpec;
  termMonths: SliderSpec;
  /** Slider-ийн алхам 0.1; шууд оруулахад 0.01 (`inputStep`) */
  interestRate: SliderSpec & { inputStep: number };
}

const AMOUNT_STEPS = [1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000] as const;
export const PREFERRED_AMOUNT_STEP = 100_000;

/** 100,000 ₮ алхмыг илүүд үзнэ; хязгаарын муж хэт том (>1000 байрлал) бол бүдүүлж, хэт жижиг (<20) бол нарийсгана. */
export function amountStep(min: number, max: number): number {
  const range = Math.max(max - min, 0);
  let i = AMOUNT_STEPS.indexOf(PREFERRED_AMOUNT_STEP);
  while (i < AMOUNT_STEPS.length - 1 && range / AMOUNT_STEPS[i]! > 1000) i += 1;
  while (i > 0 && range / AMOUNT_STEPS[i]! < 20) i -= 1;
  return AMOUNT_STEPS[i]!;
}

export function sliderSpecs(l: ScoreLimits): SliderSpecs {
  return {
    amount: { min: l.minAmount, max: l.maxAmount, step: amountStep(l.minAmount, l.maxAmount), fixed: l.maxAmount <= l.minAmount },
    termMonths: { min: l.minTermMonths, max: l.maxTermMonths, step: 1, fixed: l.maxTermMonths <= l.minTermMonths },
    interestRate: { min: l.minRate, max: l.maxRate, step: 0.1, inputStep: 0.01, fixed: l.maxRate <= l.minRate },
  };
}

export const termsEqual = (a: ScoreTerms | null | undefined, b: ScoreTerms | null | undefined): boolean =>
  a == null || b == null ? a == null && b == null : a.amount === b.amount && a.termMonths === b.termMonths && a.interestRate === b.interestRate;

/** Query түлхүүр / debounce харьцуулалтад: утгаар тогтвортой */
export const termsKey = (t: ScoreTerms | null | undefined): string => (t ? `${t.amount}|${t.termMonths}|${t.interestRate}` : '');

export interface TermsCheck {
  amount: boolean;
  termMonths: boolean;
  interestRate: boolean;
}
const within = (v: number, min: number | undefined, max: number | undefined): boolean => (min === undefined || v >= min) && (max === undefined || v <= max);

/** Формын оролтын шалгалт (бүтээгдэхүүний хязгаар — BR-6). Хязгаар үл мэдэгдэх бол зөвхөн утгын хүчинтэй байдал. */
export function checkTerms(t: ScoreTerms, limits: ScoreLimits | null): TermsCheck {
  return {
    amount: Number.isFinite(t.amount) && t.amount > 0 && within(t.amount, limits?.minAmount, limits?.maxAmount),
    termMonths: Number.isInteger(t.termMonths) && t.termMonths >= 1 && within(t.termMonths, limits?.minTermMonths, limits?.maxTermMonths),
    interestRate: Number.isFinite(t.interestRate) && t.interestRate >= 0 && within(t.interestRate, limits?.minRate, limits?.maxRate),
  };
}
export const isTermsValid = (t: ScoreTerms, limits: ScoreLimits | null): boolean => {
  const c = checkTerms(t, limits);
  return c.amount && c.termMonths && c.interestRate;
};

/** "20,000,000₮, 24 сар, 23.99%" */
export function formatTermsSummary(t: ScoreTerms, tr: Translate): string {
  return tr('score.terms.format', { amount: formatMoney(t.amount), term: t.termMonths, rate: String(Math.round(t.interestRate * 100) / 100) });
}

/** Slider-ийн ноорог (draft) ба серверийн суурь нөхцөл. Суурь өөрчлөгдвөл (дахин ачаалал, өөр хүн алхам 4-ийг засав) ноорог шинэ суурь руу сэргэнэ. */
export interface DraftState {
  base: ScoreTerms | null;
  draft: ScoreTerms | null;
}
export function reconcileDraft(prev: DraftState, base: ScoreTerms | null): DraftState {
  return termsEqual(prev.base, base) ? prev : { base, draft: base };
}
export const isDirty = (s: DraftState): boolean => s.draft !== null && !termsEqual(s.draft, s.base);

// ───────────────────────────── аль үр дүнг харуулах ─────────────────────────────

export interface PreviewData {
  terms: ScoreTerms;
  result: UnderwriteResult;
}

/**
 * - saved: хадгалсан тооцоолол (сонголт зөвхөн үүнд). `fallback` = slider өөрчлөгдсөн ч урьдчилсан үр дүн хараахан ирээгүй.
 * - preview: хадгалагдаагүй урьдчилсан тооцоо. `initial` = тооцоолол байхгүй, одоогийн нөхцөл; `modified` = slider өөрчлөгдсөн.
 */
export type ViewSource =
  | { kind: 'none' }
  | { kind: 'saved'; calculation: CalculationRecord; result: UnderwriteResult; fallback: boolean }
  | { kind: 'preview'; terms: ScoreTerms; result: UnderwriteResult; basis: 'initial' | 'modified' };

export function resolveSource(a: { calculation: CalculationRecord | null; dirty: boolean; preview: PreviewData | null | undefined }): ViewSource {
  const { calculation, dirty, preview } = a;
  if (calculation && !dirty) return { kind: 'saved', calculation, result: calculation.result, fallback: false };
  if (preview) return { kind: 'preview', terms: preview.terms, result: preview.result, basis: calculation || dirty ? 'modified' : 'initial' };
  if (calculation) return { kind: 'saved', calculation, result: calculation.result, fallback: true };
  return { kind: 'none' };
}

export const sourceResult = (s: ViewSource): UnderwriteResult | null => (s.kind === 'none' ? null : s.result);

/** Шууд тоонуудад харуулах лавлах арга: сонгосон → автомат → эхний. (Нийт өрийн үйлчилгээ гурван аргад ижил.) */
export function referenceMethod(result: UnderwriteResult, selected: CalcMethod | null): MethodVerdict {
  const pick = (m: CalcMethod | null) => (m ? result.methods.find((x) => x.method === m) : undefined);
  return pick(selected) ?? pick(result.autoSelected) ?? result.methods[0]!;
}

// ───────────────────────────── preview-ийн шийдвэр (hook-ийн логик, тестлэгдэнэ) ─────────────────────────────

/** Эхний хүчинтэй утгыг (өмнө нь байхгүй байсан) debounce хийхгүй — хуудас нээгдэнгүүт тооцоолно; дараагийн өөрчлөлт бүрийг хүлээнэ. */
export const debounceMode = (debounced: ScoreTerms | null, draft: ScoreTerms | null): 'immediate' | 'delayed' => (draft !== null && debounced === null ? 'immediate' : 'delayed');

/**
 * Preview хүсэлт илгээх эсэх. `debounced` нь draft-тай таарсан үед л илгээнэ: slider-ийн анхны өөрчлөлтөөр `enabled` false -> true болоход
 * debounce хүлээж буй хуучин (хадгалсан) утгаар илүү хүсэлт явахаас сэргийлнэ (FR-8.3: тогтворжсон утгаар НЭГ хүсэлт).
 */
export const previewFetchEnabled = (enabled: boolean, draft: ScoreTerms | null, debounced: ScoreTerms | null): boolean => enabled && draft !== null && termsEqual(draft, debounced);

/** Preview "хүлээгдэж байна": slider-ийн утга хараахан илгээгдээгүй (debounce) эсвэл хүсэлт нисэж байна. Хүчингүй утга/идэвхгүй үед false. */
export function isPreviewPending(a: { enabled: boolean; draft: ScoreTerms | null; debounced: ScoreTerms | null; fetching: boolean }): boolean {
  return a.enabled && a.draft !== null && (termsKey(a.debounced) !== termsKey(a.draft) || a.fetching);
}

// ───────────────────────────── үйлдлийн хаалт ─────────────────────────────

export type SelectionBlock = 'notEditable' | 'noCalculation' | 'modified' | 'stale' | 'busy';

/** Арга сонгох боломжгүй шалтгаан (UI-д харагдана); null = сонгож болно. Эцсийн шалгалт сервер дээр. */
export function selectionBlock(a: { editable: boolean; source: ViewSource; busy: boolean }): SelectionBlock | null {
  const { editable, source, busy } = a;
  if (!editable) return 'notEditable';
  if (source.kind === 'none') return 'noCalculation';
  if (source.kind === 'preview') return source.basis === 'initial' ? 'noCalculation' : 'modified';
  if (source.fallback) return 'modified';
  if (source.calculation.isStale) return 'stale';
  return busy ? 'busy' : null;
}

export type CalculateBlock = 'notEditable' | 'blockers' | 'noTerms';
export function calculateBlock(o: Pick<ScoreOverview, 'editable' | 'blockers' | 'terms'>): CalculateBlock | null {
  if (!o.editable) return 'notEditable';
  if (o.blockers.length > 0) return 'blockers';
  if (o.terms === null) return 'noTerms';
  return null;
}

// ───────────────────────────── автомат сонголтын үндэслэл (FR-8.2, BR-4) ─────────────────────────────

export function autoBasisText(result: UnderwriteResult, tr: Translate): string {
  const { incomeMix: mix, autoSelectReason: reason } = result;
  return tr(`score.autoReason.${reason}`, {
    salary: mix.salaryShare === null ? EMPTY_VALUE : formatShare(mix.salaryShare),
    business: mix.businessShare === null ? EMPTY_VALUE : formatShare(mix.businessShare),
    threshold: formatShare(mix.weightThreshold),
  });
}

// ───────────────────────────── Sosco Score ─────────────────────────────

export const SOSCO_MAX_SCORE = 1000;
export const soscoComponentKey = (k: SoscoComponentKey): string => `score.sosco.component.${k}`;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
/** Progress bar-ын хувь (ЗӨВХӨН дүрслэл): 0..1 → 0..100 */
export const fractionBar = (fraction: number | null | undefined): number => (isNum(fraction) ? clamp(clean(fraction * 100), 0, 100) : 0);
/** Progress bar-ын хувь (ЗӨВХӨН дүрслэл): 0..1000 онооны хэмжүүрт */
export const pointsBar = (points: number | null | undefined): number => (isNum(points) ? clamp(clean((points / SOSCO_MAX_SCORE) * 100), 0, 100) : 0);

/** Бүрэлдэхүүний оролтыг нэгжтэй нь харуулна: dti — аль хэдийн %, ltv — бутархай. */
export function formatSoscoInput(key: SoscoComponentKey, input: number | null | undefined): string {
  if (!isNum(input)) return EMPTY_VALUE;
  switch (key) {
    case 'dti':
      return formatPercentValue(input);
    case 'ltv':
      return formatUpperPercent(input);
    case 'reliability':
      return trimZeros(clean(input));
    default:
      return formatNumber(input);
  }
}

// ───────────────────────────── алдаа ─────────────────────────────

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>([...SCORING_ERROR_CODES, 'VALIDATION_FAILED']);
export const errorKey = (code: string): string => `score.error.${code}`;
/** i18n-д заавал байх алдааны түлхүүрүүд (тестэд шалгана) */
export const ERROR_KEYS: readonly string[] = [...KNOWN_ERROR_CODES, 'UNAUTHENTICATED', 'FORBIDDEN', 'SERVER', 'NETWORK', 'INVALID_RESPONSE', 'UNKNOWN'].map(errorKey);

export interface DescribedError {
  code: string | null;
  message: string;
  /** Дахин оролдох нь утгатай (түр зуурын алдаа): SCORING_UNAVAILABLE, 5xx, сүлжээ */
  retryable: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** ApiError.code (SCORING_ERROR_CODES) → монгол мессеж. Үл мэдэгдэх 4xx бол серверийн мессеж. */
export function describeScoreError(error: unknown, tr: Translate): DescribedError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown; name?: unknown };
  const code = typeof e.code === 'string' ? e.code : null;
  const status = typeof e.status === 'number' ? e.status : null;
  const make = (key: string, retryable: boolean): DescribedError => ({ code, message: tr(errorKey(key)), retryable });

  if (code && KNOWN_ERROR_CODES.has(code)) return make(code, code === 'SCORING_UNAVAILABLE');
  if (status === 401) return make('UNAUTHENTICATED', false);
  if (status === 403) return make('FORBIDDEN', false);
  if (status !== null && status >= 500) return make('SERVER', true);
  if (error instanceof TypeError || (status === 0)) return make('NETWORK', true); // fetch холбогдож чадаагүй
  if (e.name === 'ZodError') return make('INVALID_RESPONSE', true);
  const serverMessage = str(e.message);
  if (status !== null && serverMessage) return { code, message: serverMessage, retryable: false };
  return make('UNKNOWN', false);
}

/** 404/409 — сервер дээрх төлөв манайхаас зөрсөн (тооцоолол хуучирсан гэх мэт) → overview-г дахин татна. */
export function isStaleStateError(error: unknown): boolean {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown };
  return e.status === 404 || e.status === 409 || e.code === 'CALCULATION_STALE' || e.code === 'METHOD_NOT_APPLICABLE';
}
