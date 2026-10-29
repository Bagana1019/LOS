import { MAX_GUARANTEE_AMOUNT } from '@los/contracts';
import type { AddBorrowerRequest, BorrowerRelation, BorrowerRole, BorrowerSummary, BorrowerWarning, CustomerType, GuaranteeType } from '@los/contracts';

// Цэвэр бизнес дүрмүүд (I/O байхгүй) — docs/01 FR-2.1, FR-6.5, FR-10.4, BR-9; docs/02 BSA-BR-9.
// Мөнгийг бүхэл (төгрөгийн 1/100), хувийг бүхэл (1/10000) болгож тооцно — хөвөгч таслалтын алдаагүй.

export const EDITABLE_STATUSES = ['DRAFT', 'RETURNED'] as const;
/** FR-10.4: зөвхөн "Шинэ" (DRAFT) ба "Буцаасан" (RETURNED) төлөвт засна. */
export const isEditableStatus = (status: string): boolean => (EDITABLE_STATUSES as readonly string[]).includes(status);

export const ROLE_ORDER: Record<BorrowerRole, number> = { PRIMARY: 0, CO_BORROWER: 1, GUARANTOR: 2, PLEDGOR: 3 };
export const ROLE_LABEL: Record<BorrowerRole, string> = { PRIMARY: 'Үндсэн зээлдэгч', CO_BORROWER: 'Хамтран зээлдэгч', GUARANTOR: 'Батлан даагч', PLEDGOR: 'Барьцаалагч' };

/** Дүрмийн зөрчил: status нь HTTP код (409 — төлөв/давхардал, 422 — өгөгдлийн утга). */
export interface Violation { status: 409 | 422; code: string; message: string; details?: Record<string, unknown> }
const violation = (status: 409 | 422, code: string, message: string, details?: Record<string, unknown>): Violation => ({ status, code, message, ...(details ? { details } : {}) });

export interface Limits { maxCoBorrowers: number; maxGuarantors: number }

export interface BorrowerFields {
  relationToPrimary: BorrowerRelation | null;
  liabilityShare: number | null;
  guaranteeType: GuaranteeType | null;
  guaranteeAmount: number | null;
  incomeIncluded: boolean;
  note: string | null;
}
export const FIELD_KEYS = ['relationToPrimary', 'liabilityShare', 'guaranteeType', 'guaranteeAmount', 'incomeIncluded', 'note'] as const satisfies readonly (keyof BorrowerFields)[];

export interface CustomerFacts { displayName: string; customerType: CustomerType; isPep: boolean; isRelatedParty: boolean }

export interface BorrowerRow extends BorrowerFields {
  id: string;
  customerId: string;
  role: BorrowerRole;
  isPrimary: boolean;
  consentSignedAt: Date | null;
  customer: CustomerFacts;
}

// ── тоон туслахууд ───────────────────────────────────────────────────────────────────
export const toCents = (v: number): number => Math.round(v * 100);
export const toBp = (v: number): number => Math.round(v * 10_000);
const round2 = (v: number | null | undefined): number | null => (v == null ? null : toCents(v) / 100);
const round4 = (v: number | null | undefined): number | null => (v == null ? null : toBp(v) / 10_000);
const cleanNote = (v: string | null | undefined): string | null => { const s = v?.trim(); return s ? s : null; };

export function formatMnt(v: number): string {
  const [int, dec] = v.toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec === '00' ? grouped : `${grouped}.${dec}`;
}

// ── талбарын дүрэм (5) ───────────────────────────────────────────────────────────────
/** BSA-BR-9: орлого нэгтгэх нь зөвхөн үндсэн ба хамтран зээлдэгч. Өгөөгүй бол PRIMARY/CO_BORROWER = true. */
export const defaultIncomeIncluded = (role: BorrowerRole): boolean => role === 'PRIMARY' || role === 'CO_BORROWER';

/** Нэмэх хүсэлтийн талбаруудыг нормчилно: анхдагч утга, тоо бөөрөнхийлөх, тэмдэглэл цэвэрлэх. */
export function normalizeAdd(input: AddBorrowerRequest): BorrowerFields {
  // Батлан даагчийн төрлийг өгөөгүй, дүн ч байхгүй бол бүрэн (хамтран хариуцах) баталгаа гэж үзнэ.
  const guaranteeType: GuaranteeType | null = input.guaranteeType ?? (input.role === 'GUARANTOR' && input.guaranteeAmount == null ? 'JOINT_AND_SEVERAL' : null);
  return {
    relationToPrimary: input.relationToPrimary ?? null,
    liabilityShare: round4(input.liabilityShare),
    guaranteeType,
    guaranteeAmount: round2(input.guaranteeAmount),
    incomeIncluded: input.incomeIncluded ?? defaultIncomeIncluded(input.role),
    note: cleanNote(input.note),
  };
}

