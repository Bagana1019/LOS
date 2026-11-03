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
  const cmp = (field: string, a: unknown, b: unknown, eq: (x: never, y: never) => boolean = (x, y) => x === y) => { if (!eq(a, b)) diffs.push({ field, decision: a, disbursement: b }); };
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
