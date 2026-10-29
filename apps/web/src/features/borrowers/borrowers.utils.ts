import { BorrowerErrorCode, BorrowerRelation, BorrowerRole, GuaranteeType } from '@los/contracts';
import type {
  AddBorrowerRequest,
  BorrowerCandidate,
  BorrowerSummary,
  BorrowerView,
  BorrowerWarning,
  BorrowerWarningCode,
  CustomerType,
  RecordConsentRequest,
  UpdateBorrowerRequest,
} from '@los/contracts';

// Цэвэр логик (React, antd, i18n-ээс хамааралгүй) — vitest-ээр тестлэнэ.
// Текст шаардлагатай газар `Translate` дамжуулна (components нь `t`-ийг өгнө).
// FR-2.1, FR-6.5, FR-10.4, BR-9, BSA-BR-9, NFR-5.

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Үйлдэл хориглогдсон / сонголт боломжгүй шалтгаан (i18n түлхүүр + параметр). */
export interface Reason {
  key: string;
  params?: Record<string, string | number>;
}

// ── дүр, төрлийн түлхүүрүүд ─────────────────────────────────────────────────────────────
export const ROLES: readonly BorrowerRole[] = BorrowerRole;
export const RELATIONS: readonly BorrowerRelation[] = BorrowerRelation;
export const GUARANTEE_TYPES: readonly GuaranteeType[] = GuaranteeType;

export const roleKey = (role: BorrowerRole): string => `borrower.role.${role}`;
export const roleHintKey = (role: BorrowerRole): string => `borrower.roleHint.${role}`;
export const relationKey = (relation: BorrowerRelation): string => `borrower.relation.${relation}`;
export const guaranteeTypeKey = (type: GuaranteeType): string => `borrower.guaranteeType.${type}`;
export const customerTypeKey = (type: CustomerType): string => `borrower.customerType.${type}`;

export const ROLE_COLOR: Record<BorrowerRole, string> = { PRIMARY: 'blue', CO_BORROWER: 'geekblue', GUARANTOR: 'purple', PLEDGOR: 'gold' };

const DEFAULT_GUARANTEE_TYPE: GuaranteeType = 'JOINT_AND_SEVERAL';

// ── тоо, хувь, мөнгө, огноо ───────────────────────────────────────────────────────────
/** 0.3333 → 33.33. Хувь DB-д numeric(7,4) тул 1/10000 нарийвчлалтай. */
export const shareToPercent = (share: number): number => Math.round(share * 10_000) / 100;
/** 33.33 → 0.3333 (хөвөгч таслалтын алдаагүй). */
export const percentToShare = (percent: number): number => Math.round(percent * 100) / 10_000;
export const formatPercent = (share: number): string => `${shareToPercent(share)}%`;
const roundMoney = (v: number): number => Math.round(v * 100) / 100;