/** Дүрээс хамаарсан талбарын зөвшөөрөл ба утгын уялдаа (DTO-н superRefine-ийг нөхөж, засварын нэгтгэсэн төлөвийг шалгана). */
export function checkRoleFields(role: BorrowerRole, f: BorrowerFields): Violation | null {
  const notAllowed = (field: keyof BorrowerFields) => violation(422, 'FIELD_NOT_ALLOWED_FOR_ROLE', `"${field}" талбар "${ROLE_LABEL[role]}" дүрд хамаарахгүй`, { field, role });
  if (role === 'PRIMARY' && f.relationToPrimary != null) return notAllowed('relationToPrimary');
  if (role !== 'CO_BORROWER' && f.liabilityShare != null) return notAllowed('liabilityShare');
  if (role !== 'GUARANTOR' && f.guaranteeType != null) return notAllowed('guaranteeType');
  if (role !== 'GUARANTOR' && f.guaranteeAmount != null) return notAllowed('guaranteeAmount');
  if ((role === 'GUARANTOR' || role === 'PLEDGOR') && f.incomeIncluded)
    return violation(422, 'INCOME_NOT_ALLOWED', 'Батлан даагч, барьцаалагчийн орлогыг нэгтгэхгүй (орлого нэгтгэх нь зөвхөн үндсэн ба хамтран зээлдэгчид хамаарна)', { role });
  if (role === 'GUARANTOR') {
    // DTO-г тойрсон дуудлагад ч (Infinity/NaN → DB-д NULL болж LIMITED⇒дүн инвариантыг эвдэнэ; ≥1e16 → numeric(18,2) overflow 500) хамгаална.
    if (f.guaranteeAmount != null && (!Number.isFinite(f.guaranteeAmount) || toCents(f.guaranteeAmount) <= 0)) return violation(422, 'GUARANTEE_INVALID', 'Баталгааны дүн 0-ээс их, төгсгөлөг тоо байх ёстой');
    if (f.guaranteeAmount != null && f.guaranteeAmount > MAX_GUARANTEE_AMOUNT) return violation(422, 'GUARANTEE_INVALID', `Баталгааны дүн ${formatMnt(MAX_GUARANTEE_AMOUNT)}₮-өөс хэтэрч болохгүй`, { max: MAX_GUARANTEE_AMOUNT });
    if (f.guaranteeType == null && f.guaranteeAmount != null) return violation(422, 'GUARANTEE_INVALID', 'Баталгааны дүн өгвөл баталгааны төрлийг заавал сонгоно');
    if (f.guaranteeType === 'LIMITED' && f.guaranteeAmount == null) return violation(422, 'GUARANTEE_INVALID', 'Хязгаартай баталгаанд баталгааны дээд дүн заавал');
    if (f.guaranteeType === 'JOINT_AND_SEVERAL' && f.guaranteeAmount != null) return violation(422, 'GUARANTEE_INVALID', 'Бүрэн (хамтран хариуцах) баталгаанд дүн заахгүй');
  }
  return null;
}

// ── нэмэх (2, 3, 4, 5, 6) ────────────────────────────────────────────────────────────
/** (2.6) Хуулийн этгээд хамтран зээлдэгч байж болохгүй. */
export function checkEntityRole(customerType: CustomerType, role: BorrowerRole): Violation | null {
  if (customerType === 'LEGAL_ENTITY' && role === 'CO_BORROWER')
    return violation(422, 'ENTITY_CANNOT_CO_BORROW', 'Хуулийн этгээд хамтран зээлдэгч байж болохгүй (үндсэн зээлдэгч, батлан даагч, барьцаалагчаар бүртгэнэ)');
  return null;
}

