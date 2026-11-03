import { Inject, Injectable } from '@nestjs/common';
import { averageMonthlySalary } from '@los/calc';
import type {
  IncomeBorrowerView, IncomeCalculateBody, IncomeExpensesBody, IncomeManualInput, IncomeOverviewResponse, IncomeSalaryInput, ManualIncomeType, RequestContext,
} from '@los/contracts';
import { recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { LoanApplication } from '.prisma/client-origination';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { applyStepUpdates, loadSteps, planScoreStale, planStepTarget } from '../../shared/step-updates';
import { isEditableStatus } from '../borrower/borrower.rules';
import { CustomerDirectory, customerDisplayName, customerRegisterNo } from '../borrower/customer-directory';
import {
  BSA_INACTIVE_MESSAGE, dateToYearMonth, hasIncome, incomeBlockers, incomeStepTarget, isFutureMonth, monthEnd, monthStart, parseYearMonth, summaryView,
  type IncomeParticipant,
} from './income.rules';
import { KYC_NDSH_PORT, type KycNdshPort } from './ports/kyc-ndsh.port';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };
const NOT_EDITABLE = 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л орлогыг өөрчилнө';
const num = (v: { toNumber(): number } | number | null | undefined): number | null => (v === null || v === undefined ? null : typeof v === 'number' ? v : v.toNumber());

/**
 * FR-4 · Орлого (wizard-ийн 3-р алхам, BSA-гүй хувилбар): НДШ цалин, гар цалин/орлого, хугацаа сонгож сарын дундаж, өрхийн/бизнесийн зардал.
 * Мутаци бүр: эрх → (гадны дуудлага — НДШ, транзакцаас гадна) → нэг транзакц { хүсэлтийн мөрийг FOR UPDATE → төлөв → бичих → дундаж шинэчлэх → `income` алхам →
 * `score` алхмыг STALE → аудит }. Цалингийн дундаж `income_summary.avg_salary_monthly`-д хадгалагдаж Модуль 8 унших ба «Тооцоолох»-оор тодорхойлсон
 * хугацаа өөрчлөгдөөгүй бол цалингийн мөр өөрчлөгдөх бүрт ижил хугацаагаар автоматаар шинэчлэгдэнэ.
 * Бизнесийн орлого (FR-4.2) нь BSA (Модуль 12)-ээс `business_ncf_monthly`-д орно; одоогоор placeholder.
 */
