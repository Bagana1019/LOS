import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  ApplicationStatus, type ApplicationDetail, type ApplicationExportQuery, type ApplicationHistoryResponse, type ApplicationListQuery,
  type ApplicationListResponse, type ApplicationRow, type ApplicationStepView, type CreateApplicationRequest, type RequestContext, type TransitionRequest,
} from '@los/contracts';
import { recordAudit } from '@los/database';
import { DomainError } from '@los/nest-common';
import type { Prisma } from '.prisma/client-origination';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { OrgSettings } from '../../shared/org-settings';
import { hasRole } from '../../shared/roles';
import { customerDisplayName, customerRegisterNoMasked } from '../borrower/customer-directory';
import { APPROVAL_FLOW, type ApprovalFlowPort } from './approval-flow.port';
import { ApplicationStateMachine } from './application-state-machine';
import { canTransition, formatAppNo, initialStepStatus, isEditable, isHttpTransition, isUserTransition, missingRequiredSteps, stage1Progress, stageOf, STEP_ORDER } from './application.rules';
import { resolveApplicationScope } from './application.scope';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };
const EXPORT_LIMIT = 50_000;
const SORT_COLUMN: Record<string, string> = { appNo: 'appNo', createdAt: 'createdAt', amount: 'amount', status: 'status', decidedAt: 'decidedAt' };

const ROW_INCLUDE = {
  product: { select: { name: true } },
  borrowers: { where: { role: 'PRIMARY' }, include: { customer: true }, take: 1 },
  steps: { select: { stepKey: true, status: true } },
} satisfies Prisma.LoanApplicationInclude;
type RowSource = Prisma.LoanApplicationGetPayload<{ include: typeof ROW_INCLUDE }>;

const num = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));

