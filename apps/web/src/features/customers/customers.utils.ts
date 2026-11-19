import { CustomerInput, XypOtpCode, type CustomerType, type XypFetchResult, type XypOtpResult } from '@los/contracts';

/** Хоосон мөр / null / хоосон объект / хоосон массивыг хасна: сервер `""`-г "оруулаагүй" гэж ойлгодог ч бүтэн объект (хаяг, хөдөлмөр) хагас хоосон байж болохгүй. */
export function pruneEmpty(value: unknown): unknown {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(pruneEmpty).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = pruneEmpty(v);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

export type FieldIssue = { name: (string | number)[]; message: string };

/** Бүтэн объект (хаяг/хөдөлмөр) дутсан бол эхний дэд талбарыг тэмдэглэнэ, ингэснээр маягт дээр улаанаар харагдана. */
const FIRST_CHILD: Record<string, string> = { officialAddress: 'province', residenceAddress: 'province', employment: 'organization' };

export function issuePath(path: readonly (string | number)[] | string): (string | number)[] {
  const parts = typeof path === 'string' ? path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)) : [...path];
  const head = parts[0];
  if (parts.length === 1 && typeof head === 'string' && FIRST_CHILD[head]) parts.push(FIRST_CHILD[head] as string);
  return parts;
}

/**
 * Нэг л газар (contracts-ийн `CustomerInput`) шалгана — сервертэй ижил дүрэм.
 * Zod нь талбарын хэлбэр буруу бол заавал талбарын (superRefine) шалгалтыг ажиллуулдаггүй тул, буруу талбарыг түр хасаад дахин шалгаж
 * бүх алдааг НЭГЭН ЗЭРЭГ буцаана (хэрэглэгч нэг нэгээр нь биш бүгдийг нэг дор харна).
 */
export function validateCustomer(payload: Record<string, unknown>): FieldIssue[] {
  const out: FieldIssue[] = [];
  const seen = new Set<string>();
  let current = { ...payload };
  for (let round = 0; round < 8; round++) {
    const r = CustomerInput.safeParse(current);
    if (r.success) break;
    let progressed = false;
    for (const i of r.error.issues) {
      const name = issuePath(i.path as (string | number)[]);
      const key = name.join('.');
      if (!seen.has(key)) { seen.add(key); out.push({ name, message: i.message }); }
      const top = i.path[0];
      if (typeof top === 'string' && top in current && top !== 'customerType' && top !== 'registerNo') { delete current[top]; progressed = true; }
    }
    // firstName дутуу бол superRefine ажиллахгүй: түр нөхөж үлдсэн заавал талбарыг мөн шалгана
    if (!progressed) {
      if (!('firstName' in current)) { current = { ...current, firstName: '_' }; continue; }
      break;
    }
  }
  return out;
}

/** Маягтын утгаас сервер рүү явах биеийг үүсгэнэ. */
export function buildPayload(values: Record<string, unknown>, fixed: { customerType: string; registerNo: string }): Record<string, unknown> {
  const pruned = (pruneEmpty(values) ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...pruned, ...fixed };
  // Тэмдэглэгээ нь хоосон байхад false байх ёстой (pruneEmpty false-г хасахгүй)
  out.isPep = Boolean(values.isPep);
  out.isRelatedParty = Boolean(values.isRelatedParty);
  out.residenceSameAsOfficial = Boolean(values.residenceSameAsOfficial);
  if (out.residenceSameAsOfficial) delete out.residenceAddress;
  return out;
}

export type CustomerEditability = { editable: true; reason: null } | { editable: false; reason: 'NO_PERMISSION' | 'OTHER_BRANCH' };

/**
 * NFR-3 (эзэмшигчийн шийдвэр 2026-11-18, A): зөвхөн бүртгэсэн салбар засна; `branchId = null` (хуучин) бол эзэмшигчгүй.
 * Сервер (`CUSTOMER_BRANCH_FORBIDDEN`) эх сурвалж — энэ нь зөвхөн UI-д урьдчилан тайлбарлах зориулалттай.
 */
export function canEditCustomer(
  me: { user: { branchId: string | null }; permissions: readonly string[] } | null | undefined,
  customer: { branchId: string | null },
): CustomerEditability {
  if (!me || !me.permissions.includes('customer:write')) return { editable: false, reason: 'NO_PERMISSION' };
  if (customer.branchId !== null && customer.branchId !== me.user.branchId) return { editable: false, reason: 'OTHER_BRANCH' };
  return { editable: true, reason: null };
}

// ── ХУР: иргэний зөвшөөрөл (иргэний ХУР-д бүртгэлтэй утсанд ирсэн нэг удаагийн код) ──

/** Кодыг дахин хүсэх товчийн UI хүлээлт. ЗӨВХӨН сэнхрүүлэх; жинхэнэ хязгаар (регистр тус бүрт 15 минутад 3) сервер дээр. */
export const XYP_OTP_RESEND_COOLDOWN_SEC = 60;

/** Буулгасан "123 456" / "12-34-56"-аас зөвхөн цифр үлдээж `XypOtpCode`-ын дээд урт (8)-д таслана. */
export const normalizeOtpInput = (raw: string): string => raw.replace(/\D/g, '').slice(0, 8);

/** Кодын дүрэм нь серверийн (contracts) `XypOtpCode`-той ижил — нэг эх сурвалж. */
export const isValidXypOtp = (code: string): boolean => XypOtpCode.safeParse(code).success;

/** Харилцагч аль хэдийн бүртгэлтэй (код илгээгдээгүй, ХУР дуудагдаагүй) үед `xyp-otp`-ийн хариуг маягтын `XypFetchResult` хэлбэрт оруулна. */
export function xypOtpToFetchResult(otp: XypOtpResult, registerNo: string, customerType: CustomerType): XypFetchResult {
  return { registerNo, customerType, fetchedAt: null, prefill: {}, prefilledFields: [], missing: [], existing: otp.existing, warnings: otp.warnings, snapshotToken: null };
}

/** Кодыг илгээснээс хойш «дахин авах» товч идэвхжих хүртэлх үлдсэн секунд (дээш бөөнжүүлнэ); огноо байхгүй / буруу бол 0. */
export function otpResendRemainingSec(requestedAt: string | null, nowMs: number, cooldownSec: number = XYP_OTP_RESEND_COOLDOWN_SEC): number {
  const at = requestedAt ? Date.parse(requestedAt) : Number.NaN;
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.ceil((at + cooldownSec * 1000 - nowMs) / 1000));
}
