import type { AmlGateIssue, AmlSubject, BorrowerRole, CustomerType, ScreeningStatus, SubmitGateErrorCode } from '@los/contracts';
import type { z } from 'zod';

// G1 (docs/01 §4 «Илгээх боломж», FR-3.4; docs/05-compliance-aml.md §5): AML хаалтын цэвэр дүрэм (I/O байхгүй).

const HOUR_MS = 3_600_000;

export interface GateBorrower { customerId: string; role: BorrowerRole; customerUpdatedAt: Date }
/**
 * origination талд хадгалсан шалгалтын лавлагаа (`application_aml_screening`).
 * `customerUpdatedAt` = kyc-д илгээхээс ӨМНӨ уншсан `customer.updated_at` — яг аль identity-г шалгасныг заана (хадгалсан цаг биш: kyc дуудлагын явцад засвар орж болно).
 */
export interface GateScreening { customerId: string; screeningId: string; status: ScreeningStatus; blocking: boolean; customerUpdatedAt: Date }

export type AmlGateVerdict =
  | { ok: true }
  | { ok: false; code: Extract<SubmitGateErrorCode, 'PRIMARY_BORROWER_MISSING' | 'AML_REVIEW_REQUIRED' | 'AML_CONFIRMED_MATCH' | 'AML_SCREENING_STALE'>; httpStatus: 409 | 422; message: string; issues: AmlGateIssue[] };

/** kyc-ийн `blocking` флаг ба блоклох төлөвийн аль нэг нь үнэн бол блоклоно (зөрчилтэй хариуг аюулгүй талаас нь уншина). */
export const isBlockingScreening = (s: { status: ScreeningStatus; blocking: boolean }): boolean =>
  s.blocking || s.status === 'REVIEW_REQUIRED' || s.status === 'CONFIRMED_MATCH';

/**
 * kyc-ийн сүүлийн шалгалтыг дахин ашиглах эсэх (`aml.screening_reuse_hours`).
 *  - Блоклосон → үргэлж дахин ашиглана: шинэ шалгалт OPEN hit-ийг цэвэрлэж чадахгүй (дахин OPEN гарна), харин review-ийн дараалал дахь hit-ийг superseded болгож хүндрүүлнэ.
 *  - Цэвэр → зөвхөн цонх дотор БӨГӨӨД origination тухайн screening-д хадгалсан snapshot (`attestedCustomerUpdatedAt`) одоогийн `updated_at`-тай ТЭНЦҮҮ үед.
 *    Snapshot байхгүй (kyc-д өөр газраас хийгдсэн) бол аль identity-г шалгасан нь тодорхойгүй тул шинээр шалгана.
 */
export function shouldReuseScreening(
  latest: { screenedAt: string; blocking: boolean; status: ScreeningStatus } | null, attestedCustomerUpdatedAt: Date | null, currentCustomerUpdatedAt: Date, now: Date, reuseHours: number,
): boolean {
  if (!latest) return false;
  if (isBlockingScreening(latest)) return true;
  if (!attestedCustomerUpdatedAt || attestedCustomerUpdatedAt.getTime() !== currentCustomerUpdatedAt.getTime()) return false;
  const screenedMs = Date.parse(latest.screenedAt);
  if (Number.isNaN(screenedMs) || reuseHours <= 0) return false;
  return now.getTime() - screenedMs <= reuseHours * HOUR_MS;
}

/** Харилцагч бүрийг нэг удаа (PRIMARY дүрийг тэргүүлж, эс бөгөөс анх гарсан дүрээр). */
export function uniqueSubjects<T extends GateBorrower>(borrowers: readonly T[]): T[] {
  const byCustomer = new Map<string, T>();
  for (const b of borrowers) {
    const seen = byCustomer.get(b.customerId);
    if (!seen || (b.role === 'PRIMARY' && seen.role !== 'PRIMARY')) byCustomer.set(b.customerId, seen ? { ...seen, role: b.role } : b);
  }
  return [...byCustomer.values()];
}