@Injectable()
export class IncomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly clock: Clock,
    private readonly directory: CustomerDirectory,
    @Inject(KYC_NDSH_PORT) private readonly ndsh: KycNdshPort,
  ) {}

  async overview(ctx: RequestContext, applicationId: string): Promise<IncomeOverviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'read');
    return this.build(this.prisma, app);
  }

  /** FR-4.1 · НДШ-ээс цалин татах: тухайн харилцагчийн өмнөх НДШ мөрүүдийг солино (гар мөр хэвээр). */
  async fetchNdsh(ctx: RequestContext, applicationId: string, customerId: string): Promise<IncomeOverviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    const owner = await this.requireParticipant(this.prisma, app.id, customerId);
    const customer = await this.directory.findById(this.prisma, app.orgId, customerId);
    if (!customer) throw new DomainError('INCOME_BORROWER_NOT_FOUND', 'Харилцагч олдсонгүй', 404);
    const { items } = await this.ndsh.fetchSalaries(ctx, customerRegisterNo(customer));
    return this.mutate(ctx, app, 'INCOME_NDSH_FETCHED', async (tx) => {
      await tx.incomeSalary.deleteMany({ where: { applicationId: app.id, customerId: owner.customerId, source: 'NDSH' } });
      if (items.length) {
        await tx.incomeSalary.createMany({
          data: items.map((r) => ({ orgId: app.orgId, applicationId: app.id, customerId, employer: r.employer, year: r.year, month: r.month, salary: r.salary, contributionPaid: r.contributionPaid, source: 'NDSH', createdBy: ctx.userId, updatedBy: ctx.userId })),
        });
      }
      await this.refreshAverage(tx, app, customerId, ctx);
      return { customerId, rows: items.length };
    });
  }

  /** Гараар цалингийн мөр нэмэх (НДШ-д байхгүй / засвар). */
  async addSalary(ctx: RequestContext, applicationId: string, input: IncomeSalaryInput): Promise<IncomeOverviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    if (isFutureMonth({ year: input.year, month: input.month }, this.clock.now())) throw new DomainError('INVALID_PERIOD', 'Ирээдүйн сарын цалин оруулж болохгүй', 422);
    return this.mutate(ctx, app, 'INCOME_SALARY_ADDED', async (tx) => {
      await this.requireParticipant(tx, app.id, input.customerId);
      const row = await tx.incomeSalary.create({
        data: { orgId: app.orgId, applicationId: app.id, customerId: input.customerId, employer: input.employer ?? null, year: input.year, month: input.month, salary: input.salary, contributionPaid: input.contributionPaid ?? null, source: 'MANUAL', createdBy: ctx.userId, updatedBy: ctx.userId },
      });
      await this.refreshAverage(tx, app, input.customerId, ctx);
      return { customerId: input.customerId, salaryId: row.id, year: input.year, month: input.month };
    });
  }

  async removeSalary(ctx: RequestContext, applicationId: string, salaryId: string): Promise<IncomeOverviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    return this.mutate(ctx, app, 'INCOME_SALARY_REMOVED', async (tx) => {
      const row = await tx.incomeSalary.findFirst({ where: { id: salaryId, applicationId: app.id } });
      if (!row) throw new DomainError('SALARY_NOT_FOUND', 'Цалингийн мөр олдсонгүй', 404);
      if (row.source !== 'MANUAL') throw new DomainError('SALARY_NOT_EDITABLE', 'НДШ-ээс татсан мөрийг устгахгүй — дахин татаж шинэчилнэ үү', 422);
      await tx.incomeSalary.delete({ where: { id: row.id } });
      await this.refreshAverage(tx, app, row.customerId, ctx);
      return { customerId: row.customerId, salaryId };
    });
  }

  /** FR-4.1 · «Тооцоолох»: сонгосон хугацааны (календарийн сар) цалингийн нийт ба сарын дундаж. */
  async calculate(ctx: RequestContext, applicationId: string, input: IncomeCalculateBody): Promise<IncomeOverviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    const from = parseYearMonth(input.periodFrom);
    const to = parseYearMonth(input.periodTo);
    if (isFutureMonth(to, this.clock.now())) throw new DomainError('INVALID_PERIOD', 'Хугацааны төгсгөл ирээдүйн сар байж болохгүй', 422);
    try { averageMonthlySalary([], from, to); } catch (e) { throw new DomainError('INVALID_PERIOD', e instanceof RangeError && /longer/.test(e.message) ? 'Хугацаа 60 сараас хэтэрч болохгүй' : 'Хугацааны эхлэл төгсгөлөөс хойно байж болохгүй', 422); }
    return this.mutate(ctx, app, 'INCOME_CALCULATED', async (tx) => {
      await this.requireParticipant(tx, app.id, input.customerId);
      const salaries = await tx.incomeSalary.findMany({ where: { applicationId: app.id, customerId: input.customerId }, select: { year: true, month: true, salary: true } });
      const calc = averageMonthlySalary(salaries.map((s) => ({ year: s.year, month: s.month, salary: s.salary.toNumber() })), from, to);
      await this.upsertSummary(tx, app, input.customerId, ctx, { periodFrom: monthStart(from), periodTo: monthEnd(to), avgSalaryMonthly: calc.average });
      return { customerId: input.customerId, periodFrom: input.periodFrom, periodTo: input.periodTo, average: calc.average };
    });
  }

  async addManual(ctx: RequestContext, applicationId: string, input: IncomeManualInput): Promise<IncomeOverviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    return this.mutate(ctx, app, 'INCOME_MANUAL_ADDED', async (tx) => {
      await this.requireParticipant(tx, app.id, input.customerId);
      const row = await tx.incomeManual.create({
        data: { orgId: app.orgId, applicationId: app.id, customerId: input.customerId, type: input.type, monthlyAmount: input.monthlyAmount, fileId: input.fileId ?? null, note: input.note ?? null, createdBy: ctx.userId, updatedBy: ctx.userId },
      });
      return { customerId: input.customerId, manualId: row.id, type: input.type as ManualIncomeType, monthlyAmount: input.monthlyAmount };
    });
  }

  async removeManual(ctx: RequestContext, applicationId: string, manualId: string): Promise<IncomeOverviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    return this.mutate(ctx, app, 'INCOME_MANUAL_REMOVED', async (tx) => {
      const row = await tx.incomeManual.findFirst({ where: { id: manualId, applicationId: app.id } });
      if (!row) throw new DomainError('MANUAL_INCOME_NOT_FOUND', 'Гар орлого олдсонгүй', 404);
      await tx.incomeManual.delete({ where: { id: row.id } });
      return { customerId: row.customerId, manualId };
    });
  }

  /** FR-4.4 · өрхийн сарын зардал, бизнесийн зардал (өгсөн талбарыг л шинэчилнэ). */
  async setExpenses(ctx: RequestContext, applicationId: string, customerId: string, input: IncomeExpensesBody): Promise<IncomeOverviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    return this.mutate(ctx, app, 'INCOME_EXPENSES_SET', async (tx) => {
      await this.requireParticipant(tx, app.id, customerId);
      await this.upsertSummary(tx, app, customerId, ctx, {
        ...(input.householdExpenseMonthly !== undefined ? { householdExpenseMonthly: input.householdExpenseMonthly } : {}),
        ...(input.businessExpenseMonthly !== undefined ? { businessExpenseMonthly: input.businessExpenseMonthly } : {}),
      });
      return { customerId, ...input };
    }, { scoreAffected: true });
  }

  /** `income` алхмыг одоогийн өгөгдлөөр дахин тооцно (оролцогч өөрчлөгдөж STALE болсон үед). Өгөгдөл өөрчлөхгүй. */
  async refresh(ctx: RequestContext, applicationId: string): Promise<IncomeOverviewResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    return this.mutate(ctx, app, null, async () => ({}), { scoreAffected: false });
  }

  // ── дотоод ───────────────────────────────────────────────────────────────────────────
  private assertEditable(app: Pick<LoanApplication, 'status'>): void {
    if (!isEditableStatus(app.status)) throw new DomainError('APPLICATION_NOT_EDITABLE', NOT_EDITABLE, 409, { status: app.status });
  }

  /** Нэг транзакц: түгжих → төлөв → бичих → алхам → аудит → хариу. */
  private async mutate(ctx: RequestContext, app: LoanApplication, action: string | null, write: (tx: Tx) => Promise<Record<string, unknown>>, o: { scoreAffected?: boolean } = {}): Promise<IncomeOverviewResponse> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM origination.loan_application WHERE id = ${app.id} AND org_id = ${ctx.orgId} FOR UPDATE`;
      if (!locked.length) throw new DomainError('APPLICATION_NOT_FOUND', 'Хүсэлт олдсонгүй', 404);
      const current = await tx.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
      this.assertEditable(current);
      const after = await write(tx);
      const built = await this.build(tx, current);
      const steps = await loadSteps(tx, app.id);
      const updates = [...planStepTarget(steps, 'income', incomeStepTarget(built.blockers), this.clock.now()), ...((o.scoreAffected ?? true) ? planScoreStale(steps, 'INCOME_CHANGED') : [])];
      await applyStepUpdates(tx, updates, ctx.userId);
      if (action) await recordAudit(tx, { orgId: ctx.orgId, entity: 'INCOME', entityId: app.id, action, actorId: ctx.userId, beforeJson: null, afterJson: after as never, applicationId: app.id, correlationId: ctx.correlationId });
      const step = await tx.loanApplicationStep.findFirst({ where: { applicationId: app.id, stepKey: 'income' }, select: { status: true, staleReason: true } });
      return { ...built, step: step ? { status: step.status, reason: step.staleReason } : built.step };
    }, TX_OPTIONS);
  }

  private async participants(db: Tx, applicationId: string): Promise<Array<IncomeParticipant & { customerId: string }>> {
    const rows = await db.loanApplicationBorrower.findMany({ where: { applicationId, role: { in: ['PRIMARY', 'CO_BORROWER'] } }, include: { customer: true }, orderBy: { createdAt: 'asc' } });
    const seen = new Set<string>();
    return rows
      .sort((a, b) => (a.role === b.role ? 0 : a.role === 'PRIMARY' ? -1 : 1))
      .filter((r) => (seen.has(r.customerId) ? false : (seen.add(r.customerId), true)))
      .map((r) => ({ customerId: r.customerId, role: r.role as 'PRIMARY' | 'CO_BORROWER', included: r.role === 'PRIMARY' || r.incomeIncluded, displayName: customerDisplayName(r.customer) }));
  }

  private async requireParticipant(db: Tx, applicationId: string, customerId: string) {
    const p = (await this.participants(db, applicationId)).find((x) => x.customerId === customerId);
    if (!p) throw new DomainError('INCOME_BORROWER_NOT_FOUND', 'Орлого оруулах боломжтой оролцогч (үндсэн / хамтран зээлдэгч) биш байна', 404);
    return p;
  }

  private async upsertSummary(tx: Tx, app: LoanApplication, customerId: string, ctx: RequestContext, patch: { periodFrom?: Date; periodTo?: Date; avgSalaryMonthly?: number; householdExpenseMonthly?: number; businessExpenseMonthly?: number }): Promise<void> {
    await tx.incomeSummary.upsert({
      where: { applicationId_customerId: { applicationId: app.id, customerId } },
      create: { orgId: app.orgId, applicationId: app.id, customerId, ...patch, createdBy: ctx.userId, updatedBy: ctx.userId },
      update: { ...patch, updatedBy: ctx.userId },
    });
  }

  /** Хугацаа нэгэнт тодорхойлогдсон бол цалингийн мөр өөрчлөгдөхөд дундажийг ижил хугацаагаар шинэчилнэ (хадгалагдсан дундаж мөрүүдтэй зөрөхгүй). */
  private async refreshAverage(tx: Tx, app: LoanApplication, customerId: string, ctx: RequestContext): Promise<void> {
    const summary = await tx.incomeSummary.findUnique({ where: { applicationId_customerId: { applicationId: app.id, customerId } } });
    if (!summary?.periodFrom || !summary.periodTo) return;
    const salaries = await tx.incomeSalary.findMany({ where: { applicationId: app.id, customerId }, select: { year: true, month: true, salary: true } });
    const calc = averageMonthlySalary(salaries.map((s) => ({ year: s.year, month: s.month, salary: s.salary.toNumber() })), dateToYearMonth(summary.periodFrom), dateToYearMonth(summary.periodTo));
    await this.upsertSummary(tx, app, customerId, ctx, { avgSalaryMonthly: calc.average });
  }

  private async build(db: Tx, app: LoanApplication): Promise<IncomeOverviewResponse> {
    const participants = await this.participants(db, app.id);
    const ids = participants.map((p) => p.customerId);
    const [salaries, manual, summaries, stepRow] = await Promise.all([
      db.incomeSalary.findMany({ where: { applicationId: app.id, customerId: { in: ids } }, orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'asc' }] }),
      db.incomeManual.findMany({ where: { applicationId: app.id, customerId: { in: ids } }, orderBy: { createdAt: 'asc' } }),
      db.incomeSummary.findMany({ where: { applicationId: app.id, customerId: { in: ids } } }),
      db.loanApplicationStep.findFirst({ where: { applicationId: app.id, stepKey: 'income' }, select: { status: true, staleReason: true } }),
    ]);
    const borrowers: IncomeBorrowerView[] = participants.map((p) => {
      const mySalaries = salaries.filter((s) => s.customerId === p.customerId);
      const myManual = manual.filter((m) => m.customerId === p.customerId);
      const row = summaries.find((s) => s.customerId === p.customerId);
      const summary = summaryView(
        row ? { periodFrom: row.periodFrom, periodTo: row.periodTo, avgSalaryMonthly: num(row.avgSalaryMonthly), businessNcfMonthly: num(row.businessNcfMonthly), householdExpenseMonthly: num(row.householdExpenseMonthly), businessExpenseMonthly: num(row.businessExpenseMonthly) } : null,
        mySalaries.map((s) => ({ year: s.year, month: s.month, salary: s.salary.toNumber() })),
      );
      const manualTotal = Math.round(myManual.reduce((s, m) => s + m.monthlyAmount.toNumber(), 0) * 100) / 100;
      return {
        customerId: p.customerId, role: p.role, included: p.included, displayName: p.displayName,
        salaries: mySalaries.map((s) => ({ id: s.id, employer: s.employer, year: s.year, month: s.month, salary: s.salary.toNumber(), contributionPaid: num(s.contributionPaid), source: s.source as 'NDSH' | 'MANUAL' })),
        manual: myManual.map((m) => ({ id: m.id, type: m.type as ManualIncomeType, monthlyAmount: m.monthlyAmount.toNumber(), fileId: m.fileId, note: m.note })),
        manualMonthlyTotal: manualTotal, summary, hasIncome: hasIncome(summary, manualTotal),
        business: { available: false, message: BSA_INACTIVE_MESSAGE },
      };
    });
    const blockers = incomeBlockers(participants, new Map(borrowers.map((b) => [b.customerId, b])));
    return { borrowers, blockers, step: { status: stepRow?.status ?? null, reason: stepRow?.staleReason ?? null } };
  }
}