/** (3) Давхардал ба дүрийн хослол: зөвхөн PLEDGOR нь бусад дүртэй хамт байж болно. */
export function checkRoleCombination(existingRolesOfCustomer: BorrowerRole[], role: BorrowerRole): Violation | null {
  if (existingRolesOfCustomer.includes(role)) return violation(409, 'BORROWER_DUPLICATE', 'Энэ харилцагч тухайн дүрээр хүсэлтэд аль хэдийн бүртгэгдсэн байна', { role });
  const clash = role === 'PLEDGOR' ? undefined : existingRolesOfCustomer.find((r) => r !== 'PLEDGOR');
  if (clash)
    return violation(409, 'ROLE_CONFLICT', `Харилцагч "${ROLE_LABEL[clash]}" дүрээр бүртгэгдсэн тул "${ROLE_LABEL[role]}" болгож нэмэх боломжгүй (өөрийн зээлд өөрөө батлан даахгүй; зөвхөн барьцаалагчийн дүрийг бусадтай хослуулна)`, { existingRole: clash, role });
  return null;
}

/** (2) Хоёр дахь PRIMARY хориотой — солих бол make-primary. */
export function checkPrimarySlot(existing: BorrowerRow[], role: BorrowerRole): Violation | null {
  if (role === 'PRIMARY' && existing.some((r) => r.role === 'PRIMARY'))
    return violation(409, 'PRIMARY_EXISTS', 'Үндсэн зээлдэгч аль хэдийн бүртгэгдсэн байна. Солих бол хамтран зээлдэгчийг "Үндсэн болгох" үйлдлээр сольно уу');
  return null;
}

/** (4) Тоо хязгаар (setting). PLEDGOR хязгааргүй. */
export function checkLimit(existing: BorrowerRow[], role: BorrowerRole, limits: Limits): Violation | null {
  if (role !== 'CO_BORROWER' && role !== 'GUARANTOR') return null;
  const limit = role === 'CO_BORROWER' ? limits.maxCoBorrowers : limits.maxGuarantors;
  const count = existing.filter((r) => r.role === role).length;
  if (count >= limit) return violation(409, 'LIMIT_EXCEEDED', `"${ROLE_LABEL[role]}"-ийн дээд хязгаар (${limit}) хэтэрсэн байна`, { role, limit });
  return null;
}

/** (5) Хамтран зээлдэгчдийн хариуцлагын хувийн нийлбэр 100%-иас хэтэрч болохгүй. */
export function checkShareTotal(rows: Array<Pick<BorrowerRow, 'role' | 'liabilityShare'>>): Violation | null {
  const total = rows.reduce((s, r) => s + (r.role === 'CO_BORROWER' && r.liabilityShare != null ? toBp(r.liabilityShare) : 0), 0);
  if (total > 10_000) return violation(422, 'LIABILITY_SHARE_EXCEEDED', `Хамтран зээлдэгчдийн хариуцлагын хувийн нийлбэр ${total / 100}% болж 100%-иас хэтэрч байна`, { total: total / 10_000 });
  return null;
}

export interface AddCheck { role: BorrowerRole; customerId: string; customerType: CustomerType; fields: BorrowerFields; existing: BorrowerRow[]; limits: Limits }
/** Харилцагч олдсоны дараах дарааллаар: хуулийн этгээд → давхардал/хослол → үндсэн → хязгаар (409) → хувь (422). */
export function validateAdd(c: AddCheck): Violation | null {
  return checkEntityRole(c.customerType, c.role)
    ?? checkRoleCombination(c.existing.filter((r) => r.customerId === c.customerId).map((r) => r.role), c.role)
    ?? checkPrimarySlot(c.existing, c.role)
    ?? checkLimit(c.existing, c.role, c.limits)
    ?? checkShareTotal([...c.existing, { role: c.role, liabilityShare: c.fields.liabilityShare }]);
}

// ── засах ────────────────────────────────────────────────────────────────────────────
export type FieldPatch = Partial<BorrowerFields>;
export interface UpdatePlan { next: BorrowerFields; changed: Array<keyof BorrowerFields>; compositionChanged: boolean }