/** Монгол төгрөг: 1,250,000 ₮ (formatMoney-той ижил харагдана; Intl-ээс хамаарахгүй тул тестэд тогтвортой). */
export function formatAmount(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${grouped}${dec === '00' ? '' : `.${dec}`} ₮`;
}

/** InputNumber-ийн formatter: 1250000.5 → "1,250,000.5". */
export function groupDigits(value: number | string | undefined | null): string {
  if (value === undefined || value === null || value === '') return '';
  const [int, dec] = String(value).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? `${grouped}.${dec}` : grouped;
}

const UB_TIME_ZONE = 'Asia/Ulaanbaatar';
// Улаанбаатар UTC+8 (2017 оноос зуны цаггүй). Хөтчийн цагийн бүсээс үл хамааран бүх огноо УБ цагаар.
const UB_OFFSET = '+08:00';

function ubParts(date: Date): Record<'year' | 'month' | 'day' | 'hour' | 'minute', string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: UB_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** ISO instant → "2026-10-28 17:10" (Asia/Ulaanbaatar). */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p = ubParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** ISO instant → <input type="datetime-local"> утга ("2026-10-28T17:10", УБ цагаар). */
export function toUbInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const p = ubParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** <input type="datetime-local"> утга (УБ цаг) → Date. Буруу хэлбэр бол null. */
export function fromUbInputValue(value: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const date = new Date(`${m[1]}:00${UB_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── регистр хайлт ─────────────────────────────────────────────────────────────────────
export const REGISTER_MAX_LENGTH = 32;
/** Backend blind index нь trim + том үсэг; дунд зайг бид цэвэрлэнэ ("уб 99010112" → "УБ99010112"). */
export const normalizeRegisterNo = (raw: string): string => raw.replace(/\s+/g, '').toUpperCase();
export const isSearchableRegisterNo = (normalized: string): boolean => normalized.length > 0 && normalized.length <= REGISTER_MAX_LENGTH;

// ── талбарын харагдац (дүрээс хамаарна) ───────────────────────────────────────────────────
export type FieldKey = 'relationToPrimary' | 'liabilityShare' | 'guaranteeType' | 'guaranteeAmount' | 'incomeIncluded' | 'note';

/** Баталгааны төрөл зөвхөн GUARANTOR-д; өгөөгүй бол бүрэн (хамтран хариуцах). */
export const effectiveGuaranteeType = (role: BorrowerRole | undefined, type: GuaranteeType | null | undefined): GuaranteeType | null =>
  role === 'GUARANTOR' ? type ?? DEFAULT_GUARANTEE_TYPE : null;

/**
 * Backend-ийн checkRoleFields-тэй уялдсан: relationToPrimary — PRIMARY-д үгүй; liabilityShare — зөвхөн CO_BORROWER;
 * guaranteeType/Amount — зөвхөн GUARANTOR (дүн нь зөвхөн LIMITED); incomeIncluded — зөвхөн PRIMARY/CO_BORROWER (BSA-BR-9).
 */
export function visibleFields(role: BorrowerRole | undefined, guaranteeType?: GuaranteeType | null): Record<FieldKey, boolean> {
  if (!role) return { relationToPrimary: false, liabilityShare: false, guaranteeType: false, guaranteeAmount: false, incomeIncluded: false, note: false };
  return {
    relationToPrimary: role !== 'PRIMARY',
    liabilityShare: role === 'CO_BORROWER',
    guaranteeType: role === 'GUARANTOR',
    guaranteeAmount: effectiveGuaranteeType(role, guaranteeType) === 'LIMITED',
    incomeIncluded: role === 'PRIMARY' || role === 'CO_BORROWER',
    note: true,
  };
}

export const defaultIncomeIncluded = (role: BorrowerRole): boolean => role === 'PRIMARY' || role === 'CO_BORROWER';

export interface BorrowerFormValues {
  role?: BorrowerRole;
  relationToPrimary?: BorrowerRelation | null;
  /** UI-д хувь (0.01–100); хүсэлтэд 0–1 болгож явуулна. */
  liabilityPercent?: number | null;
  guaranteeType?: GuaranteeType | null;
  guaranteeAmount?: number | null;
  incomeIncluded?: boolean;
  note?: string | null;
}

/** Дүр сонгох/солиход талбаруудыг тухайн дүрийн анхдагч утгад буцаана. */
export function roleDefaults(role: BorrowerRole): BorrowerFormValues {
  return {
    liabilityPercent: null,
    guaranteeType: effectiveGuaranteeType(role, null),
    guaranteeAmount: null,
    incomeIncluded: defaultIncomeIncluded(role),
    ...(role === 'PRIMARY' ? { relationToPrimary: null } : {}),
  };
}

export function initialFormValues(b: BorrowerView): BorrowerFormValues {
  return {
    role: b.role,
    relationToPrimary: b.relationToPrimary,
    liabilityPercent: b.liabilityShare == null ? null : shareToPercent(b.liabilityShare),
    guaranteeType: effectiveGuaranteeType(b.role, b.guaranteeType),
    guaranteeAmount: b.guaranteeAmount,
    incomeIncluded: b.incomeIncluded,
    note: b.note,
  };
}

const cleanNote = (note: string | null | undefined): string | null => {
  const s = note?.trim();
  return s ? s : null;
};

/** Хамтран зээлдэгчдийн хувийн нийлбэрийн үлдэгдэл (%), `excludeId`-г тооцохгүй. */
export function remainingSharePercent(items: ReadonlyArray<Pick<BorrowerView, 'id' | 'role' | 'liabilityShare'>>, excludeId?: string): number {
  const usedBp = items
    .filter((i) => i.role === 'CO_BORROWER' && i.id !== excludeId && i.liabilityShare != null)
    .reduce((sum, i) => sum + Math.round((i.liabilityShare as number) * 10_000), 0);
  return Math.max(0, 10_000 - usedBp) / 100;
}

// ── хүсэлт бүрдүүлэх ──────────────────────────────────────────────────────────────────
/** Формоос POST body. Дүрд хамаарахгүй (нуугдсан) талбарыг хэзээ ч явуулахгүй. */
export function buildAddRequest(customerId: string, v: BorrowerFormValues): AddBorrowerRequest | null {
  const role = v.role;
  if (!role) return null;
  const type = effectiveGuaranteeType(role, v.guaranteeType);
  const f = visibleFields(role, type);
  const req: AddBorrowerRequest = { customerId, role };
  if (f.relationToPrimary && v.relationToPrimary) req.relationToPrimary = v.relationToPrimary;
  if (f.liabilityShare && v.liabilityPercent != null) req.liabilityShare = percentToShare(v.liabilityPercent);
  if (f.guaranteeType && type) req.guaranteeType = type;
  if (f.guaranteeAmount && v.guaranteeAmount != null) req.guaranteeAmount = roundMoney(v.guaranteeAmount);
  if (f.incomeIncluded) req.incomeIncluded = v.incomeIncluded ?? defaultIncomeIncluded(role);
  const note = cleanNote(v.note);
  if (note) req.note = note;
  return req;
}

/**
 * PATCH body: зөвхөн өөрчлөгдсөн талбар. `null` = арилгана, тухайн түлхүүр байхгүй = хэвээр (backend-ийн семантик).
 * Өөрчлөлт огт байхгүй бол null (хоосон PATCH 400 өгдөг).
 */
export function buildUpdateRequest(original: BorrowerView, v: BorrowerFormValues): UpdateBorrowerRequest | null {
  const patch: UpdateBorrowerRequest = {};
  const role = original.role;
  const f = visibleFields(role, v.guaranteeType ?? original.guaranteeType);

  if (f.relationToPrimary) {
    const next = v.relationToPrimary ?? null;
    if (next !== original.relationToPrimary) patch.relationToPrimary = next;
  }
  if (f.liabilityShare) {
    const next = v.liabilityPercent == null ? null : percentToShare(v.liabilityPercent);
    const before = original.liabilityShare == null ? null : Math.round(original.liabilityShare * 10_000) / 10_000;
    if (next !== before) patch.liabilityShare = next;
  }
  if (role === 'GUARANTOR') {
    const beforeType = effectiveGuaranteeType(role, original.guaranteeType);
    const nextType = effectiveGuaranteeType(role, v.guaranteeType);
    if (nextType !== beforeType) patch.guaranteeType = nextType;
    const nextAmount = nextType === 'LIMITED' && v.guaranteeAmount != null ? roundMoney(v.guaranteeAmount) : null;
    const beforeAmount = original.guaranteeAmount == null ? null : roundMoney(original.guaranteeAmount);
    if (nextAmount !== beforeAmount) patch.guaranteeAmount = nextAmount;
  }
  if (f.incomeIncluded && v.incomeIncluded !== undefined && v.incomeIncluded !== original.incomeIncluded) patch.incomeIncluded = v.incomeIncluded;
  const note = cleanNote(v.note);
  if (note !== (original.note ?? null)) patch.note = note;

  return Object.keys(patch).length > 0 ? patch : null;
}

export function toConsentRequest(fileId: string, signedAt: Date): RecordConsentRequest {
  return { fileId: fileId.trim(), signedAt: signedAt.toISOString() };
}

// ── дүр сонгох боломж (backend-ийн дүрмийг толины адил — эцсийн шийдвэр сервер дээр) ─────────────────
export interface RoleOption {
  role: BorrowerRole;
  reason: Reason | null;
}

type Counts = Pick<BorrowerSummary, 'primaryCount' | 'coBorrowerCount' | 'guarantorCount' | 'limits'>;

/**
 * Дараалал нь сервертэй ижил: хуулийн этгээд → давхардал/хослол → үндсэн → хязгаар.
 * Зөвхөн PLEDGOR нь бусад дүртэй хамт байж болно; PLEDGOR хязгааргүй.
 */
export function roleOptions(args: { customerType: CustomerType; linkedRoles: readonly BorrowerRole[]; summary: Counts }): RoleOption[] {
  const { customerType, linkedRoles, summary } = args;
  return ROLES.map((role): RoleOption => {
    let reason: Reason | null = null;
    if (customerType === 'LEGAL_ENTITY' && role === 'CO_BORROWER') reason = { key: 'borrower.roleBlocked.entity' };
    else if (linkedRoles.includes(role)) reason = { key: 'borrower.roleBlocked.duplicate' };
    else if (role !== 'PLEDGOR' && linkedRoles.some((r) => r !== 'PLEDGOR')) reason = { key: 'borrower.roleBlocked.conflict' };
    else if (role === 'PRIMARY' && summary.primaryCount >= 1) reason = { key: 'borrower.roleBlocked.primaryExists' };
    else if (role === 'CO_BORROWER' && summary.coBorrowerCount >= summary.limits.maxCoBorrowers) reason = { key: 'borrower.roleBlocked.limit', params: { limit: summary.limits.maxCoBorrowers } };
    else if (role === 'GUARANTOR' && summary.guarantorCount >= summary.limits.maxGuarantors) reason = { key: 'borrower.roleBlocked.limit', params: { limit: summary.limits.maxGuarantors } };
    return { role, reason };
  });
}

export const firstEnabledRole = (options: readonly RoleOption[]): BorrowerRole | undefined => options.find((o) => !o.reason)?.role;

export const candidateRoleOptions = (candidate: BorrowerCandidate, summary: Counts): RoleOption[] =>
  roleOptions({ customerType: candidate.customerType, linkedRoles: candidate.linkedRoles, summary });

// ── мөрийн үйлдлийн эрх ────────────────────────────────────────────────────────────────
export interface Gate {
  allowed: boolean;
  reason: Reason | null;
}
export interface RowGates {
  edit: Gate;
  consent: Gate;
  remove: Gate;
  makePrimary: Gate & { visible: boolean };
}

const allow: Gate = { allowed: true, reason: null };
const deny = (reason: Reason): Gate => ({ allowed: false, reason });

/** FR-10.4: засах боломжгүй төлөвт бүх мутаци хориглоно. Үндсэнийг шууд хасахгүй (эхлээд make-primary). */
export function rowGates(item: BorrowerView, items: readonly BorrowerView[], summary: Pick<BorrowerSummary, 'editable'>): RowGates {
  if (!summary.editable) {
    const blocked = deny({ key: 'borrower.gate.notEditable' });
    return { edit: blocked, consent: blocked, remove: blocked, makePrimary: { ...blocked, visible: item.role === 'CO_BORROWER' } };
  }
  const currentPrimary = items.find((i) => i.role === 'PRIMARY');
  return {
    edit: allow,
    consent: allow,
    remove: item.role === 'PRIMARY' && items.some((i) => i.id !== item.id) ? deny({ key: 'borrower.gate.primaryRequired' }) : allow,
    makePrimary: {
      visible: item.role === 'CO_BORROWER',
      ...(currentPrimary?.customer.customerType === 'LEGAL_ENTITY' ? deny({ key: 'borrower.gate.entityPrimary' }) : allow),
    },
  };
}

// ── зөвшөөрөл, хариуцлага ──────────────────────────────────────────────────────────────
export type ConsentState = 'SIGNED' | 'MISSING' | 'NOT_REQUIRED';
/** BR-9: хамтран зээлдэгч ба батлан даагчид гарын үсэгтэй зөвшөөрөл шаардана. */
export function consentState(item: Pick<BorrowerView, 'role' | 'consentSignedAt'>): ConsentState {
  if (item.consentSignedAt) return 'SIGNED';
  return item.role === 'CO_BORROWER' || item.role === 'GUARANTOR' ? 'MISSING' : 'NOT_REQUIRED';
}

/** Хүснэгтийн "Хариуцлага / баталгаа" нүд. Үндсэний хувь нь хадгалагдахгүй үлдэгдэл (summary.primaryLiabilityShare). */
export function describeLiability(item: BorrowerView, summary: Pick<BorrowerSummary, 'primaryLiabilityShare'>, tr: Translate): string | null {
  switch (item.role) {
    case 'CO_BORROWER':
      return item.liabilityShare != null ? tr('borrower.liability.share', { value: formatPercent(item.liabilityShare) }) : tr('borrower.liability.shareUnset');
    case 'PRIMARY':
      return summary.primaryLiabilityShare != null ? tr('borrower.liability.residual', { value: formatPercent(summary.primaryLiabilityShare) }) : null;
    case 'GUARANTOR': {
      const type = effectiveGuaranteeType('GUARANTOR', item.guaranteeType);
      if (type === 'LIMITED' && item.guaranteeAmount != null) return tr('borrower.liability.guaranteeLimited', { value: formatAmount(item.guaranteeAmount) });
      return tr(type === 'LIMITED' ? 'borrower.guaranteeType.LIMITED' : 'borrower.liability.guaranteeFull');
    }
    default:
      return null;
  }
}

/** Баталгааны хамрах хувь < 100% бол анхаарна. */
export const coverageBelowLoan = (ratio: number | null): boolean => ratio !== null && ratio < 1;

// ── анхааруулга (BR-9: хориг биш) ───────────────────────────────────────────────────────
export type WarningSeverity = 'error' | 'warning';

/** Хар жагсаалт — улаан; бусад — шар. Бүгд мэдээллийн шинжтэй, хадгалахыг хориглохгүй. */
export const WARNING_SEVERITY: Record<BorrowerWarningCode, WarningSeverity> = {
  BLACKLISTED: 'error',
  PEP: 'warning',
  RELATED_PARTY: 'warning',
  CONSENT_MISSING: 'warning',
  GUARANTEE_BELOW_LOAN: 'warning',
  LIABILITY_SHARE_INCOMPLETE: 'warning',
};
const WARNING_ORDER: readonly BorrowerWarningCode[] = ['BLACKLISTED', 'PEP', 'RELATED_PARTY', 'CONSENT_MISSING', 'GUARANTEE_BELOW_LOAN', 'LIABILITY_SHARE_INCOMPLETE'];
/** Харилцагч бүрийн мөрөнд тэмдэг болгон харуулах анхааруулга. */
export const CUSTOMER_LEVEL_WARNINGS: readonly BorrowerWarningCode[] = ['BLACKLISTED', 'PEP', 'RELATED_PARTY'];

export const warningTitleKey = (code: BorrowerWarningCode): string => `borrower.warning.${code}.title`;
export const warningBadgeKey = (code: BorrowerWarningCode): string => `borrower.badge.${code}`;

export function sortWarnings(warnings: readonly BorrowerWarning[]): BorrowerWarning[] {
  const rank = (w: BorrowerWarning): number => (WARNING_SEVERITY[w.code] === 'error' ? 0 : 1) * 100 + WARNING_ORDER.indexOf(w.code);
  return [...warnings].sort((a, b) => rank(a) - rank(b));
}

/** customerId → тэр харилцагчид хамаарах (хар жагсаалт / PEP / хамааралтай этгээд) кодууд. */
export function customerWarningCodes(warnings: readonly BorrowerWarning[]): Map<string, BorrowerWarningCode[]> {
  const map = new Map<string, BorrowerWarningCode[]>();
  for (const w of warnings) {
    if (!w.customerId || !CUSTOMER_LEVEL_WARNINGS.includes(w.code)) continue;
    const list = map.get(w.customerId) ?? [];
    if (!list.includes(w.code)) list.push(w.code);
    map.set(w.customerId, list);
  }
  return map;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asRole = (v: unknown): BorrowerRole | null => (typeof v === 'string' && (BorrowerRole as readonly string[]).includes(v) ? (v as BorrowerRole) : null);

export interface WarningDescription {
  code: BorrowerWarningCode;
  severity: WarningSeverity;
  title: string;
  description: string;
  customerId: string | null;
}

/**
 * Серверийн `code` + `details`-ээс монгол мессеж бүрдүүлнэ. Дутуу/гэнэтийн details ирвэл серверийн `message`-ийг ашиглана.
 */
export function describeWarning(w: BorrowerWarning, items: readonly BorrowerView[], tr: Translate): WarningDescription {
  const d = w.details ?? {};
  const name = w.customerId ? items.find((i) => i.customerId === w.customerId)?.customer.displayName ?? null : null;
  let description: string | null = null;

  switch (w.code) {
    case 'BLACKLISTED': {
      const reason = str(d.reasonCode);
      if (name && reason) description = tr('borrower.warning.BLACKLISTED.text', { name, reason });
      break;
    }
    case 'PEP':
    case 'RELATED_PARTY':
      if (name) description = tr(`borrower.warning.${w.code}.text`, { name });
      break;
    case 'CONSENT_MISSING': {
      const role = asRole(d.role);
      if (name && role) description = tr('borrower.warning.CONSENT_MISSING.text', { name, role: tr(roleKey(role)) });
      break;
    }
    case 'GUARANTEE_BELOW_LOAN': {
      const covered = num(d.covered);
      const loan = num(d.loanAmount);
      const shortfall = num(d.shortfall);
      if (covered !== null && loan !== null && shortfall !== null)
        description = tr('borrower.warning.GUARANTEE_BELOW_LOAN.text', { covered: formatAmount(covered), loan: formatAmount(loan), shortfall: formatAmount(shortfall) });
      break;
    }
    case 'LIABILITY_SHARE_INCOMPLETE': {
      const total = num(d.specifiedTotal);
      if (total !== null) description = tr('borrower.warning.LIABILITY_SHARE_INCOMPLETE.text', { total: formatPercent(total) });
      break;
    }
  }
  return { code: w.code, severity: WARNING_SEVERITY[w.code], title: tr(warningTitleKey(w.code)), description: description ?? w.message, customerId: w.customerId };
}

// ── алдаа (ApiError.code → монгол мессеж) ───────────────────────────────────────────────
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>([...BorrowerErrorCode, 'FORBIDDEN', 'UNAUTHENTICATED']);
export const errorKey = (code: string): string => `borrower.error.${code}`;
/** i18n-д заавал байх алдааны түлхүүрүүдийн жагсаалт (тестэд ашиглана). */
export const ERROR_KEYS: readonly string[] = [...KNOWN_ERROR_CODES, 'SERVER', 'NETWORK', 'UNKNOWN'].map(errorKey);

export interface DescribedError {
  code: string | null;
  message: string;
  /** VALIDATION_FAILED үед талбар тус бүрийн тайлбар. */
  issues: string[];
}

export function describeError(error: unknown, tr: Translate): DescribedError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown; issues?: unknown };
  const code = typeof e.code === 'string' ? e.code : null;
  const status = typeof e.status === 'number' ? e.status : null;
  const serverMessage = str(e.message);

  if (code && KNOWN_ERROR_CODES.has(code)) {
    const issues = code === 'VALIDATION_FAILED' && Array.isArray(e.issues)
      ? e.issues.flatMap((i: unknown) => {
          const issue = i as { path?: unknown; message?: unknown } | null;
          const text = str(issue?.message);
          if (!text) return [];
          const path = str(issue?.path);
          return [path ? `${path}: ${text}` : text];
        })
      : [];
    return { code, message: tr(errorKey(code)), issues };
  }
  const fallback = (key: string): DescribedError => ({ code, message: tr(errorKey(key)), issues: [] });
  if (status === 401) return fallback('UNAUTHENTICATED');
  if (status === 403) return fallback('FORBIDDEN');
  if (status !== null && status >= 500) return fallback('SERVER');
  if (error instanceof TypeError) return fallback('NETWORK'); // fetch холбогдож чадаагүй
  if (status !== null && serverMessage) return { code, message: serverMessage, issues: [] };
  return fallback('UNKNOWN');
}

/** 404/409 — сервер дээрх төлөв манайхаас зөрсөн (өөр хүн засчээ) → жагсаалтыг дахин татна. */
export const isStaleStateError = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 409;
};
