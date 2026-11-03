// Тестийн BsaScoringClient: scoring-ийн BSA API-г санах ойд дуурайна (finalize хураангуй, нэгтгэл). Бодит нь `HttpBsaScoringClient`.
import { combineBsa } from '@los/calc';
import type { BsaCombinedSummary, BsaCreateAnalysisRequest, BsaRecalculateRequest, BsaSummary, RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import type { BsaAnalysisRef, BsaScoringClient, FinalizeOutcome } from '../bsa-scoring.client';
import type { BsaReportStore } from '../bsa-report.store';

export interface FakeAnalysis extends BsaAnalysisRef {
  /** finalize-д буцаах хураангуйн тоон хэсэг */
  numbers: Pick<BsaSummary, 'totalMonthlyIncome' | 'verifiedMonthlyIncome' | 'dtiIncome' | 'businessIncomeMonthly' | 'businessExpenseMonthly' | 'netCashFlowMonthly' | 'existingDebtServiceMonthly' | 'incomeReliability' | 'pendingSuspiciousCount'>;
}

export class FakeBsaScoringClient implements BsaScoringClient {
  analyses: FakeAnalysis[] = [];
  calls: string[] = [];
  created: BsaCreateAnalysisRequest[] = [];
  recalculated: Array<{ id: string; payment: number | null | undefined }> = [];
  failWith: Error | null = null;
  pdfFails = false;
  private seq = 0;

  reset(): void {
    this.analyses = [];
    this.calls = [];
    this.created = [];
    this.recalculated = [];
    this.failWith = null;
    this.pdfFails = false;
    this.seq = 0;
  }

  /** Тест шинжилгээг шууд бэлдэнэ (scoring-д импорт хийгдсэн мэт) */
  seedAnalysis(a: { customerId: string; borrowerId: string; applicationId: string; numbers?: Partial<FakeAnalysis['numbers']>; status?: 'DRAFT' | 'ANALYZED'; payment?: number | null }): FakeAnalysis {
    const row: FakeAnalysis = {
      id: `an-${++this.seq}`, applicationId: a.applicationId, loanApplicationId: a.applicationId, customerId: a.customerId, borrowerId: a.borrowerId, status: a.status ?? 'DRAFT', version: 1,
      proposedMonthlyPayment: a.payment ?? null,
      numbers: { totalMonthlyIncome: 3_000_000, verifiedMonthlyIncome: 2_500_000, dtiIncome: 2_250_000, businessIncomeMonthly: 2_000_000, businessExpenseMonthly: 500_000, netCashFlowMonthly: 1_500_000, existingDebtServiceMonthly: 200_000, incomeReliability: 80, pendingSuspiciousCount: 0, ...a.numbers },
    };
    this.analyses.push(row);
    return row;
  }

  private guard(op: string): void {
    this.calls.push(op);
    if (this.failWith) throw this.failWith;
  }

  async listAnalyses(_ctx: RequestContext, applicationId: string): Promise<BsaAnalysisRef[]> {
    this.guard('list');
    return this.analyses.filter((a) => a.applicationId === applicationId).map(({ numbers: _n, ...ref }) => ref);
  }

  async createAnalysis(_ctx: RequestContext, request: BsaCreateAnalysisRequest): Promise<BsaAnalysisRef> {
    this.guard('create');
    this.created.push(request);
    const row = this.seedAnalysis({ customerId: request.customerId, borrowerId: request.borrowerId ?? request.customerId, applicationId: request.loanApplicationId, payment: request.proposedMonthlyPayment ?? null });
    const { numbers: _n, ...ref } = row;
    return ref;
  }

  async recalculate(_ctx: RequestContext, analysisId: string, request: BsaRecalculateRequest): Promise<void> {
    this.guard('recalculate');
    this.recalculated.push({ id: analysisId, payment: request.proposedMonthlyPayment });
    const a = this.analyses.find((x) => x.id === analysisId);
    if (a && request.proposedMonthlyPayment !== undefined) a.proposedMonthlyPayment = request.proposedMonthlyPayment;
  }

  private summaryOf(a: FakeAnalysis): BsaSummary {
    const payment = a.proposedMonthlyPayment ?? 0;
    const dtiPercent = Math.round(((payment + a.numbers.existingDebtServiceMonthly) / a.numbers.dtiIncome) * 1000) / 10;
    return {
      analysisId: a.id, loanApplicationId: a.applicationId ?? '', borrowerId: a.borrowerId ?? a.customerId, status: a.status, version: a.version, periodMonths: 6, periodFrom: '2026-03-10', periodTo: '2026-09-10',
      transactionCount: 120, ...a.numbers, dtiPercent, dtiLevel: dtiPercent <= 35 ? 'LOW' : dtiPercent <= 55 ? 'MEDIUM' : 'HIGH', reportPdfUrl: null,
    };
  }

  async finalize(_ctx: RequestContext, analysisId: string): Promise<FinalizeOutcome> {
    this.guard('finalize');
    const a = this.analyses.find((x) => x.id === analysisId);
    if (!a) throw new DomainError('ANALYSIS_NOT_FOUND', 'Шинжилгээ олдсонгүй', 404);
    if (a.numbers.pendingSuspiciousCount > 0 && this.blockPending) throw new DomainError('PENDING_SUSPICIOUS_BLOCK', 'Шийдвэрлэгдээгүй сэжигтэй гүйлгээ байгаа тул хориглосон', 422);
    a.status = 'ANALYZED';
    const warnings = a.numbers.pendingSuspiciousCount > 0 ? [{ code: 'PENDING_SUSPICIOUS', message: `Шийдвэрлэгдээгүй ${a.numbers.pendingSuspiciousCount} сэжигтэй дохио байна.` }] : [];
    return { summary: this.summaryOf(a), warnings };
  }
  blockPending = false;

  async combined(_ctx: RequestContext, applicationId: string): Promise<BsaCombinedSummary> {
    this.guard('combined');
    const mine = this.analyses.filter((a) => a.applicationId === applicationId);
    const payment = mine.find((a) => a.proposedMonthlyPayment !== null && a.proposedMonthlyPayment !== undefined)?.proposedMonthlyPayment ?? 0;
    const c = combineBsa(mine.map((a) => a.numbers), payment);
    return {
      applicationId, analysisCount: mine.length, allAnalyzed: mine.every((a) => a.status === 'ANALYZED'), ...c,
      dtiLevel: c.dtiPercent <= 35 ? 'LOW' : c.dtiPercent <= 55 ? 'MEDIUM' : 'HIGH',
      members: mine.map((a) => ({ analysisId: a.id, borrowerId: a.borrowerId ?? a.customerId, status: a.status, dtiIncome: a.numbers.dtiIncome, existingDebtServiceMonthly: a.numbers.existingDebtServiceMonthly })),
    };
  }

  async reportPdf(): Promise<Buffer> {
    this.guard('pdf');
    if (this.pdfFails) throw new DomainError('REPORT_NOT_AVAILABLE', 'тайлан байхгүй', 422);
    return Buffer.from('%PDF-1.4 fake');
  }
}

export class FakeReportStore implements BsaReportStore {
  stored: Array<{ applicationId: string; bytes: number }> = [];
  async store(_ctx: RequestContext, applicationId: string, pdf: Buffer): Promise<boolean> {
    this.stored.push({ applicationId, bytes: pdf.length });
    return true;
  }
}