/** PATCH: `undefined` — өөрчлөхгүй, `null` — арилгана. Нэгтгэсэн төлвийг дүрмээр шалгана. */
export function planUpdate(row: BorrowerRow, patch: FieldPatch, others: BorrowerRow[]): UpdatePlan | Violation {
  const next: BorrowerFields = {
    relationToPrimary: row.relationToPrimary, liabilityShare: row.liabilityShare, guaranteeType: row.guaranteeType,
    guaranteeAmount: row.guaranteeAmount, incomeIncluded: row.incomeIncluded, note: row.note,
  };
  if (patch.relationToPrimary !== undefined) next.relationToPrimary = patch.relationToPrimary;
  if (patch.liabilityShare !== undefined) next.liabilityShare = round4(patch.liabilityShare);
  if (patch.guaranteeType !== undefined) next.guaranteeType = patch.guaranteeType;
  if (patch.guaranteeAmount !== undefined) next.guaranteeAmount = round2(patch.guaranteeAmount);
  if (patch.incomeIncluded !== undefined) next.incomeIncluded = patch.incomeIncluded;
  if (patch.note !== undefined) next.note = cleanNote(patch.note);
  // Төрлийг бүрэн баталгаа болгож солиход дүнг тусад нь арилгаагүй бол дүнг автоматаар арилгана.
  if (row.role === 'GUARANTOR' && patch.guaranteeType === 'JOINT_AND_SEVERAL' && patch.guaranteeAmount === undefined) next.guaranteeAmount = null;

  const bad = checkRoleFields(row.role, next) ?? (row.role === 'CO_BORROWER' ? checkShareTotal([...others, { role: row.role, liabilityShare: next.liabilityShare }]) : null);
  if (bad) return bad;
  const changed = FIELD_KEYS.filter((k) => next[k] !== row[k]);
  const compositionChanged = (row.role === 'PRIMARY' || row.role === 'CO_BORROWER') && (changed.includes('incomeIncluded') || changed.includes('liabilityShare'));
  return { next, changed, compositionChanged };
}

export const isViolation = (v: unknown): v is Violation => typeof v === 'object' && v !== null && 'status' in v && 'code' in v && 'message' in v;

// ── устгах (2, 10) ───────────────────────────────────────────────────────────────────
export function checkRemovable(target: BorrowerRow, rows: BorrowerRow[], ownsCollateral: boolean): Violation | null {
  if (target.role === 'PRIMARY' && rows.some((r) => r.id !== target.id))
    return violation(409, 'PRIMARY_REQUIRED', 'Үндсэн зээлдэгчийг хасахаас өмнө өөр хамтран зээлдэгчийг "Үндсэн болгох" эсвэл бусад оролцогчдыг эхлээд хасах шаардлагатай');
  // Аль ч дүрийн оролцогч (барьцаалагч, хамтран зээлдэгч) барьцааны өмчлөгч бол хасахгүй — үгүй бол барьцаа хүсэлтэд байхгүй хүнд харъяалагдаж 5-р алхам бүрэн хэвээр үлдэнэ (FR-6.5).
  if (ownsCollateral)
    return violation(409, 'BORROWER_OWNS_COLLATERAL', 'Энэ оролцогч хүсэлтийн барьцаа хөрөнгийн өмчлөгч тул хасах боломжгүй. Эхлээд барьцаа хөрөнгийг хасна уу');
  return null;
}

// ── make-primary (2) ─────────────────────────────────────────────────────────────────
export interface MakePrimaryPlan {
  noop: boolean;
  promoteId: string;
  /** Одоогийн үндсэн зээлдэгч CO_BORROWER болно; `liabilityShare` — өмнөх үлдэгдэл хувь (эдийн засгийн хуваарийг хадгална). */
  demote: { id: string; liabilityShare: number | null } | null;
}

/**
 * CO_BORROWER-г үндсэн болгоно. Хувь тогтоосон горимд хуучин үндсэний хувь (1 − ΣCO) нь шинэ хамтран зээлдэгчийн хувь болж,
 * ΣCO + үндсэний үлдэгдэл = 1 хэвээр үлдэнэ (шилжүүлэг дээр хуваарь өөрчлөгдөхгүй). Үлдэгдэл 0 бол хувь null.
 */
export function planMakePrimary(rows: BorrowerRow[], targetId: string): MakePrimaryPlan | Violation {
  const target = rows.find((r) => r.id === targetId);
  if (!target) throw new Error('planMakePrimary: target borrower not in rows');
  if (target.role === 'PRIMARY') return { noop: true, promoteId: target.id, demote: null };
  if (target.role !== 'CO_BORROWER') return violation(409, 'NOT_CO_BORROWER', 'Зөвхөн хамтран зээлдэгчийг үндсэн зээлдэгч болгох боломжтой');
  const current = rows.find((r) => r.role === 'PRIMARY') ?? null;
  if (!current) return { noop: false, promoteId: target.id, demote: null };
  const bad = checkEntityRole(current.customer.customerType, 'CO_BORROWER');
  if (bad) return violation(422, bad.code, 'Одоогийн үндсэн зээлдэгч хуулийн этгээд тул хамтран зээлдэгч болж чадахгүй; үндсэн зээлдэгчийг сольж болохгүй');
  const sumBp = rows.reduce((s, r) => s + (r.role === 'CO_BORROWER' && r.liabilityShare != null ? toBp(r.liabilityShare) : 0), 0);
  const residualBp = 10_000 - sumBp;
  const demoteShare = target.liabilityShare != null && residualBp > 0 ? residualBp / 10_000 : null;
  return { noop: false, promoteId: target.id, demote: { id: current.id, liabilityShare: demoteShare } };
}

