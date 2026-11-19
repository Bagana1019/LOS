import type { DisbursementCheck } from '@los/contracts';

// FR-12 · BR-10 · G4/G5: олголтын хүсэлтийн цэвэр дүрмүүд (I/O байхгүй).

export const money2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

/** BR-10: олгох дүн ≤ батлагдсан дүн (мөн > 0). */
export function amountWithinApproved(disburse: number, approved: number): boolean { return disburse > 0 && money2(disburse) <= money2(approved); }

export interface DecisionTerms { amount: number; termMonths: number; interestRate: number; repaymentType: string; firstPaymentDate: string | null }
export interface DisbursementTerms { approvedAmount: number; termMonths: number; interestRate: number; repaymentType: string; firstPaymentDate: string | null }
export interface ReconDiff { field: string; decision: unknown; disbursement: unknown }

/** FR-12.2: шийдвэр (хүсэлтийн батлагдсан нөхцөл + ЭТХ) ≠ олголтын нөхцөл бол зөрүүг жагсаана. Хоосон = таарсан. */
export function reconcile(decision: DecisionTerms, d: DisbursementTerms): ReconDiff[] {
  const diffs: ReconDiff[] = [];
  const cmp = <T>(field: string, a: T, b: T, eq: (x: T, y: T) => boolean = (x, y) => x === y) => { if (!eq(a, b)) diffs.push({ field, decision: a, disbursement: b }); };
  cmp('approvedAmount', decision.amount, d.approvedAmount, (x, y) => money2(x) === money2(y));
  cmp('termMonths', decision.termMonths, d.termMonths);
  cmp('interestRate', decision.interestRate, d.interestRate, (x, y) => Math.abs(x - y) < 0.00005);
  cmp('repaymentType', decision.repaymentType, d.repaymentType);
  cmp('firstPaymentDate', decision.firstPaymentDate, d.firstPaymentDate);
  return diffs;
}

export const maskAccount = (no: string | null): string | null => (no ? `${'*'.repeat(Math.max(0, no.length - 4))}${no.slice(-4)}` : null);

export interface GateInput {
  applicationStatus: string;
  disburseAmount: number; approvedAmount: number; disburseDate: string | null;
  contractSigned: boolean; hasDecision: boolean; hasLetter: boolean;
  account: { bankCode: string | null; accountNo: string | null; holderName: string | null; ownerType: string | null };
  nameCheckMatched: boolean | null;
  reconDiffs: ReconDiff[]; scheduleCurrent: boolean;
  requiresCollateral: boolean; collaterals: Array<{ registryNo: string | null; releasedAt: Date | null }>;
}

const chk = (key: string, ok: boolean, message: string): DisbursementCheck => ({ key, ok, message });

/** G4 (илгээх): гарын үсэгтэй гэрээ, данс бүрэн, тулгалт зөв (BR-10), барьцаа ЭБ-д. G5-д ижил жагсаалтыг дахин ашиглана (баримт бүрэн, дүн ≤). */
export function evaluateGate(g: GateInput): DisbursementCheck[] {
  const acc = g.account;
  const accountComplete = !!(acc.bankCode && acc.accountNo && acc.holderName && acc.ownerType);
  const unregistered = g.collaterals.filter((c) => !c.registryNo || c.releasedAt != null).length;
  return [
    chk('APPLICATION_APPROVED', g.applicationStatus === 'APPROVED' || g.applicationStatus === 'DISBURSING', 'Хүсэлт батлагдсан байх'),
    chk('AMOUNT_WITHIN_APPROVED', amountWithinApproved(g.disburseAmount, g.approvedAmount), 'Олгох дүн батлагдсан дүнгээс хэтрэхгүй (BR-10)'),
    chk('DISBURSE_DATE', !!g.disburseDate, 'Олгох огноо оруулсан'),
    chk('DECISION_DOCUMENT', g.hasDecision, 'Шийдвэрийн баримт бий'),
    chk('CONTRACT_SIGNED', g.contractSigned, 'Гарын үсэгтэй гэрээ хавсаргасан (G4)'),
    chk('OFFICIAL_LETTER', g.hasLetter, 'Албан бичиг үүсгэсэн'),
    chk('ACCOUNT_COMPLETE', accountComplete, 'Дансны мэдээлэл бүрэн (банк, данс, эзэмшигч, өөрийн/гуравдагч)'),
    chk('ACCOUNT_NAME_CHECK', g.nameCheckMatched === true, 'Данс-нэрийн тулгалт таарсан'),
    chk('RECONCILIATION', g.reconDiffs.length === 0 && g.scheduleCurrent, 'Шийдвэр ба олголтын нөхцөл таарсан, ЭТХ шинэ'),
    chk('COLLATERAL_REGISTERED', (!g.requiresCollateral || g.collaterals.length > 0) && unregistered === 0, 'Барьцаа Эд хөрөнгийн бүртгэлд бүртгэгдсэн'),
  ];
}

// ── H1: тодорхойгүй Core үр дүнгийн дараах "олдсонгүй"-н баталгаа ──
/**
 * Settle цонх: Core-ийн клиент timeout 15с, lease 120с; Core тал дараалал/batch-аар хожуу боловсруулж болно.
 * 900с = timeout-ийн 60×, lease-ийн 7.5×, sweeper-ийн (300с) 3 tick — Core-ийн боловсруулалтын цонхноос хол давна.
 */
