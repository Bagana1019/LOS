import {
  ExternalValuationRequest, GateIssueCode, RegisterPledgeRequest, SaveValuationRequest,
  type AssetType, type BorrowerRole, type BorrowerView, type CollateralSummary, type CollateralView, type GateIssue, type ValuationSuggestion,
} from '@los/contracts';
import { hasMessage, t } from '../../lib/i18n';
import { mapZodIssues, zodIssueMessage, type BuildResult, type FieldError } from './collateral.form';

// Цэвэр логик (React, antd-ээс хамааралгүй) — vitest-ээр тестлэнэ. FR-6.1–6.9, FR-14.1–14.3, G0 (docs/05 §3, §6).
// UI-д санхүүгийн тооцоолол хийхгүй: LTV, haircut, G0 дүгнэлт бүгд API-аас; энд зөвхөн харуулах хэлбэр, сонголт, шалгалтын UX.

export const assetTypeKey = (a: AssetType): string => `collateral.assetType.${a}`;
export const roleKey = (r: BorrowerRole): string => `collateral.role.${r}`;

export const stepHref = (applicationId: string, step: 'client' | 'loan' | 'collateral'): string => `/los/loan-application/${encodeURIComponent(applicationId)}/${step}`;

// ── G0 дутагдал (GateIssue) ────────────────────────────────────────────────────────────────
export type IssueSeverity = 'error' | 'warning';
export type DetailTab = 'overview' | 'checks' | 'valuation' | 'documents' | 'registry';
export type IssueTarget = { kind: 'tab'; tab: DetailTab } | { kind: 'step'; step: 'client' | 'loan' } | { kind: 'add' };

/** Хаах (шийдвэрлэх боломжгүй эсвэл эрсдэлтэй) → error; үлдсэн "хийгээгүй/дутуу" → warning. `Record<GateIssueCode,…>` — гэрээнд код нэмэгдвэл compile алдаа өгнө. */
export const ISSUE_SEVERITY: Record<GateIssueCode, IssueSeverity> = {
  PRODUCT_MISSING: 'warning',
  LOAN_AMOUNT_MISSING: 'warning',
  NO_COLLATERAL: 'warning',
  OWNERSHIP_NOT_CHECKED: 'warning',
  OWNERSHIP_STALE: 'warning',
  OWNER_MISMATCH: 'error',
  OWNER_NOT_ON_APPLICATION: 'error',
  ENCUMBRANCE_NOT_CHECKED: 'warning',
  ENCUMBRANCE_STALE: 'warning',
  ENCUMBERED: 'error',
  ENCUMBRANCE_DISPUTED: 'error',
  DUPLICATE_PLEDGE: 'error',
  CHECKLIST_INCOMPLETE: 'warning',
  NOT_VALUED: 'warning',
  VALUATION_EXPIRED: 'warning',
  EXTERNAL_VALUATION_REQUIRED: 'warning',
  LTV_EXCEEDED: 'error',
};

export const ISSUE_TARGET: Record<GateIssueCode, IssueTarget> = {
  PRODUCT_MISSING: { kind: 'step', step: 'loan' },
  LOAN_AMOUNT_MISSING: { kind: 'step', step: 'loan' },
  NO_COLLATERAL: { kind: 'add' },
  OWNERSHIP_NOT_CHECKED: { kind: 'tab', tab: 'checks' },
  OWNERSHIP_STALE: { kind: 'tab', tab: 'checks' },
  OWNER_MISMATCH: { kind: 'tab', tab: 'checks' },
  OWNER_NOT_ON_APPLICATION: { kind: 'step', step: 'client' },
  ENCUMBRANCE_NOT_CHECKED: { kind: 'tab', tab: 'checks' },
  ENCUMBRANCE_STALE: { kind: 'tab', tab: 'checks' },
  ENCUMBERED: { kind: 'tab', tab: 'checks' },
  ENCUMBRANCE_DISPUTED: { kind: 'tab', tab: 'checks' },
  DUPLICATE_PLEDGE: { kind: 'tab', tab: 'overview' },
  CHECKLIST_INCOMPLETE: { kind: 'tab', tab: 'documents' },
  NOT_VALUED: { kind: 'tab', tab: 'valuation' },
  VALUATION_EXPIRED: { kind: 'tab', tab: 'valuation' },
  EXTERNAL_VALUATION_REQUIRED: { kind: 'tab', tab: 'valuation' },
  LTV_EXCEEDED: { kind: 'tab', tab: 'valuation' },
};