// ── хураангуй (12) ───────────────────────────────────────────────────────────────────
/** Σ баталгаа (cents). Бүрэн (JOINT_AND_SEVERAL) = зээлийн бүтэн дүн. Зээлийн дүн мэдэгдэхгүй үед бүрэн баталгааны утга тодорхойгүй → null. */
export function guaranteeCoverageCents(rows: BorrowerRow[], loanCents: number | null): number | null {
  let total = 0;
  for (const g of rows.filter((r) => r.role === 'GUARANTOR')) {
    const full = g.guaranteeType === 'JOINT_AND_SEVERAL' || (g.guaranteeType == null && g.guaranteeAmount == null);
    if (full) {
      if (loanCents == null) return null;
      total += loanCents;
    } else total += toCents(g.guaranteeAmount ?? 0);
  }
  return total;
}

export function primaryLiabilityShare(rows: BorrowerRow[]): number | null {
  const withShare = rows.filter((r) => r.role === 'CO_BORROWER' && r.liabilityShare != null);
  if (!withShare.length || !rows.some((r) => r.role === 'PRIMARY')) return null;
  const sumBp = withShare.reduce((s, r) => s + toBp(r.liabilityShare as number), 0);
  return Math.max(0, 10_000 - sumBp) / 10_000;
}

export function computeSummary(args: { rows: BorrowerRow[]; loanAmount: number | null; limits: Limits; status: string }): BorrowerSummary {
  const { rows } = args;
  const count = (role: BorrowerRole) => rows.filter((r) => r.role === role).length;
  const loanCents = args.loanAmount == null ? null : toCents(args.loanAmount);
  const covered = guaranteeCoverageCents(rows, loanCents);
  const ratio = covered == null || loanCents == null || loanCents <= 0 ? null : Math.round((covered / loanCents) * 10_000) / 10_000;
  return {
    primaryCount: count('PRIMARY'), coBorrowerCount: count('CO_BORROWER'), guarantorCount: count('GUARANTOR'), pledgorCount: count('PLEDGOR'),
    clientStepComplete: count('PRIMARY') >= 1,
    primaryLiabilityShare: primaryLiabilityShare(rows),
    incomeContributorCustomerIds: [...new Set(rows.filter((r) => r.incomeIncluded).map((r) => r.customerId))],
    guaranteeCoverageRatio: ratio,
    limits: args.limits,
    editable: isEditableStatus(args.status),
  };
}

// ── анхааруулга (7; BR-9: хориг биш) ──────────────────────────────────────────────────
export interface BlacklistHit { customerId: string; reasonCode: string; listType: string }

