import { checkLtv } from '@los/calc';
import {
  collateralChecklistLabel,
  type AssetType, type BorrowerRole, type CollateralGate, type CollateralSummary, type EncumbranceCheckView, type GateIssue, type GateIssueCode,
  type OwnershipCheck, type ProductCollateralChecklist, type ValuationSource,
} from '@los/contracts';
import { OWNER_ROLES, REGISTER_PLEDGOR_HINT } from './collateral.constants';

// G0 хаалт (docs/01 §G0, docs/05 §6, FR-6.4–6.8, FR-14.3–14.4). ЦЭВЭР функц: I/O, цаг, DB байхгүй — цагийг `now`, босгыг `settings`/`product`-оор авна.
// Алхам `collateral`: gate.complete → COMPLETED, үгүй бол PENDING (collateral-steps.ts).

const DAY_MS = 86_400_000;

export interface GateProduct {
  requiresCollateral: boolean;
  /** `product.max_ltv`; null → setting `br3.ltv_max`. */
  maxLtv: number | null;
  /** `product.external_valuation_threshold`: зах зээлийн үнэ энээс (≥) дээш бол гадны лицензтэй үнэлгээ заавал (FR-14.3). */
  externalValuationThreshold: number | null;
  /** `product.collateral_checklist_json` (хөрөнгийн төрлөөр). null → checklist байхгүй. */
  collateralChecklist: ProductCollateralChecklist | null;
}

export interface GateCollateralInput {
  id: string;
  assetType: AssetType;
  ownerCustomerId: string | null;
  /** Өмчлөгчийн хүсэлтэд эзэлж буй дүр (PRIMARY > CO_BORROWER > PLEDGOR > GUARANTOR); оролцогч биш бол null. */
  ownerRole: BorrowerRole | null;
  ownership: OwnershipCheck | null;
  encumbrance: EncumbranceCheckView | null;
  marketValue: number | null;
  collateralValue: number | null;
  valuationId: string | null;
  valuationSource: ValuationSource | null;
  valuedAt: Date | null;
  valuationValidUntil: Date | null;
  externalValuationRequired: boolean;
  /** Хавсаргасан баримтын checklist түлхүүрүүд (давхардахыг зөвшөөрнө). */
  documentKeys: readonly string[];
  releasedAt: Date | null;
}

export interface GateInput {
  now: Date;
  /** null → хүсэлтэд бүтээгдэхүүн сонгоогүй (PRODUCT_MISSING). */
  product: GateProduct | null;
  loanAmount: number | null;
  collaterals: readonly GateCollateralInput[];
  /** `inquiry.stale_days`, `br3.ltv_max` — setting-ээс. */
  settings: { staleDays: number; ltvMax: number };
  /** collateralId → энэ хөрөнгийг барьцаалсан ӨӨР идэвхтэй (илгээгдсэн ба түүнээс хойших) хүсэлтүүдийн дугаар. */
  duplicatePledges?: Readonly<Record<string, readonly string[]>>;
}

export interface GateEvaluation {
  gate: CollateralGate;
  summary: CollateralSummary;
  /** collateralId → тухайн барьцааны issue-ууд (issue-гүй барьцаа байхгүй). */
  perCollateralIssues: Record<string, GateIssue[]>;
}

// ── checklist (FR-6.7) ────────────────────────────────────────────────────────────
export interface ChecklistRule { key: string; required: boolean }

/** `product.collateral_checklist_json[assetType]`: энгийн түлхүүр = заавал; `{key, required}`. Давхардсан түлхүүрийг нэгтгэнэ (заавал давамгайлна). */
export function resolveChecklist(checklist: ProductCollateralChecklist | null | undefined, assetType: AssetType): ChecklistRule[] {
  const out = new Map<string, boolean>();
  for (const item of checklist?.[assetType] ?? []) {
    const key = typeof item === 'string' ? item : item.key;
    const required = typeof item === 'string' ? true : item.required;
    out.set(key, (out.get(key) ?? false) || required);
  }
  return [...out].map(([key, required]) => ({ key, required }));
}