export const ISSUE_CODES: readonly GateIssueCode[] = GateIssueCode;
export const issueTitleKey = (code: string): string => `collateral.issue.${code}.title`;
export const issueHintKey = (code: string): string => `collateral.issue.${code}.hint`;

export interface DescribedIssue {
  code: GateIssueCode;
  severity: IssueSeverity;
  /** i18n гарчиг; код үл мэдэгдэх (шинэ) бол API-ийн мессеж. */
  title: string;
  /** API-ийн монгол мессеж (тоо, хүсэлтийн дугаар зэрэг тодорхой мэдээлэлтэй); гарчигтай ижил бол null. */
  message: string | null;
  /** Юу хийх вэ — i18n; байхгүй бол null. */
  hint: string | null;
  collateralId: string | null;
  target: IssueTarget | null;
}

export function describeIssue(issue: GateIssue): DescribedIssue {
  const known = hasMessage(issueTitleKey(issue.code));
  const title = known ? t(issueTitleKey(issue.code)) : issue.message;
  return {
    code: issue.code,
    severity: ISSUE_SEVERITY[issue.code] ?? 'warning',
    title,
    message: issue.message && issue.message !== title ? issue.message : null,
    hint: hasMessage(issueHintKey(issue.code)) ? t(issueHintKey(issue.code)) : null,
    collateralId: issue.collateralId,
    target: ISSUE_TARGET[issue.code] ?? null,
  };
}

/** Хүсэлтийн түвшний дутагдал (collateralId=null) эхэнд, дараа нь барьцааны жагсаалтын дарааллаар; тухайн барьцаанд API-ийн дарааллаар. */
export function sortIssues(issues: readonly GateIssue[], collateralIds: readonly string[]): GateIssue[] {
  const rank = (i: GateIssue): number => (i.collateralId === null ? -1 : collateralIds.indexOf(i.collateralId) === -1 ? collateralIds.length : collateralIds.indexOf(i.collateralId));
  return issues.map((issue, index) => ({ issue, index })).sort((a, b) => rank(a.issue) - rank(b.issue) || a.index - b.index).map((x) => x.issue);
}

// ── төлвийн шошго ────────────────────────────────────────────────────────────────────────
export type Tone = 'success' | 'warning' | 'error' | 'default';
export interface StatusView {
  tone: Tone;
  /** i18n түлхүүр. */
  textKey: string;
}

const hasIssue = (c: Pick<CollateralView, 'issues'>, ...codes: GateIssueCode[]): boolean => c.issues.some((i) => codes.includes(i.code));

export function ownershipStatus(c: Pick<CollateralView, 'ownership' | 'issues'>): StatusView {
  if (!c.ownership) return { tone: 'warning', textKey: 'collateral.status.ownership.NOT_CHECKED' };
  if (c.ownership.status === 'VERIFIED') return hasIssue(c, 'OWNERSHIP_STALE') ? { tone: 'warning', textKey: 'collateral.status.ownership.STALE' } : { tone: 'success', textKey: 'collateral.status.ownership.VERIFIED' };
  return { tone: 'error', textKey: `collateral.status.ownership.${c.ownership.status}` };
}

export function encumbranceStatus(c: Pick<CollateralView, 'encumbrance' | 'issues'>): StatusView {
  if (!c.encumbrance) return { tone: 'warning', textKey: 'collateral.status.encumbrance.NOT_CHECKED' };
  if (c.encumbrance.status === 'CLEAR') return hasIssue(c, 'ENCUMBRANCE_STALE') ? { tone: 'warning', textKey: 'collateral.status.encumbrance.STALE' } : { tone: 'success', textKey: 'collateral.status.encumbrance.CLEAR' };
  return { tone: 'error', textKey: `collateral.status.encumbrance.${c.encumbrance.status}` };
}