export function computeWarnings(args: { rows: BorrowerRow[]; loanAmount: number | null; hits: BlacklistHit[] }): BorrowerWarning[] {
  const { rows, hits } = args;
  const out: BorrowerWarning[] = [];
  const customers = new Map<string, { facts: CustomerFacts; roles: BorrowerRole[] }>();
  for (const r of rows) {
    const c = customers.get(r.customerId);
    if (c) c.roles.push(r.role); else customers.set(r.customerId, { facts: r.customer, roles: [r.role] });
  }

  for (const hit of hits) {
    const c = customers.get(hit.customerId);
    if (!c) continue;
    out.push({ code: 'BLACKLISTED', customerId: hit.customerId, message: `${c.facts.displayName} хар жагсаалтад бүртгэлтэй байна (шалтгаан: ${hit.reasonCode}). Энэ нь анхааруулга бөгөөд хадгалахыг хориглохгүй — батлагч шийднэ`, details: { reasonCode: hit.reasonCode, listType: hit.listType, roles: c.roles } });
  }
  for (const [customerId, c] of customers) {
    if (c.facts.isPep) out.push({ code: 'PEP', customerId, message: `${c.facts.displayName} улс төрд нөлөө бүхий этгээд (PEP) гэж тэмдэглэгдсэн байна`, details: { roles: c.roles } });
  }
  for (const [customerId, c] of customers) {
    if (c.facts.isRelatedParty) out.push({ code: 'RELATED_PARTY', customerId, message: `${c.facts.displayName} ББСБ-д хамааралтай этгээд гэж тэмдэглэгдсэн байна`, details: { roles: c.roles } });
  }
  for (const r of rows) {
    if ((r.role === 'GUARANTOR' || r.role === 'CO_BORROWER') && !r.consentSignedAt)
      out.push({ code: 'CONSENT_MISSING', customerId: r.customerId, message: `${r.customer.displayName} (${ROLE_LABEL[r.role]})-ийн гарын үсэгтэй зөвшөөрөл бүртгэгдээгүй байна`, details: { role: r.role, borrowerId: r.id } });
  }

  const loanCents = args.loanAmount == null ? null : toCents(args.loanAmount);
  const guarantors = rows.filter((r) => r.role === 'GUARANTOR');
  if (guarantors.length && loanCents != null && loanCents > 0) {
    const covered = guaranteeCoverageCents(rows, loanCents);
    if (covered != null && covered < loanCents)
      out.push({ code: 'GUARANTEE_BELOW_LOAN', customerId: null, message: `Батлан даагчдын баталгааны нийлбэр (${formatMnt(covered / 100)}₮) зээлийн дүнгээс (${formatMnt(loanCents / 100)}₮) бага байна`, details: { covered: covered / 100, loanAmount: loanCents / 100, shortfall: (loanCents - covered) / 100 } });
  }

  const cos = rows.filter((r) => r.role === 'CO_BORROWER');
  const withShare = cos.filter((r) => r.liabilityShare != null);
  if (withShare.length) {
    const missing = cos.filter((r) => r.liabilityShare == null);
    const sumBp = withShare.reduce((s, r) => s + toBp(r.liabilityShare as number), 0);
    const hasPrimary = rows.some((r) => r.role === 'PRIMARY');
    if (missing.length || (!hasPrimary && sumBp !== 10_000))
      out.push({ code: 'LIABILITY_SHARE_INCOMPLETE', customerId: null, message: `Хамтран зээлдэгчдийн хариуцлагын хувь бүрэн тодорхойгүй байна (тогтоосон хувь ${sumBp / 100}%)`, details: { specifiedTotal: sumBp / 10_000, missingCustomerIds: missing.map((r) => r.customerId) } });
  }
  return out;
}

// ── алхам (8) ────────────────────────────────────────────────────────────────────────
export interface StepRow { id: string; stepKey: string; status: string; staleReason: string | null }
export interface StepUpdate { id: string; stepKey: string; status: 'PENDING' | 'COMPLETED' | 'STALE'; staleReason: string | null; /** undefined — өөрчлөхгүй */ completedAt?: Date | null }
export interface StepChange { hasPrimary: boolean; borrowerAdded: boolean; compositionChanged: boolean }

/**
 * Оролцогч өөрчлөгдөхөд wizard-н алхмуудыг шинэчлэх матриц. LOCKED мөрийг хөндөхгүй, мөр байхгүй бол алгасна.
 *  - client: ≥1 PRIMARY → COMPLETED, үгүй → PENDING
 *  - inquiry: оролцогч нэмэгдсэн ба COMPLETED → PENDING (BORROWER_ADDED)
 *  - income, score: PRIMARY/CO-ийн бүрдэл (incomeIncluded/liabilityShare) өөрчлөгдсөн ба COMPLETED → STALE (BORROWERS_CHANGED)
 */
export function planStepUpdates(steps: StepRow[], change: StepChange, now: Date): StepUpdate[] {
  const out: StepUpdate[] = [];
  const get = (key: string) => steps.find((s) => s.stepKey === key && s.status !== 'LOCKED');

  const client = get('client');
  if (client) {
    const target = change.hasPrimary ? 'COMPLETED' : 'PENDING';
    if (client.status !== target) out.push({ id: client.id, stepKey: 'client', status: target, completedAt: target === 'COMPLETED' ? now : null, staleReason: null });
  }
  const inquiry = get('inquiry');
  if (inquiry && change.borrowerAdded && inquiry.status === 'COMPLETED')
    out.push({ id: inquiry.id, stepKey: 'inquiry', status: 'PENDING', completedAt: null, staleReason: 'BORROWER_ADDED' });
  if (change.compositionChanged) {
    for (const key of ['income', 'score']) {
      const s = get(key);
      if (s && s.status === 'COMPLETED') out.push({ id: s.id, stepKey: key, status: 'STALE', staleReason: 'BORROWERS_CHANGED' });
    }
  }
  return out;
}
