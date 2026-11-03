// M12c · origination талын BSA интеграци (docs/02 §7). origination → scoring sync REST (CLAUDE.md §3.2.2).
//  - INT-1 `createAnalysis`: зээлдэгчийн регистр/нэр/данс/санал болгосон төлбөрийг LOS-оос дүүргэж scoring-д шинжилгээ үүсгэнэ.
//  - INT-4 `push` («Системрүү татах»): scoring finalize → хүсэлтийн нэгтгэл (BSA-BR-9) → НЭГ транзакцид `bsa_summary_json`, `income_summary.business_ncf_monthly`,
//    аудит → `income` алхмыг дахин тооцох → `score` алхмыг STALE (B/C арга идэвхжинэ). Төлөв өөрчлөхгүй (ApplicationStateMachine хамаарахгүй).
//  - INT-6 `syncPayment`: ЭТХ/нөхцөл өөрчлөгдөхөд санал болгосон төлбөрийг BSA руу → DTI дахин. Best effort (scoring унасан бол хүсэлтийн өөрчлөлтийг эвдэхгүй).
//  - INT-9: PDF тайланг dms-д хадгалж 8-р алхамд «bsa_report» төрлөөр (best effort).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LoanApplication, Prisma } from '.prisma/client-origination';
import { hasPermission, type BsaCreateAnalysisRequest, type BsaLosBorrowerRow, type BsaLosCreateAnalysisBody, type BsaLosOverview, type BsaLosPushResponse, type RequestContext } from '@los/contracts';
import { decryptedField, recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { IncomeService } from '../income/income.service';
import { ScoreService } from '../score/score.service';
import { ScoreInputAssembler } from '../score/score-input.assembler';
import { isEditableStatus } from '../score/score.rules';
import { BSA_SCORING_CLIENT, type BsaAnalysisRef, type BsaScoringClient } from './bsa-scoring.client';
import { BSA_REPORT_STORE, type BsaReportStore } from './bsa-report.store';
import { buildLosSummary, paymentChanged } from './bsa.rules';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };
export const BSA_REPORT_URL = (analysisId: string): string => `/api/scoring/bsa/analyses/${encodeURIComponent(analysisId)}/report.pdf`;

@Injectable()
export class BsaService {
  private readonly logger = new Logger(BsaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly assembler: ScoreInputAssembler,
    private readonly income: IncomeService,
    private readonly score: ScoreService,
    private readonly clock: Clock,
    @Inject(BSA_SCORING_CLIENT) private readonly scoring: BsaScoringClient,
    @Inject(BSA_REPORT_STORE) private readonly reports: BsaReportStore,
  ) {}

  // ── унших ──────────────────────────────────────────────────────────────────────────

  async overview(ctx: RequestContext, applicationId: string): Promise<BsaLosOverview> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const rows = await this.participants(app);
    let analyses: BsaAnalysisRef[] | null = null;
    try {
      analyses = await this.scoring.listAnalyses(ctx, app.id);
    } catch (e) {
      if (!(e instanceof DomainError && e.code === 'BSA_UNAVAILABLE')) throw e;
    }
    const latest = new Map<string, BsaAnalysisRef>();
    for (const a of analyses ?? []) if (!latest.has(a.customerId) || latest.get(a.customerId)!.version < a.version) latest.set(a.customerId, a);