@Injectable()
export class ApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly machine: ApplicationStateMachine,
    private readonly settings: OrgSettings,
    @Optional() @Inject(APPROVAL_FLOW) private readonly approval?: ApprovalFlowPort,
  ) {}

  // ── үүсгэх (FR-1; docs/01 §4 "Шинэ") ───────────────────────────────────────────────────
  async create(ctx: RequestContext, input: CreateApplicationRequest): Promise<ApplicationDetail> {
    if (!hasRole(ctx, 'OFFICER', 'ADMIN') || !ctx.userId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Хүсэлт үүсгэх эрхгүй' });
    // BR-12: хүсэлт бүр салбар + ЗЭЗ-тэй. ЗЭЗ зөвхөн өөрийн салбарт; ADMIN өөр салбар заана.
    const branchId = hasRole(ctx, 'ADMIN') ? input.branchId ?? ctx.branchId : ctx.branchId;
    if (!branchId) throw new DomainError('BRANCH_REQUIRED', 'Салбар тодорхойгүй байна', 422);
    if (input.branchId && input.branchId !== branchId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Зөвхөн өөрийн салбарт хүсэлт үүсгэнэ' });

    const id = await this.prisma.$transaction(async (tx) => {
      let currency: string | undefined;
      if (input.productId) {
        const product = await tx.product.findFirst({ where: { id: input.productId, orgId: ctx.orgId, isActive: true } });
        if (!product) throw new DomainError('PRODUCT_NOT_FOUND', 'Бүтээгдэхүүн олдсонгүй эсвэл идэвхгүй', 422);
        currency = product.currency;
      }
      const year = new Date().getUTCFullYear();
      const appNo = formatAppNo(year, await this.nextSeq(tx, ctx.orgId, year));
      const app = await tx.loanApplication.create({
        data: {
          appNo, orgId: ctx.orgId, branchId, officerId: ctx.userId, status: 'DRAFT', productId: input.productId ?? null, purpose: input.purpose ?? null,
          ...(currency ? { currency } : {}), source: 'WEB', createdBy: ctx.userId, updatedBy: ctx.userId,
        },
      });
      await tx.loanApplicationStep.createMany({
        data: STEP_ORDER.map((stepKey) => ({ orgId: ctx.orgId, applicationId: app.id, stepKey, status: initialStepStatus(stepKey), createdBy: ctx.userId, updatedBy: ctx.userId })),
      });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'LOAN_APPLICATION', entityId: app.id, action: 'APPLICATION_CREATED', actorId: ctx.userId, afterJson: { appNo, branchId, productId: input.productId ?? null, status: 'DRAFT' }, applicationId: app.id, correlationId: ctx.correlationId });
      return app.id;
    }, TX_OPTIONS);
    return this.detail(ctx, id);
  }

  /** Атомик тоолуур: давхцал, амжилтгүй tx-ийн дараа ч ижил дугаар гарахгүй. */
  private async nextSeq(tx: Tx, orgId: string, year: number): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ seq: number }>>`
      INSERT INTO origination.application_sequence (org_id, year, next_seq) VALUES (${orgId}, ${year}, 2)
      ON CONFLICT (org_id, year) DO UPDATE SET next_seq = origination.application_sequence.next_seq + 1
      RETURNING next_seq - 1 AS seq`;
    return Number(rows[0].seq);
  }

  // ── жагсаалт (FR-1.1…1.4) ─────────────────────────────────────────────────────────────
  async list(ctx: RequestContext, query: ApplicationListQuery): Promise<ApplicationListResponse> {
    const scope = resolveApplicationScope(ctx);
    const base = this.scopeWhere(scope);
    const where: Prisma.LoanApplicationWhereInput = { AND: [base, this.filterWhere(scope, query)] };
    const orderBy: Prisma.LoanApplicationOrderByWithRelationInput[] = [{ [SORT_COLUMN[query.sort]]: query.dir }, { id: 'asc' }];
    const [total, rows, grouped] = await Promise.all([
      this.prisma.loanApplication.count({ where }),
      this.prisma.loanApplication.findMany({ where, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: ROW_INCLUDE }),
      this.prisma.loanApplication.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    const required = await this.settings.get(ctx.orgId, 'br7.required_steps');
    const counts = Object.fromEntries(ApplicationStatus.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0])) as ApplicationListResponse['counts'];
    const myApprovalCount = (await this.approval?.myApprovalCount(ctx)) ?? 0; // FR-10.2 "Миний батлах"
    return { items: rows.map((r) => this.toRow(r, required)), total, page: query.page, pageSize: query.pageSize, counts, myApprovalCount };
  }

  private scopeWhere(scope: { orgId: string; branchId: string | null; officerId: string | null }): Prisma.LoanApplicationWhereInput {
    return { orgId: scope.orgId, archivedAt: null, ...(scope.branchId ? { branchId: scope.branchId } : {}), ...(scope.officerId ? { officerId: scope.officerId } : {}) };
  }

  private filterWhere(scope: { branchId: string | null; officerId: string | null }, q: ApplicationExportQuery | ApplicationListQuery): Prisma.LoanApplicationWhereInput {
    const and: Prisma.LoanApplicationWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.q) and.push({ OR: [{ appNo: { contains: q.q, mode: 'insensitive' } }, { contractNo: { contains: q.q, mode: 'insensitive' } }] });
    if (q.branchId && !scope.branchId) and.push({ branchId: q.branchId }); // хүрээ давуу: гаднах салбар заахыг үл тооно
    if (q.officerId && !scope.officerId) and.push({ officerId: q.officerId });
    if (q.productId) and.push({ productId: q.productId });
    if (q.currency) and.push({ currency: q.currency.toUpperCase() });
    if (q.createdFrom) and.push({ createdAt: { gte: new Date(`${q.createdFrom}T00:00:00Z`) } });
    if (q.createdTo) and.push({ createdAt: { lt: new Date(new Date(`${q.createdTo}T00:00:00Z`).getTime() + 86_400_000) } });
    return { AND: and };
  }

  private toRow(r: RowSource, required: readonly string[]): ApplicationRow {
    const primary = r.borrowers[0]?.customer;
    return {
      id: r.id, appNo: r.appNo, branchId: r.branchId, officerId: r.officerId, contractNo: r.contractNo,
      primaryBorrower: primary ? { customerId: primary.id, displayName: customerDisplayName(primary), registerNoMasked: customerRegisterNoMasked(primary) } : null,
      productId: r.productId, productName: r.product?.name ?? null, currency: r.currency, amount: num(r.amount), interestRate: num(r.interestRate), termMonths: r.termMonths,
      decidedAt: r.decidedAt?.toISOString() ?? null, status: r.status as ApplicationStatus,
      stepsDone: r.steps.filter((s) => required.includes(s.stepKey) && s.status === 'COMPLETED').length, stepsRequired: required.length,
      createdAt: r.createdAt.toISOString(),
    };
  }

  // ── Excel (FR-1.3) ───────────────────────────────────────────────────────────────────
  async exportXlsx(ctx: RequestContext, query: ApplicationExportQuery): Promise<{ buffer: Buffer; filename: string }> {
    const scope = resolveApplicationScope(ctx);
    const where: Prisma.LoanApplicationWhereInput = { AND: [this.scopeWhere(scope), this.filterWhere(scope, query)] };
    const rows = await this.prisma.loanApplication.findMany({ where, orderBy: [{ [SORT_COLUMN[query.sort]]: query.dir }, { id: 'asc' }], take: EXPORT_LIMIT, include: ROW_INCLUDE });
    const required = await this.settings.get(ctx.orgId, 'br7.required_steps');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Хүсэлт');
    ws.columns = [
      { header: '№', key: 'appNo', width: 18 }, { header: 'Салбар', key: 'branchId', width: 14 }, { header: 'Хариуцсан ЗЭЗ', key: 'officerId', width: 16 }, { header: 'Гэрээний дугаар', key: 'contractNo', width: 18 },
      { header: 'Харилцагч', key: 'customer', width: 26 }, { header: 'Регистр', key: 'register', width: 14 }, { header: 'Бүтээгдэхүүн', key: 'product', width: 24 }, { header: 'Валют', key: 'currency', width: 8 },
      { header: 'Хэмжээ', key: 'amount', width: 16, style: { numFmt: '#,##0.00' } }, { header: 'Хүү', key: 'rate', width: 8 }, { header: 'Хугацаа', key: 'term', width: 9 },
      { header: 'Шийдвэрлэгдсэн огноо', key: 'decidedAt', width: 20 }, { header: 'Төлөв', key: 'status', width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows.map((x) => this.toRow(x, required))) {
      ws.addRow({
        appNo: r.appNo, branchId: r.branchId, officerId: r.officerId ?? 'Систем', contractNo: r.contractNo, customer: r.primaryBorrower?.displayName, register: r.primaryBorrower?.registerNoMasked,
        product: r.productName, currency: r.currency, amount: r.amount, rate: r.interestRate, term: r.termMonths, decidedAt: r.decidedAt?.slice(0, 10), status: r.status,
      });
    }
    ws.autoFilter = { from: 'A1', to: 'M1' };
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: 'loan-applications.xlsx' };
  }

  // ── дэлгэрэнгүй ──────────────────────────────────────────────────────────────────────
  async detail(ctx: RequestContext, applicationId: string): Promise<ApplicationDetail> {
    const base = await this.access.load(ctx, applicationId, 'read');
    const r = await this.prisma.loanApplication.findUniqueOrThrow({ where: { id: base.id }, include: { ...ROW_INCLUDE, steps: true } });
    const required = await this.settings.get(ctx.orgId, 'br7.required_steps');
    const canWrite = await this.access.can(ctx, r, 'write');
    const steps: ApplicationStepView[] = STEP_ORDER.map((key, i) => {
      const s = r.steps.find((x) => x.stepKey === key);
      return { stepKey: key, stage: stageOf(key), order: i + 1, status: (s?.status ?? 'LOCKED') as ApplicationStepView['status'], required: required.includes(key), completedAt: s?.completedAt?.toISOString() ?? null, staleReason: s?.staleReason ?? null };
    });
    const progress = stage1Progress(r.steps);
    const blockedBy = missingRequiredSteps(r.steps, required);
    const from = r.status as ApplicationStatus;
    const transitions = ApplicationStatus.filter((to) => canTransition(from, to)).map((to) => ({
      to, allowed: canWrite && isHttpTransition(from, to) && isUserTransition(from, to), blockedBy: to === 'SUBMITTED' ? blockedBy : [],
    }));
    return {
      ...this.toRow(r, required), officerNote: r.officerNote, purpose: r.purpose, version: r.version, source: r.source as ApplicationDetail['source'],
      submittedAt: r.submittedAt?.toISOString() ?? null, approvedAt: r.approvedAt?.toISOString() ?? null, returnedAt: r.returnedAt?.toISOString() ?? null,
      steps, stage1Completed: progress.completed, stage1Total: progress.total, editable: isEditable(r.status) && canWrite, transitions,
    };
  }

  // ── шилжилт (AC: DRAFT→APPROVED = 400) ────────────────────────────────────────────────
  async transition(ctx: RequestContext, applicationId: string, input: TransitionRequest): Promise<ApplicationDetail> {
    const app = await this.access.load(ctx, applicationId, 'read');
    if (!canTransition(app.status as ApplicationStatus, input.to)) throw new DomainError('INVALID_TRANSITION', `"${app.status}" төлвөөс "${input.to}" төлөвт шилжих боломжгүй`, 400, { from: app.status, to: input.to });
    if (!isHttpTransition(app.status as ApplicationStatus, input.to)) throw new ForbiddenException({ code: 'TRANSITION_NOT_ALLOWED', message: `"${input.to}" төлөвт шилжилт нь системийн (батлах урсгал, олголт) үйлдэл`, details: { from: app.status, to: input.to } });
    await this.access.load(ctx, applicationId, 'write');
    await this.prisma.$transaction(async (tx) => {
      await this.machine.apply(tx, ctx, applicationId, input.to, { via: 'USER', reason: input.reason });
      if (input.to === 'SUBMITTED') await this.approval?.start(tx, ctx, applicationId); // FR-10: илгээмэгц эхний түвшин нээгдэнэ (IN_APPROVAL)
    }, TX_OPTIONS);
    return this.detail(ctx, applicationId);
  }

  async history(ctx: RequestContext, applicationId: string): Promise<ApplicationHistoryResponse> {
    await this.access.load(ctx, applicationId, 'read');
    const rows = await this.prisma.auditLog.findMany({ where: { orgId: ctx.orgId, applicationId, entity: 'LOAN_APPLICATION', action: { in: ['APPLICATION_CREATED', 'STATUS_CHANGED'] } }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    return {
      items: rows.map((r) => {
        const after = (r.afterJson ?? {}) as { status?: string; reason?: string | null };
        const before = (r.beforeJson ?? null) as { status?: string } | null;
        return { at: r.at.toISOString(), actorId: r.actorId, from: before?.status ?? null, to: after.status ?? 'DRAFT', reason: after.reason ?? null };
      }),
    };
  }
}