export function valuationStatus(c: Pick<CollateralView, 'valuation'>): StatusView {
  const v = c.valuation;
  if (!v) return { tone: 'warning', textKey: 'collateral.status.valuation.NOT_VALUED' };
  if (v.expired) return { tone: 'error', textKey: 'collateral.status.valuation.EXPIRED' };
  if (v.externalRequired && !v.externalSatisfied) return { tone: 'warning', textKey: 'collateral.status.valuation.EXTERNAL_REQUIRED' };
  return { tone: 'success', textKey: v.source === 'EXTERNAL_LICENSED' ? 'collateral.status.valuation.EXTERNAL' : 'collateral.status.valuation.VALUED' };
}

export interface ChecklistProgress {
  required: number;
  satisfied: number;
  complete: boolean;
}
/** Заавал баримтуудын гүйцэтгэл (тоолол, харуулалт). */
export function checklistProgress(c: Pick<CollateralView, 'checklist'>): ChecklistProgress {
  const required = c.checklist.filter((i) => i.required);
  const satisfied = required.filter((i) => i.satisfied).length;
  return { required: required.length, satisfied, complete: satisfied === required.length };
}

// ── G0 / LTV ─────────────────────────────────────────────────────────────────────────────
export type GateState = 'complete' | 'skipped' | 'incomplete';
export const gateState = (gate: { complete: boolean; skipped: boolean }): GateState => (gate.skipped ? 'skipped' : gate.complete ? 'complete' : 'incomplete');

/** LTV-ийн өнгө — шийдвэр API-ийн `ltvPass`-аас (UI харьцуулахгүй). */
export const ltvTone = (summary: Pick<CollateralSummary, 'ltvPass'>): Tone => (summary.ltvPass === true ? 'success' : summary.ltvPass === false ? 'error' : 'default');

// ── өмчлөл / ачааллын шалгалтын арга (FR-6.5, FR-6.6) ──────────────────────────────────────
export type CheckMethod = 'REGISTRY' | 'DECLARED';
// Origination-ий collateral-ownership.ts-тэй нийцнэ (бүртгэл байгаа төрөл). Шинэ бүртгэл холбогдвол ТЭНД болон тэнд нэмнэ; эцсийн шалгалт API (422 REGISTRY_NOT_AVAILABLE / DECLARED_NOT_ALLOWED).
const OWNERSHIP_REGISTRY_TYPES: readonly AssetType[] = ['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND'];
const ENCUMBRANCE_REGISTRY_TYPES: readonly AssetType[] = ['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND', 'EQUIPMENT'];
const REGISTERED_ASSET_TYPES: readonly AssetType[] = ['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND'];

export const ownershipMethods = (a: AssetType): CheckMethod[] => (OWNERSHIP_REGISTRY_TYPES.includes(a) ? ['REGISTRY'] : ['DECLARED']);
export const encumbranceMethods = (a: AssetType): CheckMethod[] => {
  const out: CheckMethod[] = [];
  if (ENCUMBRANCE_REGISTRY_TYPES.includes(a)) out.push('REGISTRY');
  if (!REGISTERED_ASSET_TYPES.includes(a)) out.push('DECLARED');
  return out;
};

// ── өмчлөгч сонгох (оролцогчид) ─────────────────────────────────────────────────────────────
/** docs/05 §3.1: барьцаалагч байж болох дүрүүд (OWNER_NOT_PLEDGOR). Батлан даагч өөрөө өмчлөгч бол "Барьцаалагч" дүрээр бас бүртгэнэ. */
const OWNER_ROLES: readonly BorrowerRole[] = ['PRIMARY', 'CO_BORROWER', 'PLEDGOR'];
const ROLE_ORDER: readonly BorrowerRole[] = ['PRIMARY', 'CO_BORROWER', 'PLEDGOR', 'GUARANTOR'];