    const borrowers: BsaLosBorrowerRow[] = rows.map((r) => {
      const a = latest.get(r.customerId) ?? null;
      return {
        customerId: r.customerId, role: r.role as BsaLosBorrowerRow['role'], displayName: r.displayName,
        analysisId: a?.id ?? null, status: a?.status ?? null, version: a?.version ?? null,
        dtiPercent: a?.summary?.dtiPercent ?? null, pendingSuspiciousCount: a?.summary?.pendingSuspiciousCount ?? null,
      };
    });
    const payment = await this.proposedPayment(ctx, app);
    return {
      applicationId: app.id,
      summary: (app.bsaSummaryJson as Record<string, unknown> | null) ?? null,
      proposedMonthlyPayment: payment,
      borrowers,
      available: analyses !== null,
      editable: isEditableStatus(app.status) && hasPermission(ctx.roles, 'application:write') && (await this.access.can(ctx, app, 'write')),
    };
  }

  // ── INT-1 ──────────────────────────────────────────────────────────────────────────

  async createAnalysis(ctx: RequestContext, applicationId: string, body: BsaLosCreateAnalysisBody): Promise<BsaAnalysisRef> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    const link = await this.prisma.loanApplicationBorrower.findFirst({
      where: { applicationId: app.id, orgId: app.orgId, customerId: body.customerId, role: { in: ['PRIMARY', 'CO_BORROWER'] } },
      include: { customer: true },
    });
    if (!link) throw new DomainError('BORROWER_NOT_IN_APPLICATION', 'Энэ зээлдэгч хүсэлтийн үндсэн/хамтран зээлдэгч биш байна', 422);
    const accounts = await this.prisma.customerBankAccount.findMany({ where: { customerId: link.customerId, orgId: app.orgId } });

    const request: BsaCreateAnalysisRequest = {
      loanApplicationId: app.id,
      customerId: link.customerId,
      borrowerId: link.id,
      branchId: app.branchId,
      customer: {
        registerNo: decryptedField(link.customer.registerNoEncrypted),
        lastName: link.customer.lastName,
        firstName: link.customer.firstName,
        phone: link.customer.phone,
        declaredAccounts: accounts.map((a) => ({ bankCode: toBankCode(a.bankCode), accountNo: decryptedField(a.accountNoEncrypted), iban: a.iban, holderName: null })),
      },
      ...(body.periodMonths ? { periodMonths: body.periodMonths } : {}),
      ...(body.periodFrom && body.periodTo ? { periodFrom: body.periodFrom, periodTo: body.periodTo } : {}),
      proposedMonthlyPayment: await this.proposedPayment(ctx, app),
    };
    const created = await this.scoring.createAnalysis(ctx, request);
    await recordAudit(this.prisma, {
      orgId: app.orgId, entity: 'BSA_ANALYSIS', entityId: created.id, action: 'BSA_ANALYSIS_CREATED', actorId: ctx.userId, beforeJson: null,
      afterJson: { customerId: link.customerId, version: created.version }, applicationId: app.id, correlationId: ctx.correlationId,
    });
    return created;
  }

  // ── INT-4 + INT-9 ──────────────────────────────────────────────────────────────────

  async push(ctx: RequestContext, applicationId: string, analysisId: string): Promise<BsaLosPushResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    // Шинжилгээ энэ хүсэлтийнх мөн эсэх: scoring-ийн жагсаалтаас
    const mine = (await this.scoring.listAnalyses(ctx, app.id)).find((a) => a.id === analysisId);
    if (!mine) throw new DomainError('BSA_ANALYSIS_NOT_FOUND', 'Шинжилгээ энэ хүсэлтэд олдсонгүй', 404);

    const finalized = await this.scoring.finalize(ctx, analysisId);
    const combined = await this.scoring.combined(ctx, app.id);
    const warnings = finalized.warnings.map((w) => w.message);

    // INT-9: PDF (best effort)
    let reportAttached = false;
    try {
      const pdf = await this.scoring.reportPdf(ctx, analysisId);
      reportAttached = await this.reports.store(ctx, app.id, pdf, `bsa-${app.id}.pdf`);
    } catch (e) {
      this.logger.warn({ msg: 'bsa report was not attached to the document step', applicationId: app.id, reason: e instanceof Error ? e.name : 'unknown', correlationId: ctx.correlationId });
      warnings.push('PDF тайланг баримтын алхамд хавсаргаж чадсангүй. Дараа дахин татна уу');
    }

    const summary = buildLosSummary(finalized.summary, combined, warnings, this.clock.now(), BSA_REPORT_URL(analysisId));
    const borrower = await this.prisma.loanApplicationBorrower.findFirst({ where: { id: finalized.summary.borrowerId, applicationId: app.id, orgId: app.orgId }, select: { customerId: true } });
    const customerId = borrower?.customerId ?? mine.customerId;

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.loanApplication.findUniqueOrThrow({ where: { id: app.id }, select: { bsaSummaryJson: true, status: true } });
      if (!isEditableStatus(before.status)) throw new DomainError('APPLICATION_NOT_EDITABLE', 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л BSA татна', 409, { status: before.status });
      await tx.loanApplication.update({ where: { id: app.id }, data: { bsaSummaryJson: summary as unknown as Prisma.InputJsonValue, updatedBy: ctx.userId } });
      // FR-4.2: бизнесийн орлого = энэ зээлдэгчийн цэвэр мөнгөн урсгал (ЦМУ). Хамтран зээлдэгч тус бүр өөрийн мөрөнд.
      await tx.incomeSummary.upsert({
        where: { applicationId_customerId: { applicationId: app.id, customerId } },
        create: { orgId: app.orgId, applicationId: app.id, customerId, businessNcfMonthly: finalized.summary.netCashFlowMonthly, businessExpenseMonthly: finalized.summary.businessExpenseMonthly, createdBy: ctx.userId, updatedBy: ctx.userId },
        update: { businessNcfMonthly: finalized.summary.netCashFlowMonthly, businessExpenseMonthly: finalized.summary.businessExpenseMonthly, updatedBy: ctx.userId },
      });
      await recordAudit(tx, {
        orgId: app.orgId, entity: 'BSA_ANALYSIS', entityId: analysisId, action: 'BSA_PUSHED', actorId: ctx.userId,
        beforeJson: { status: (before.bsaSummaryJson as { status?: string } | null)?.status ?? null },
        afterJson: { status: summary.status, dtiPercent: summary.dtiPercent, pendingSuspiciousCount: summary.pendingSuspiciousCount, analysisCount: summary.analysisCount },
        applicationId: app.id, correlationId: ctx.correlationId,
      });
    }, TX_OPTIONS);

    await this.income.refresh(ctx, app.id); // `income` алхам: бизнесийн ЦМУ орсноор орлого бүрдэж болно
    await this.score.markStale(ctx, app.id, 'BSA шинжилгээ өөрчлөгдсөн'); // `score` COMPLETED бол STALE → дахин тооцоолж B/C идэвхжинэ
    return { summary: summary as unknown as Record<string, unknown>, warnings, reportAttached };
  }

  // ── INT-6 ──────────────────────────────────────────────────────────────────────────

  /**
   * ЭТХ/зээлийн нөхцөл өөрчлөгдөхөд дуудагдана (Loan-terms, Schedule). Өөрчлөлт нь аль хэдийн commit хийгдсэн тул алдааг шидэхгүй (BSA түр унасан ч нөхцөл хадгалагдсан хэвээр).
   * Хүсэлтийн зээлдэгч бүрийн хамгийн сүүлийн хувилбарт шинэ төлбөрийг өгч DTI-г дахин тооцуулна; өмнө татсан (bsa_summary_json) бол нэгтгэлийг дахин бичнэ.
   */
  async syncPayment(ctx: RequestContext, applicationId: string): Promise<{ updated: number }> {
    try {
      const app = await this.prisma.loanApplication.findFirst({ where: { id: applicationId, orgId: ctx.orgId } });
      if (!app) return { updated: 0 };
      // Энэ хүсэлтэд BSA шинжилгээ үүсгэгдээгүй бол scoring-ийг дуудахгүй (локал шалгалт: аудит)
      if ((await this.prisma.auditLog.count({ where: { orgId: app.orgId, applicationId: app.id, entity: 'BSA_ANALYSIS' } })) === 0) return { updated: 0 };
      const payment = await this.proposedPayment(ctx, app);
      if (payment === null) return { updated: 0 };
      const analyses = await this.scoring.listAnalyses(ctx, app.id);
      const latest = new Map<string, BsaAnalysisRef>();
      for (const a of analyses) if (!latest.has(a.customerId) || latest.get(a.customerId)!.version < a.version) latest.set(a.customerId, a);
      let updated = 0;
      for (const a of latest.values()) {
        if (!paymentChanged(a.proposedMonthlyPayment, payment)) continue;
        await this.scoring.recalculate(ctx, a.id, { proposedMonthlyPayment: payment });
        updated += 1;
      }
      const stored = app.bsaSummaryJson as { analysisId?: string; status?: string } | null;
      if (updated > 0 && stored?.analysisId) {
        const combined = await this.scoring.combined(ctx, app.id);
        const prev = app.bsaSummaryJson as unknown as ReturnType<typeof buildLosSummary>;
        const next = { ...prev, status: combined.allAnalyzed && prev.status === 'ANALYZED' ? 'ANALYZED' : 'DRAFT', dtiPercent: combined.dtiPercent, dtiLevel: combined.dtiLevel, pendingSuspiciousCount: combined.pendingSuspiciousCount, members: combined.members };
        await this.prisma.loanApplication.update({ where: { id: app.id }, data: { bsaSummaryJson: next as unknown as Prisma.InputJsonValue } });
      }
      return { updated };
    } catch (e) {
      this.logger.warn({ msg: 'bsa payment sync skipped', applicationId, reason: e instanceof DomainError ? e.code : e instanceof Error ? e.name : 'unknown', correlationId: ctx.correlationId });
      return { updated: 0 };
    }
  }

  // ── дотоод ──────────────────────────────────────────────────────────────────────────

  /** ЭТХ-ээс (эсвэл аннуитет) шинэ зээлийн сарын төлбөр — BSA-FR-4.8: гараар бичихгүй. Нөхцөл дутуу бол null */
  private async proposedPayment(ctx: RequestContext, app: LoanApplication): Promise<number | null> {
    const assembled = await this.assembler.assemble(ctx, app);
    return assembled.request?.monthlyPayment ?? null;
  }

  private async participants(app: LoanApplication): Promise<Array<{ customerId: string; role: string; displayName: string }>> {
    const rows = await this.prisma.loanApplicationBorrower.findMany({
      where: { applicationId: app.id, orgId: app.orgId, role: { in: ['PRIMARY', 'CO_BORROWER'] } },
      include: { customer: { select: { lastName: true, firstName: true } } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    const mapped = rows.map((r) => ({ customerId: r.customerId, role: r.role, displayName: [r.customer.lastName, r.customer.firstName].filter(Boolean).join(' ') }));
    // PRIMARY эхэнд (Prisma enum-ийн эрэмбэ биш)
    return [...mapped.filter((m) => m.role === 'PRIMARY'), ...mapped.filter((m) => m.role !== 'PRIMARY')];
  }

  private assertEditable(app: Pick<LoanApplication, 'status'>): void {
    if (!isEditableStatus(app.status)) throw new DomainError('APPLICATION_NOT_EDITABLE', 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л BSA хийнэ', 409, { status: app.status });
  }
}

const BANK_CODES = ['KHAN', 'GOLOMT', 'TDB', 'XAC', 'CAPITRON', 'STATE', 'MBANK'] as const;
const toBankCode = (code: string): (typeof BANK_CODES)[number] | null => ((BANK_CODES as readonly string[]).includes(code.toUpperCase()) ? (code.toUpperCase() as (typeof BANK_CODES)[number]) : null);