export const DEFAULT_SETTLE_SECONDS = 900;
const MIN_SETTLE_SECONDS = 120; // lease-ээс богино цонх утгагүй
const MAX_SETTLE_SECONDS = 86_400;
/**
 * N = 2: нэг "олдсонгүй" нь Core-ийн replica/индексийн хоцрогдол эсвэл ганц алдаатай хариу байж болно; цонхны дараах,
 * хоорондоо ≥ lease зайтай хоёр лавлагаа хоёулаа "олдсонгүй" бол санамсаргүй давхцал биш. Давтах тусам FAILED хойшлох тул 2-оор хязгаарлав.
 */
export const NOT_FOUND_MIN_LOOKUPS = 2;

/**
 * H1 инвариант: lease нь findLoan + openLoan (тус бүр ≤ callTimeout) + зайг багтаах ёстой (lease ≥ 3 × timeout).
 * Буцаах утга = send deadline: lease эхэлснээс хойш openLoan-ийг ЭХЛҮҮЛЖ болох сүүлийн мөч = lease − timeout, тиймээс илгээсэн хүсэлт
 * (клиентийн талаас) lease дуусахаас өмнө дуусна. Зөрчвөл модуль ачаалахад унана.
 */
export function assertCoreTiming(leaseMs: number, callTimeoutMs: number): number {
  if (!(callTimeoutMs > 0) || leaseMs < 3 * callTimeoutMs) throw new Error(`H1: CORE_LEASE_MS (${leaseMs}) must be >= 3 × Core call timeout (${callTimeoutMs})`);
  return leaseMs - callTimeoutMs;
}

/**
 * claimStale-ийн settle эхлэл. Илгээх тамга (`core_unknown_at`) нь openLoan-оос өмнө fenced-ээр бичигддэг тул
 * `unknownAt ≥ expiredLease` ⇔ тухайн lease дор openLoan илгээгдэж болсон. Тэгвэл илгээлт lease дуустал эхэлж болох байсан тул
 * эхлэл = max(unknownAt, expiredLease + lease). Lookup-only lease (reconcile/sweeper claim) нь өөрийн lease-ээс өмнөх тамгатай
 * (claim-ийн эхлэл ≤ өмнөх lease төгсгөл < шинэ lease) тул эхлэл хөдлөхгүй — sweeper цонхыг үүрд хойшлуулахгүй.
 * Тамгагүй мөр (илгээгээгүй) → lease төгсгөл (консерватив); lease-гүй → одоо.
 */
export function settleAnchor(unknownAt: Date | null, expiredLease: Date | null, now: Date, leaseMs: number): Date {
  if (!expiredLease) return unknownAt ?? now;
  const leaseEnd = new Date(expiredLease.getTime() + leaseMs);
  if (!unknownAt) return leaseEnd;
  if (unknownAt.getTime() < expiredLease.getTime()) return unknownAt;
  return unknownAt.getTime() > leaseEnd.getTime() ? unknownAt : leaseEnd;
}

export interface CoreSettlePolicy { settleMs: number; minLookups: number; lookupSpacingMs: number }
/** `unknownAt` null = мөр тодорхойгүй үр дүнгүй (өмнөх зан төлөв: нэг "олдсонгүй" баталгаатай). */
export interface NotFoundEvidence { unknownAt: Date | null; notFoundCount: number; lastNotFoundAt: Date | null }

/** DISBURSEMENT_CORE_SETTLE_SECONDS: хоосон/буруу/сөрөг → 900; 120…86400-аар хязгаарлана. */
export function parseSettleSeconds(raw: string | undefined): number {
  const n = Number(raw?.trim() || DEFAULT_SETTLE_SECONDS);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SETTLE_SECONDS;
  return Math.min(Math.max(n, MIN_SETTLE_SECONDS), MAX_SETTLE_SECONDS);
}

const settled = (e: NotFoundEvidence, now: Date, p: CoreSettlePolicy): boolean => !!e.unknownAt && now.getTime() - e.unknownAt.getTime() >= p.settleMs;

/** Нэг "олдсонгүй" лавлагааг бүртгэнэ (шинэ объект). Зөвхөн settle цонхны дараах, өмнөхөөс ≥ spacing зайтай лавлагаа тоологдоно. */
export function recordNotFound(e: NotFoundEvidence, now: Date, p: CoreSettlePolicy): NotFoundEvidence {
  if (!settled(e, now, p)) return e;
  if (e.lastNotFoundAt && now.getTime() - e.lastNotFoundAt.getTime() < p.lookupSpacingMs) return e;
  return { ...e, notFoundCount: e.notFoundCount + 1, lastNotFoundAt: now };
}

/** "Core-д данс байхгүй" нь баталгаатай эсэх: тодорхойгүй үр дүнгүй, эсвэл цонх өнгөрч ≥ N лавлагаа олдоогүй. */
export function isNotFoundDefinitive(e: NotFoundEvidence, now: Date, p: CoreSettlePolicy): boolean {
  return !e.unknownAt || (settled(e, now, p) && e.notFoundCount >= p.minLookups);
}
