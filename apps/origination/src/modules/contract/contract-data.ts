import type { RepaymentType } from '@los/contracts';

// FR-11.2: загварт дүүргэх талбарууд (placeholder каталог: @los/contracts PLACEHOLDER_CATALOG). Цэвэр функц — I/O байхгүй.

export const REPAYMENT_LABEL: Record<RepaymentType, string> = { ANNUITY: 'Тэгш төлөлт (аннуитет)', EQUAL_PRINCIPAL: 'Үндсэн төлбөр тэнцүү', QUARTERLY: 'Улирлын', BULLET: 'Төгсгөлд нь' };

/** 30000000 → "30,000,000"; бутархай байвал 2 орон. */
export function fmtMoney(n: number): string {
  const [i, f] = n.toFixed(2).split('.');
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f === '00' ? '' : `.${f}`}`;
}

export interface ContractDataInput {
  contractNo: string; contractDate: string; decisionNo: string | null; productName: string; currency: string;
  amount: number; termMonths: number; interestRate: number; repaymentType: RepaymentType | string; firstPaymentDate: string | null;
  borrower: { name: string; registerNo: string; phone: string; address: string };
  coBorrowerNames: string[]; branchName: string; officerName: string;
  collaterals: Array<{ description: string; value: number; registryNo: string | null }>;
  schedule: Array<{ seq: number; dueDate: string; principal: number; interest: number; total: number; balance: number }>;
  org: { name: string; representativeName: string; representativeTitle: string };
}

export function buildTemplateData(i: ContractDataInput): Record<string, string | number | Array<Record<string, string | number | null>>> {
  const rows = i.schedule.filter((r) => r.seq > 0); // seq 0 = олголтын мөр
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
  const totalPayment = rows.reduce((s, r) => s + r.total, 0);
  return {
    contract_no: i.contractNo, contract_date: i.contractDate, decision_no: i.decisionNo ?? '', product_name: i.productName,
    approved_amount: fmtMoney(i.amount), currency: i.currency, term_months: i.termMonths, interest_rate: i.interestRate,
    repayment_type: REPAYMENT_LABEL[i.repaymentType as RepaymentType] ?? i.repaymentType, first_payment_date: i.firstPaymentDate ?? '',
    borrower_name: i.borrower.name, borrower_register: i.borrower.registerNo, borrower_phone: i.borrower.phone, borrower_address: i.borrower.address,
    co_borrower_names: i.coBorrowerNames.join(', '), branch_name: i.branchName, officer_name: i.officerName,
    collateral_summary: i.collaterals.length ? i.collaterals.map((c) => `${c.description} (${fmtMoney(c.value)} ${i.currency})`).join('; ') : 'Барьцаагүй',
    collaterals: i.collaterals.map((c) => ({ description: c.description, value: fmtMoney(c.value), registry_no: c.registryNo ?? '' })),
    signer_name: i.borrower.name, sign_date: i.contractDate,
    schedule: rows.map((r) => ({ no: r.seq, due_date: r.dueDate, principal: fmtMoney(r.principal), interest: fmtMoney(r.interest), total: fmtMoney(r.total), balance: fmtMoney(r.balance) })),
    total_interest: fmtMoney(totalInterest), total_payment: fmtMoney(totalPayment),
    org_name: i.org.name, representative_name: i.org.representativeName, representative_title: i.org.representativeTitle,
  };
}