export interface OwnerOption {
  customerId: string;
  name: string;
  registerMasked: string;
  roles: BorrowerRole[];
  eligible: boolean;
}

/** Нэг харилцагч хэд хэдэн дүртэй байж болно (жишээ нь батлан даагч + барьцаалагч) — харилцагчаар нэгтгэнэ. */
export function ownerOptions(items: readonly Pick<BorrowerView, 'customerId' | 'role' | 'customer'>[]): OwnerOption[] {
  const byCustomer = new Map<string, OwnerOption>();
  for (const item of items) {
    const existing = byCustomer.get(item.customerId);
    if (existing) {
      existing.roles.push(item.role);
      continue;
    }
    byCustomer.set(item.customerId, { customerId: item.customerId, name: item.customer.displayName, registerMasked: item.customer.registerNoMasked, roles: [item.role], eligible: false });
  }
  const out = [...byCustomer.values()];
  for (const o of out) {
    o.roles.sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
    o.eligible = o.roles.some((r) => OWNER_ROLES.includes(r));
  }
  return out.sort((a, b) => ROLE_ORDER.indexOf(a.roles[0] as BorrowerRole) - ROLE_ORDER.indexOf(b.roles[0] as BorrowerRole));
}

/** Нэг л боломжит өмчлөгч эсвэл үндсэн зээлдэгч байвал урьдчилан сонгоно. */
export function defaultOwnerId(options: readonly OwnerOption[]): string | undefined {
  const eligible = options.filter((o) => o.eligible);
  return (eligible.find((o) => o.roles.includes('PRIMARY')) ?? (eligible.length === 1 ? eligible[0] : undefined))?.customerId;
}

// ── үнэлгээ (FR-14.1–14.3) ────────────────────────────────────────────────────────────────
/**
 * Системийн саналаас ялгаатай (эсвэл санал байхгүй) дүн оруулбал шалтгаан заавал (FR-14.2). Гараар оруулдаг төрөлд (бараа, тоног төхөөрөмж, бусад) шаардахгүй.
 * Санал хараахан авагдаагүй үед (хэрэглэгч дүн бичсэн) консерватив: шаардана. Эцсийн шалгалт API (422 OVERRIDE_REASON_REQUIRED).
 */
export function overrideReasonRequired(args: { manualValueRequired: boolean; suggestion: ValuationSuggestion | null; marketValue: number | null | undefined }): boolean {
  const { manualValueRequired, suggestion, marketValue } = args;
  if (typeof marketValue !== 'number' || !Number.isFinite(marketValue)) return false;
  if (manualValueRequired) return false;
  if (!suggestion || !suggestion.available || suggestion.marketValue === null) return true;
  return marketValue !== suggestion.marketValue;
}

export const MIN_OVERRIDE_REASON = 3;

export interface ValuationDraft {
  assetType: AssetType;
  marketValue: number | null | undefined;
  overrideReason: string | null | undefined;
  mileageKm: number | null | undefined;
  suggestion: ValuationSuggestion | null;
  manualValueRequired: boolean;
}

export type ValuationField = 'marketValue' | 'overrideReason' | 'mileageKm';
export type ValuationBuild = { ok: true; body: SaveValuationRequest } | { ok: false; errors: Array<{ field: ValuationField; message: string }> };

/**
 * Хадгалах хүсэлт. `marketValue`-г зөвхөн ЗЭЗ санал өөрчилсөн / санал байхгүй үед илгээнэ — үгүй бол сервер өөрийн саналыг хэрэглэнэ
 * (хоёр дуудлагын хооронд суурь үнэ өөрчлөгдсөн ч "хүн өөрчилсөн" гэж андуурахгүй).
 */
