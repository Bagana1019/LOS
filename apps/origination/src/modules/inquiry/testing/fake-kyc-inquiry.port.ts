import { INQUIRY_SOURCES, type CreditHistorySummary, type InquiryFetchResponse, type InquiryListResponse, type InquiryRecord, type KycUnregisteredLoanRequest, type RequestContext, type UnregisteredLoan } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import type { InquiryFetchInput, KycInquiryPort } from '../ports/kyc-inquiry.port';

/** Тестийн kyc: санах ойд хадгална; CIB-д тогтмол сарын төлбөр. `failSources`-д заасан эх сурвалж унана, `notImplemented` бол 501. */
export class FakeKycInquiryPort implements KycInquiryPort {
  rows: InquiryRecord[] = [];
  loans: UnregisteredLoan[] = [];
  calls: InquiryFetchInput[] = [];
  failSources = new Set<string>();
  notImplemented = false;
  cibMonthlyPayment = 350_000;
  now = () => new Date();
  private n = 0;

  async fetch(_ctx: RequestContext, req: InquiryFetchInput): Promise<InquiryFetchResponse> {
    this.calls.push(req);
    if (this.notImplemented) throw new DomainError('INTEGRATION_NOT_IMPLEMENTED', 'Бодит холболт хараахан хийгдээгүй', 501);
    const fetchedAt = this.now().toISOString();
    const items: InquiryRecord[] = [];
    const failures: InquiryFetchResponse['failures'] = [];
    for (const source of req.sources ?? INQUIRY_SOURCES) {
      if (this.failSources.has(source)) { failures.push({ source, code: 'INQUIRY_UNAVAILABLE', message: `${source} түр ажиллахгүй` }); continue; }
      const summary: Record<string, unknown> = source === 'CIB' ? { active_loan_count: 1, total_disbursed: 5_000_000, outstanding: 3_000_000, monthly_payment: this.cibMonthlyPayment } : source === 'BLACKLIST' ? { hit: !!req.blacklist?.hit } : {};
      const rec: InquiryRecord = {
        id: `inq-${++this.n}`, applicationId: req.applicationId, customerId: req.customerId, source, fetchedAt, fetchedBy: 'u', expiresAt: null,
        warningLevel: source === 'BLACKLIST' && req.blacklist?.hit ? 'RED' : 'NONE', summary, detail: source === 'CIB' ? { loans: [] } : null,
      };
      items.push(rec);
      this.rows.push(rec);
    }
    return { items, failures };
  }

  async list(_ctx: RequestContext, applicationId: string): Promise<InquiryListResponse> {
    const latest = new Map<string, InquiryRecord>();
    for (const r of this.rows.filter((x) => x.applicationId === applicationId)) {
      const k = `${r.customerId}|${r.source}`;
      const cur = latest.get(k);
      if (!cur || r.fetchedAt >= cur.fetchedAt) latest.set(k, r);
    }
    return { items: [...latest.values()], unregisteredLoans: this.loans.filter((l) => (l as UnregisteredLoan & { applicationId?: string }).applicationId === applicationId) };
  }

  async addUnregisteredLoan(_ctx: RequestContext, req: KycUnregisteredLoanRequest): Promise<UnregisteredLoan> {
    const loan = { id: `loan-${++this.n}`, customerId: req.customerId, lenderName: req.lenderName, amount: req.amount, monthlyPayment: req.monthlyPayment, note: req.note ?? null, applicationId: req.applicationId };
    this.loans.push(loan as UnregisteredLoan);
    return loan;
  }

  async removeUnregisteredLoan(_ctx: RequestContext, _applicationId: string, id: string): Promise<void> {
    this.loans = this.loans.filter((l) => l.id !== id);
  }

  async creditHistory(): Promise<CreditHistorySummary> {
    return { ficoScore: null, activeLoanCount: null, overdueHistoryMonths: null, existingDebtServiceMonthly: null };
  }
}