/** Заавал түлхүүр бүрт ≥ 1 баримт байхгүй бол дутуу түлхүүрүүд. */
export function missingChecklistKeys(rules: readonly ChecklistRule[], documentKeys: readonly string[]): string[] {
  const have = new Set(documentKeys);
  return rules.filter((r) => r.required && !have.has(r.key)).map((r) => r.key);
}

// ── үнэлгээ (FR-14) ───────────────────────────────────────────────────────────────
type ValuationFields = Pick<GateCollateralInput, 'marketValue' | 'collateralValue' | 'valuationId' | 'valuationSource' | 'valuedAt'>;

/** Үнэлэгдсэн = үнэлгээний бичлэг + дүн + огноо + эх сурвалж бүгд бий. */
export const isValued = (c: ValuationFields): c is ValuationFields & { marketValue: number; collateralValue: number; valuationId: string; valuationSource: ValuationSource; valuedAt: Date } =>
  !!c.valuationId && !!c.valuationSource && c.valuedAt != null && c.marketValue != null && c.collateralValue != null;

/** Гадны лицензтэй үнэлгээ заавал эсэх: valuation-ий тэмдэглэсэн (хадгалагдсан) эсвэл одоогийн бүтээгдэхүүний босго давсан (FR-14.3). */
export function externalValuationRequired(c: Pick<GateCollateralInput, 'marketValue' | 'externalValuationRequired'>, product: Pick<GateProduct, 'externalValuationThreshold'> | null): boolean {
  if (c.externalValuationRequired) return true;
  const threshold = product?.externalValuationThreshold;
  return threshold != null && c.marketValue != null && c.marketValue >= threshold;
}

/** FR-6.8: `checkedAt` нь `staleDays`-аас (>) хуучирсан. Яг `staleDays` хоног хүрэхэд хараахан хуучраагүй. Хэлбэр буруу огноо = хуучирсан. */
export function staleness(checkedAtIso: string, now: Date, staleDays: number): { stale: boolean; ageDays: number | null } {
  const t = Date.parse(checkedAtIso);
  if (Number.isNaN(t)) return { stale: true, ageDays: null };
  const ageMs = now.getTime() - t;
  return { stale: ageMs > staleDays * DAY_MS, ageDays: Math.max(0, Math.floor(ageMs / DAY_MS)) };
}