const MESSAGES = {
  AML_CONFIRMED_MATCH: 'Оролцогч хориг арга хэмжээ / хар жагсаалтын баталгаажсан тохиролтой тул илгээх боломжгүй (AML)',
  AML_REVIEW_REQUIRED: 'AML шалгалтын шийдвэрлэгдээгүй тохирол байна — комплаенсын шийдвэр гартал илгээх боломжгүй',
  AML_SCREENING_STALE: 'Зарим оролцогчийн AML шалгалт хийгдээгүй эсвэл хуучирсан тул илгээх боломжгүй — дахин илгээнэ үү',
} as const;

function issueOf(b: GateBorrower, s: GateScreening | undefined): AmlGateIssue | null {
  if (!s) return { customerId: b.customerId, role: b.role, screeningId: null, status: null, reason: 'NOT_SCREENED' };
  if (s.status === 'CONFIRMED_MATCH') return { customerId: b.customerId, role: b.role, screeningId: s.screeningId, status: s.status, reason: 'CONFIRMED_MATCH' };
  if (isBlockingScreening(s)) return { customerId: b.customerId, role: b.role, screeningId: s.screeningId, status: s.status, reason: 'REVIEW_REQUIRED' };
  if (b.customerUpdatedAt.getTime() !== s.customerUpdatedAt.getTime()) return { customerId: b.customerId, role: b.role, screeningId: s.screeningId, status: s.status, reason: 'OUTDATED' };
  return null;
}

/**
 * Түгжээн доорх эцсийн шийдвэр: хүсэлтийн ОДООГИЙН оролцогч бүрт хадгалсан шалгалт байж, блоклохгүй, шалгасан snapshot нь одоогийн `customer.updated_at`-тай ТЭНЦҮҮ байх
 * (цагийн дараалалд найдахгүй — kyc дуудлагын явцад орсон засвар хадгалах цагаас өмнө тэмдэглэгдсэн байж болно).
 * Давамгайлал: CONFIRMED_MATCH > REVIEW_REQUIRED > (NOT_SCREENED | OUTDATED → 409, дахин оролдоно).
 */
export function evaluateAmlGate(borrowers: readonly GateBorrower[], screenings: readonly GateScreening[]): AmlGateVerdict {
  if (!borrowers.length) return { ok: false, code: 'PRIMARY_BORROWER_MISSING', httpStatus: 422, message: 'Үндсэн зээлдэгч бүртгэгдээгүй байна (1-р алхам)', issues: [] };
  const byCustomer = new Map(screenings.map((s) => [s.customerId, s]));
  const issues = uniqueSubjects(borrowers).map((b) => issueOf(b, byCustomer.get(b.customerId))).filter((i): i is AmlGateIssue => i !== null);
  if (!issues.length) return { ok: true };
  const code = issues.some((i) => i.reason === 'CONFIRMED_MATCH') ? 'AML_CONFIRMED_MATCH' : issues.some((i) => i.reason === 'REVIEW_REQUIRED') ? 'AML_REVIEW_REQUIRED' : 'AML_SCREENING_STALE';
  return { ok: false, code, httpStatus: code === 'AML_SCREENING_STALE' ? 409 : 422, message: MESSAGES[code], issues };
}

export interface SubjectSource { customerType: string; lastName: string | null; firstName: string; birthDate: Date | null; isPep: boolean; isRelatedParty: boolean }

/** origination.customer → kyc `AmlSubject` (оролт). Регистрийг дуудагч тайлж өгнө; лог/аудитад гаргахгүй. Улсын мэдээлэл customer-д байхгүй тул `countries` хоосон. */
export function toAmlSubject(c: SubjectSource, registerNo: string): z.input<typeof AmlSubject> {
  const subjectType: CustomerType = c.customerType === 'LEGAL_ENTITY' ? 'LEGAL_ENTITY' : 'INDIVIDUAL';
  const lastName = c.lastName?.trim();
  return {
    subjectType,
    registerNo,
    ...(subjectType === 'INDIVIDUAL' && lastName ? { lastName } : {}),
    firstName: c.firstName,
    ...(subjectType === 'INDIVIDUAL' && c.birthDate ? { birthDate: c.birthDate.toISOString().slice(0, 10) } : {}),
    isPep: c.isPep,
    isRelatedParty: c.isRelatedParty,
  };
}