export function buildSaveValuationRequest(d: ValuationDraft): ValuationBuild {
  const errors: Array<{ field: ValuationField; message: string }> = [];
  const hasValue = typeof d.marketValue === 'number' && Number.isFinite(d.marketValue);
  const suggested = d.suggestion?.available && d.suggestion.marketValue !== null ? d.suggestion.marketValue : null;
  const sendValue = hasValue && (d.manualValueRequired || suggested === null || d.marketValue !== suggested);

  if (!hasValue && (d.manualValueRequired || suggested === null)) errors.push({ field: 'marketValue', message: t('collateral.validation.marketValueRequired') });
  const reason = d.overrideReason?.trim() ?? '';
  if (sendValue && overrideReasonRequired({ manualValueRequired: d.manualValueRequired, suggestion: d.suggestion, marketValue: d.marketValue }) && reason.length < MIN_OVERRIDE_REASON) {
    errors.push({ field: 'overrideReason', message: reason.length === 0 ? t('collateral.validation.overrideReasonRequired') : t('collateral.validation.minLength', { min: MIN_OVERRIDE_REASON }) });
  }
  if (errors.length > 0) return { ok: false, errors };

  const candidate: Record<string, unknown> = {};
  if (sendValue) candidate.marketValue = d.marketValue;
  if (sendValue && reason) candidate.overrideReason = reason;
  if (d.assetType === 'VEHICLE' && typeof d.mileageKm === 'number' && Number.isFinite(d.mileageKm)) candidate.mileageKm = d.mileageKm;
  const parsed = SaveValuationRequest.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ field: (['marketValue', 'overrideReason', 'mileageKm'].includes(String(i.path[0])) ? i.path[0] : 'marketValue') as ValuationField, message: zodIssueMessage(i) })) };
  }
  return { ok: true, body: parsed.data };
}

/** Системийн саналын түлхүүр/анхааруулгууд. */
export const suggestionWarningKey = (w: string): string => `collateral.suggestionWarning.${w}`;
export const unavailableReasonKey = (r: string): string => `collateral.unavailableReason.${r}`;
export const isDemoSuggestion = (suggestion: Pick<ValuationSuggestion, 'warnings'>, haircutSource: string | null | undefined): boolean =>
  suggestion.warnings.includes('DEMO_PARAMETERS') || haircutSource === 'DEMO_DEFAULT';

/** Форм дээрх алдааны жагсаалт (талбар → мессеж) → antd setFields. */
export const toFieldErrors = (errors: ReadonlyArray<{ field: string; message: string }>): FieldError[] => errors.map((e) => ({ name: [e.field], message: e.message }));

// ── гадны лицензтэй үнэлгээ (FR-14.3) ─────────────────────────────────────────────────────
export interface ExternalValuationFormValues {
  appraiser?: string | null;
  licenseNo?: string | null;
  valuedAt?: string | null;
  validUntil?: string | null;
  marketValue?: number | null;
  note?: string | null;
}

const blank = (v: string | null | undefined): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Тайлангийн файл (dms-д upload хийсэн) заавал — `reportFileId` дутвал `['reportFileId']` алдаа. */
export function buildExternalValuationRequest(values: ExternalValuationFormValues, reportFileId: string | null | undefined): BuildResult<ExternalValuationRequest> {
  const parsed = ExternalValuationRequest.safeParse({
    appraiser: blank(values.appraiser),
    licenseNo: blank(values.licenseNo),
    valuedAt: blank(values.valuedAt),
    validUntil: blank(values.validUntil),
    marketValue: typeof values.marketValue === 'number' && Number.isFinite(values.marketValue) ? values.marketValue : undefined,
    reportFileId: reportFileId ?? undefined,
    note: blank(values.note),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const errors = mapZodIssues(parsed.error.issues).map((e) => (e.name[0] === 'reportFileId' ? { name: ['reportFileId'], message: t('collateral.validation.reportRequired') } : e));
  return { ok: false, errors };
}

/** ЭБ бүртгэл (FR-6.9). */
export function buildRegisterPledgeRequest(values: { registryNo?: string | null; registryDate?: string | null }): BuildResult<RegisterPledgeRequest> {
  const parsed = RegisterPledgeRequest.safeParse({ registryNo: blank(values.registryNo), registryDate: blank(values.registryDate) });
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, errors: mapZodIssues(parsed.error.issues) };
}