const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`;
const mnt = (v: number): string => `${Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}₮`;
const round2 = (v: number): number => Math.round(v * 100) / 100;

const MSG = {
  PRODUCT_MISSING: 'Бүтээгдэхүүн сонгоогүй байна (4-р алхам). Барьцааны шаардлагыг бүтээгдэхүүнээр тодорхойлно',
  NO_COLLATERAL: 'Энэ бүтээгдэхүүн барьцаа шаардах тул дор хаяж нэг барьцаа хөрөнгө нэмнэ үү',
  LOAN_AMOUNT_MISSING: 'Зээлийн дүн тодорхойгүй тул LTV тооцох боломжгүй (4-р алхам)',
  OWNERSHIP_NOT_CHECKED: 'Өмчлөлийг шалгаагүй байна',
  OWNER_MISMATCH: 'Хөрөнгийн бүртгэлийн өмчлөгч сонгосон барьцаалагчтай таарахгүй байна',
  OWNER_NOT_ON_APPLICATION: `Өмчлөгч хүсэлтийн барьцаалагч (оролцогч) биш байна. ${REGISTER_PLEDGOR_HINT}`,
  ENCUMBRANCE_NOT_CHECKED: 'Ачааллыг (ЗМС, ЭБ) шалгаагүй байна',
  ENCUMBERED: 'Хөрөнгө өөр байгууллагад барьцаалагдсан байна',
  ENCUMBRANCE_DISPUTED: 'Хөрөнгө маргаантай эсвэл битүүмжлэгдсэн байна',
  NOT_VALUED: 'Үнэлгээ хийгдээгүй байна',
  EXTERNAL_VALUATION_REQUIRED: 'Зах зээлийн үнэ босгоос дээш тул лицензтэй гадны үнэлгээ заавал шаардлагатай',
} as const;

const issue = (code: GateIssueCode, collateralId: string | null, message: string, details?: Record<string, unknown>): GateIssue => ({ code, collateralId, message, ...(details ? { details } : {}) });

/** Тухайн барьцааны G0 issue-ууд (docs/05 §6 хүснэгтийн дарааллаар). */
function collateralIssues(c: GateCollateralInput, ctx: { now: Date; product: GateProduct | null; staleDays: number; duplicates: readonly string[] }): GateIssue[] {
  const out: GateIssue[] = [];
  const { now, product, staleDays } = ctx;

  // FR-6.5 өмчлөл. Өмчлөгч хүсэлтийн оролцогч (PRIMARY, CO_BORROWER, PLEDGOR) биш болсон бол хуучин "VERIFIED" ч хүчингүй.
  const ownerEligible = c.ownerCustomerId != null && c.ownerRole != null && (OWNER_ROLES as readonly string[]).includes(c.ownerRole);
  if (!ownerEligible) {
    out.push(issue('OWNER_NOT_ON_APPLICATION', c.id, MSG.OWNER_NOT_ON_APPLICATION, { ownerRole: c.ownerRole }));
  } else if (!c.ownership) {
    out.push(issue('OWNERSHIP_NOT_CHECKED', c.id, MSG.OWNERSHIP_NOT_CHECKED));
  } else if (c.ownership.status !== 'VERIFIED') {
    const code: GateIssueCode = c.ownership.status === 'OWNER_MISMATCH' ? 'OWNER_MISMATCH' : 'OWNER_NOT_ON_APPLICATION';
    out.push(issue(code, c.id, c.ownership.message ?? MSG[code], { checkedAt: c.ownership.checkedAt }));
  } else {
    const s = staleness(c.ownership.checkedAt, now, staleDays);
    if (s.stale) out.push(issue('OWNERSHIP_STALE', c.id, `Өмчлөлийн лавлагаа ${staleDays} хоногоос хуучирсан тул дахин шалгана уу`, { checkedAt: c.ownership.checkedAt, ageDays: s.ageDays, staleDays }));
  }

  // FR-6.6 ачаалал.
  if (!c.encumbrance) {
    out.push(issue('ENCUMBRANCE_NOT_CHECKED', c.id, MSG.ENCUMBRANCE_NOT_CHECKED));
  } else if (c.encumbrance.status === 'ENCUMBERED') {
    out.push(issue('ENCUMBERED', c.id, MSG.ENCUMBERED, { checkedAt: c.encumbrance.checkedAt, pledgees: c.encumbrance.sources.map((s) => s.pledgee).filter((p): p is string => !!p) }));
  } else if (c.encumbrance.status === 'DISPUTED') {
    out.push(issue('ENCUMBRANCE_DISPUTED', c.id, MSG.ENCUMBRANCE_DISPUTED, { checkedAt: c.encumbrance.checkedAt }));
  } else {
    const s = staleness(c.encumbrance.checkedAt, now, staleDays);
    if (s.stale) out.push(issue('ENCUMBRANCE_STALE', c.id, `Ачааллын лавлагаа ${staleDays} хоногоос хуучирсан тул дахин шалгана уу`, { checkedAt: c.encumbrance.checkedAt, ageDays: s.ageDays, staleDays }));
  }

  // FR-6.6 давхар барьцаа (өөр идэвхтэй хүсэлтэд).
  if (ctx.duplicates.length) {
    out.push(issue('DUPLICATE_PLEDGE', c.id, `Энэ хөрөнгө өөр идэвхтэй хүсэлтэд (${ctx.duplicates.join(', ')}) барьцаалагдсан байна`, { applicationNos: [...ctx.duplicates] }));
  }

  // FR-6.7 баримтын checklist.
  if (product) {
    const missing = missingChecklistKeys(resolveChecklist(product.collateralChecklist, c.assetType), c.documentKeys);
    if (missing.length) out.push(issue('CHECKLIST_INCOMPLETE', c.id, `Заавал баримт дутуу: ${missing.map(collateralChecklistLabel).join(', ')}`, { missing }));
  }

  // FR-14.3 үнэлгээ.
  if (!isValued(c)) {
    out.push(issue('NOT_VALUED', c.id, MSG.NOT_VALUED));
  } else {
    if (c.valuationValidUntil && now.getTime() > c.valuationValidUntil.getTime())
      out.push(issue('VALUATION_EXPIRED', c.id, `Үнэлгээний хүчинтэй хугацаа ${c.valuationValidUntil.toISOString().slice(0, 10)}-нд дууссан тул дахин үнэлнэ үү`, { validUntil: c.valuationValidUntil.toISOString() }));
    if (externalValuationRequired(c, product) && c.valuationSource !== 'EXTERNAL_LICENSED')
      out.push(issue('EXTERNAL_VALUATION_REQUIRED', c.id, MSG.EXTERNAL_VALUATION_REQUIRED, { marketValue: c.marketValue, threshold: product?.externalValuationThreshold ?? null }));
  }
  return out;
}

/**
 * G0: хүсэлтийн барьцааг бүхэлд нь үнэлнэ.
 *  - Чөлөөлөгдсөн (`releasedAt`) барьцааг тооцохгүй.
 *  - Бүтээгдэхүүн барьцаа шаардахгүй (`requires_collateral=false`) ба барьцаа алга → `skipped` + `complete` (FR-6.4).
 *  - LTV = зээл ÷ Σ барьцааны үнэлгээ, дээд = `product.maxLtv ?? settings.ltvMax`; `LTV_EXCEEDED` нь LTV тооцогдсон (≥ 1 үнэлэгдсэн барьцаа, зээлийн дүн бий) үед л.
 */
export function evaluateCollateralGate(input: GateInput): GateEvaluation {
  const { now, product, settings } = input;
  const active = input.collaterals.filter((c) => c.releasedAt == null);
  const loan = typeof input.loanAmount === 'number' && Number.isFinite(input.loanAmount) && input.loanAmount > 0 ? input.loanAmount : null;
  const requiresCollateral = product ? product.requiresCollateral : true;
  const ltvLimit = product?.maxLtv ?? settings.ltvMax;

  const issues: GateIssue[] = [];
  const perCollateralIssues: Record<string, GateIssue[]> = {};
  const push = (i: GateIssue): void => {
    issues.push(i);
    if (i.collateralId) (perCollateralIssues[i.collateralId] ??= []).push(i);
  };

  if (!product) push(issue('PRODUCT_MISSING', null, MSG.PRODUCT_MISSING));
  else if (requiresCollateral && active.length === 0) push(issue('NO_COLLATERAL', null, MSG.NO_COLLATERAL));
  const skipped = !!product && !requiresCollateral && active.length === 0;
  if (active.length > 0 && loan == null) push(issue('LOAN_AMOUNT_MISSING', null, MSG.LOAN_AMOUNT_MISSING));

  for (const c of active) {
    for (const i of collateralIssues(c, { now, product, staleDays: settings.staleDays, duplicates: input.duplicatePledges?.[c.id] ?? [] })) push(i);
  }

  const values = active.map((c) => (isValued(c) ? c.collateralValue : null));
  const check = checkLtv(loan, values, ltvLimit);
  // `checkLtv`: үнэлгээний нийлбэр 0 ба зээл > 0 үед pass=false боловч ltv=null — энэ нь "тооцох боломжгүй" (NOT_VALUED аль хэдийн тусгагдсан).
  const ltvPass = check.ltv == null ? null : check.pass;
  if (check.ltv != null && ltvPass === false) {
    push(issue('LTV_EXCEEDED', null, `LTV ${pct(check.ltv)} нь дээд хязгаар ${pct(ltvLimit)}-аас хэтэрсэн (зээл ${mnt(loan as number)}, барьцааны үнэлгээний нийлбэр ${mnt(check.totalCollateralValue)})`, {
      ltv: check.ltv, limit: ltvLimit, loanAmount: loan, totalCollateralValue: check.totalCollateralValue,
    }));
  }

  const summary: CollateralSummary = {
    count: active.length,
    totalMarketValue: round2(active.reduce((s, c) => s + (isValued(c) ? c.marketValue : 0), 0)),
    totalCollateralValue: check.totalCollateralValue,
    loanAmount: loan,
    ltv: check.ltv,
    ltvLimit,
    ltvPass,
    requiresCollateral,
  };
  return {
    gate: { complete: issues.length === 0, skipped, issues, evaluatedAt: now.toISOString() },
    summary,
    perCollateralIssues,
  };
}
