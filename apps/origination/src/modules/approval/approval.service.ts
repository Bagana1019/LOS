import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  type ApprovalDecision, type ApprovalTimelineLevel, type DecisionView, type MyApprovalListResponse, type RequestContext, type StepKey, type VoteRequest,
} from '@los/contracts';
import { recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { LoanApplication, Prisma } from '.prisma/client-origination';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { DomainEvents } from '../../shared/domain-events';
import { OrgSettings } from '../../shared/org-settings';
import { ApplicationStateMachine } from '../application/application-state-machine';
import { CollateralGateService } from '../collateral/collateral-gate.service';
import { missingRequiredSteps } from '../application/application.rules';
import { customerDisplayName, customerRegisterNoMasked } from '../borrower/customer-directory';
import { NotificationService } from '../notification/notification.service';
import { dueAt, evaluateLevel, isLevelMember, isOverdue, requiredVotes, selectLevels, type LevelLike } from './approval.rules';
import { ContractNumberService } from './contract-number.service';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

type LevelRow = Prisma.ApprovalLevelGetPayload<{ include: { members: true } }>;
type RequestRow = Prisma.ApprovalRequestGetPayload<{ include: { votes: true } }>;
const asLike = (l: LevelRow): LevelLike & LevelRow => ({ ...l, amountFrom: Number(l.amountFrom), amountTo: l.amountTo == null ? null : Number(l.amountTo) } as never);
const num = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));

/**
 * Модуль 10 — шийдвэр ба батлах урсгал (FR-10, BR-7, BR-8, BR-13, G1–G3). Төлвийн бүх шилжилт `ApplicationStateMachine.apply` (SYSTEM)-ээр.
 * Нэг хүсэлтийн хувилбар (version) тутамд түвшин бүрт `approval_request`: идэвхтэй түвшин `due_at`-тэй, дараагийнх нь `due_at = null` (хүлээгдэж буй).
 */
@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly machine: ApplicationStateMachine,
    private readonly events: DomainEvents,
    private readonly settings: OrgSettings,
    private readonly notifications: NotificationService,
    private readonly contractNumbers: ContractNumberService,
    private readonly clock: Clock,
    private readonly collateralGate: CollateralGateService,
  ) {}

  // ── эхлүүлэх: SUBMITTED → IN_APPROVAL (илгээсэн tx дотор дуудагдана) ─────────────────────────────
  async start(tx: Tx, ctx: RequestContext, applicationId: string): Promise<void> {
    const app = await this.machine.lock(tx, ctx.orgId, applicationId);
    if (app.status !== 'SUBMITTED') return;
    const now = this.clock.now();
    const pool = await this.levelPool(tx, app);
    const levels = selectLevels(pool.map(asLike), Number(app.amount), app.productId);
    if (!levels.length) throw new DomainError('APPROVAL_LEVELS_NOT_CONFIGURED', 'Батлах түвшин тохируулаагүй байна (Тохиргоо → Батлах урсгал)', 422);
    const empty = levels.find((l) => !pool.find((p) => p.id === l.id)?.members.length);
    if (empty) throw new DomainError('APPROVAL_LEVEL_WITHOUT_MEMBERS', `"${empty.name}" түвшинд батлагч томилоогүй байна`, 422, { levelNo: empty.levelNo });
    const sla = await this.settings.getIn(tx, ctx.orgId, 'approval.default_sla_hours');
    for (const [i, l] of levels.entries()) {
      await tx.approvalRequest.create({
        data: { orgId: ctx.orgId, applicationId, version: app.version, levelNo: l.levelNo, startedAt: now, dueAt: i === 0 ? dueAt(now, l.slaHours || sla) : null, createdBy: ctx.userId, updatedBy: ctx.userId },
      });
    }
    await this.machine.apply(tx, ctx, applicationId, 'IN_APPROVAL', { via: 'SYSTEM', reason: `Түвшин 1/${levels.length}` });
    await tx.loanApplicationStep.updateMany({ where: { applicationId, stepKey: 'decision', status: { not: 'LOCKED' } }, data: { status: 'COMPLETED', completedAt: now, staleReason: null, updatedBy: ctx.userId } });
    await recordAudit(tx, { orgId: ctx.orgId, entity: 'LOAN_APPLICATION', entityId: applicationId, action: 'APPROVAL_STARTED', actorId: ctx.userId, afterJson: { version: app.version, levels: levels.map((l) => l.levelNo) }, applicationId, correlationId: ctx.correlationId });
    await this.notifyLevel(tx, app, pool.find((p) => p.id === levels[0].id)!);
  }

  // ── санал өгөх (FR-10.2/10.3) ─────────────────────────────────────────────────────────────
  async vote(ctx: RequestContext, applicationId: string, input: VoteRequest): Promise<DecisionView> {
    const userId = ctx.userId;
    if (!userId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Нэвтэрсэн хэрэглэгч шаардлагатай' });
    await this.access.load(ctx, applicationId, 'read');
    await this.prisma.$transaction(async (tx) => {
      const app = await this.machine.lock(tx, ctx.orgId, applicationId);
      if (app.status !== 'IN_APPROVAL') throw new ConflictException({ code: 'NOT_IN_APPROVAL', message: 'Хүсэлт батлах шатанд байхгүй байна' });
      // Батлагч өөрийн хүсэлтийг батлахгүй (BR): хариуцсан ЗЭЗ эсвэл үүсгэгч.
      if (userId === app.officerId || userId === app.createdBy) throw new ForbiddenException({ code: 'SELF_APPROVAL_FORBIDDEN', message: 'Өөрийн хүсэлтийг батлах боломжгүй' });
      const reqs = await tx.approvalRequest.findMany({ where: { applicationId, version: app.version }, include: { votes: true }, orderBy: { levelNo: 'asc' } });
      const active = this.activeOf(reqs);
      if (!active) throw new ConflictException({ code: 'NO_ACTIVE_LEVEL', message: 'Идэвхтэй батлах түвшин олдсонгүй' });
      const level = (await this.levelPool(tx, app)).find((l) => l.levelNo === active.levelNo);
      if (!level || !isLevelMember(level.members, ctx, app.branchId)) throw new ForbiddenException({ code: 'NOT_LEVEL_APPROVER', message: `Та "${level?.name ?? active.levelNo}" түвшний батлагч биш` });
      if (active.votes.some((v) => v.approverId === userId)) throw new ConflictException({ code: 'ALREADY_VOTED', message: 'Та энэ түвшинд санал өгсөн байна' });

      const now = this.clock.now();
      const vote = await tx.approvalVote.create({ data: { orgId: ctx.orgId, approvalRequestId: active.id, approverId: userId, decision: input.decision, comment: input.comment ?? null, decidedAt: now, createdBy: userId, updatedBy: userId } });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'APPROVAL_REQUEST', entityId: active.id, action: 'APPROVAL_VOTE', actorId: userId, afterJson: { levelNo: active.levelNo, decision: input.decision, comment: input.comment ?? null }, applicationId, correlationId: ctx.correlationId });
      const votes = [...active.votes, vote];
      const outcome = evaluateLevel(votes.map((v) => v.decision as ApprovalDecision), level.members.length);
      if (outcome === 'PENDING') return;

      await tx.approvalRequest.update({ where: { id: active.id }, data: { status: outcome, updatedBy: userId } });
      if (outcome === 'RETURNED') return this.returnApplication(tx, ctx, app, active, votes, reqs);
      const next = reqs.find((r) => r.levelNo > active.levelNo && r.status === 'PENDING');
      if (next) {
        const nextLevel = (await this.levelPool(tx, app)).find((l) => l.levelNo === next.levelNo)!;
        const sla = await this.settings.getIn(tx, ctx.orgId, 'approval.default_sla_hours');
        await tx.approvalRequest.update({ where: { id: next.id }, data: { startedAt: now, dueAt: dueAt(now, nextLevel.slaHours || sla), updatedBy: userId } });
        await recordAudit(tx, { orgId: ctx.orgId, entity: 'APPROVAL_REQUEST', entityId: next.id, action: 'APPROVAL_LEVEL_STARTED', actorId: userId, afterJson: { levelNo: next.levelNo }, applicationId, correlationId: ctx.correlationId });
        await this.notifyLevel(tx, app, nextLevel);
        return;
      }
      await this.approveApplication(tx, ctx, app, reqs.length);
    }, TX_OPTIONS);
    return this.decisionView(ctx, applicationId);
  }

  /** BR-8 / G3: бүх түвшин зөвшөөрсөн → гэрээний дугаар (BR-11), APPROVED, 2-р үе шат нээгдэнэ (машин), decision_record. */
  private async approveApplication(tx: Tx, ctx: RequestContext, app: LoanApplication, levelCount: number): Promise<void> {
    const now = this.clock.now();
    const contractNo = await this.contractNumbers.next(tx, ctx.orgId, app.branchId, now);
    await this.machine.apply(tx, ctx, app.id, 'APPROVED', { via: 'SYSTEM', reason: `${levelCount} түвшин зөвшөөрсөн` });
    await tx.loanApplication.update({ where: { id: app.id }, data: { contractNo, decidedAt: now, updatedBy: ctx.userId } });
    const all = await tx.approvalVote.findMany({ where: { request: { applicationId: app.id, version: app.version } }, include: { request: true }, orderBy: [{ decidedAt: 'asc' }] });
    const minutes = all.map((v) => `Түвшин ${v.request.levelNo}: ${v.approverId} — ${v.decision === 'APPROVE' ? 'Батлав' : 'Буцаав'}${v.comment ? ` (${v.comment})` : ''}`).join('\n');
    await tx.decisionRecord.create({ data: { orgId: ctx.orgId, applicationId: app.id, decisionNo: `${app.appNo}/V${app.version}`, decidedAt: now, minutesText: minutes || null, createdBy: ctx.userId, updatedBy: ctx.userId } });
    await recordAudit(tx, { orgId: ctx.orgId, entity: 'LOAN_APPLICATION', entityId: app.id, action: 'APPLICATION_APPROVED', actorId: ctx.userId, afterJson: { contractNo, version: app.version }, applicationId: app.id, correlationId: ctx.correlationId });
    await this.events.publish(tx, { type: 'ApplicationApproved', applicationId: app.id, contractNo }, ctx);
    await this.notifications.notifyUsers({ orgId: ctx.orgId, userIds: [app.officerId], type: 'APPROVED', applicationId: app.id, payload: { applicationNo: app.appNo, contractNo, amount: num(app.amount) } }, tx);
  }

  /** Олонхи RETURN → RETURNED (тайлбар заавал). Хүлээгдэж буй (эхлээгүй) түвшнүүдийг устгана. */
  private async returnApplication(tx: Tx, ctx: RequestContext, app: LoanApplication, active: RequestRow, votes: Array<{ decision: string; comment: string | null }>, reqs: RequestRow[]): Promise<void> {
    const comment = votes.filter((v) => v.decision === 'RETURN' && v.comment).map((v) => v.comment).join(' | ') || 'Буцаасан';
    await tx.approvalRequest.deleteMany({ where: { id: { in: reqs.filter((r) => r.levelNo > active.levelNo && r.status === 'PENDING').map((r) => r.id) } } });
    await this.machine.apply(tx, ctx, app.id, 'RETURNED', { via: 'SYSTEM', reason: comment });
    await tx.loanApplicationStep.updateMany({ where: { applicationId: app.id, stepKey: 'decision', status: { not: 'LOCKED' } }, data: { status: 'PENDING', completedAt: null, updatedBy: ctx.userId } });
    await this.events.publish(tx, { type: 'ApplicationReturned', applicationId: app.id, levelNo: active.levelNo, comment }, ctx);
    await this.notifications.notifyUsers({ orgId: ctx.orgId, userIds: [app.officerId], type: 'RETURNED', applicationId: app.id, payload: { applicationNo: app.appNo, amount: num(app.amount) } }, tx);
  }

  private async notifyLevel(tx: Tx, app: LoanApplication, level: LevelRow): Promise<void> {
    // Дүр + салбараар томилсон гишүүдийг хэрэглэгч болгож шийдэх iam лавлах origination-д байхгүй (DECISIONS) — зөвхөн userId-тайг мэдэгдэнэ.
    await this.notifications.notifyUsers({ orgId: app.orgId, userIds: level.members.map((m) => m.userId), type: 'APPROVAL_REQUESTED', applicationId: app.id, payload: { applicationNo: app.appNo, amount: num(app.amount) } }, tx);
  }

  private activeOf(reqs: RequestRow[]): RequestRow | undefined {
    return reqs.find((r) => r.status === 'PENDING' && r.dueAt != null);
  }

  /** Бүтээгдэхүүний тусгай түвшин байвал тэдгээр, үгүй бол бүх бүтээгдэхүүний (productId = null). */
  private async levelPool(tx: Tx | PrismaService, app: Pick<LoanApplication, 'orgId' | 'productId'>): Promise<LevelRow[]> {
    const all = await tx.approvalLevel.findMany({ where: { orgId: app.orgId, OR: [{ productId: null }, ...(app.productId ? [{ productId: app.productId }] : [])] }, include: { members: true }, orderBy: { levelNo: 'asc' } });
    const specific = app.productId ? all.filter((l) => l.productId === app.productId) : [];
    return specific.length ? specific : all.filter((l) => l.productId == null);
  }

  // ── шийдвэрийн хуудас (FR-10.1, FR-10.2 timeline, FR-10.4, FR-10.5) ─────────────────────────────
  async decisionView(ctx: RequestContext, applicationId: string): Promise<DecisionView> {
    const base = await this.access.load(ctx, applicationId, 'read');
    const app = await this.prisma.loanApplication.findUniqueOrThrow({
      where: { id: base.id },
      include: {
        product: { select: { name: true } }, steps: { select: { stepKey: true, status: true } }, collaterals: { select: { id: true } },
        borrowers: { where: { role: 'PRIMARY' }, include: { customer: true }, take: 1 },
        schedules: { where: { isStale: false }, orderBy: { generatedAt: 'desc' }, take: 1, include: { rows: { orderBy: { seq: 'asc' }, take: 1 } } },
        decisions: { orderBy: { decidedAt: 'desc' }, take: 1 },
      },
    });
    const now = this.clock.now();
    const required = await this.settings.get(ctx.orgId, 'br7.required_steps');
    const missing = missingRequiredSteps(app.steps, required);
    // Барьцааны алхам дутуу бол G0-ийн яг шалтгааныг харуулна (зөвхөн «Алхам дутуу» гэсэн мессеж хангалтгүй).
    const reasons: Record<string, string[]> = {};
    if (missing.includes('collateral')) reasons.collateral = (await this.collateralGate.evaluate(this.prisma, ctx.orgId, base.id)).gate.issues.map((i) => i.message);
    const all = await this.prisma.approvalRequest.findMany({ where: { applicationId }, include: { votes: { orderBy: { decidedAt: 'asc' } } }, orderBy: [{ version: 'asc' }, { levelNo: 'asc' }] });
    const reqs = all.filter((r) => r.version === app.version);
    const pool = await this.levelPool(this.prisma, app);
    const levels: ApprovalTimelineLevel[] = reqs.map((r) => {
      const lvl = pool.find((l) => l.levelNo === r.levelNo);
      const total = lvl?.members.length ?? 0;
      const state = r.status === 'PENDING' ? (r.dueAt ? 'PENDING' : 'WAITING') : (r.status as 'APPROVED' | 'RETURNED');
      return {
        levelNo: r.levelNo, name: lvl?.name ?? `Түвшин ${r.levelNo}`, state, startedAt: r.dueAt || r.status !== 'PENDING' ? r.startedAt.toISOString() : null, dueAt: r.dueAt?.toISOString() ?? null,
        overdue: state === 'PENDING' && isOverdue(r.dueAt, now), quorum: { required: requiredVotes(total), total },
        votes: r.votes.map((v) => ({ approverId: v.approverId, decision: v.decision as ApprovalDecision, comment: v.comment, decidedAt: v.decidedAt.toISOString() })),
      };
    });
    const active = this.activeOf(reqs);
    const activeLevel = active ? pool.find((l) => l.levelNo === active.levelNo) : undefined;
    const canVote = !!(app.status === 'IN_APPROVAL' && active && activeLevel && ctx.userId && ctx.userId !== app.officerId && ctx.userId !== app.createdBy
      && isLevelMember(activeLevel.members, ctx, app.branchId) && !active.votes.some((v) => v.approverId === ctx.userId));
    const primary = app.borrowers[0]?.customer;
    const versionNos = [...new Set(all.map((r) => r.version))];
    const record = app.decisions[0];
    return {
      applicationId: app.id, appNo: app.appNo, status: app.status as DecisionView['status'], version: app.version,
      summary: {
        borrowerName: primary ? customerDisplayName(primary) : null, registerNoMasked: primary ? customerRegisterNoMasked(primary) : null, productName: app.product?.name ?? null, currency: app.currency,
        amount: num(app.amount), termMonths: app.termMonths, interestRate: num(app.interestRate), monthlyPayment: num(app.schedules[0]?.rows[0]?.total ?? null),
        collateralCount: app.collaterals.length, selectedMethod: app.selectedCalcMethod,
      },
      progress: { completed: required.length - missing.length, total: required.length, missing: missing as StepKey[], reasons },
      canSubmit: (app.status === 'DRAFT' || app.status === 'RETURNED') && missing.length === 0 && app.productId != null && app.amount != null, // G1 (FR-10.1)
      approval: { currentLevel: active?.levelNo ?? null, totalLevels: reqs.length, levels },
      versions: versionNos.map((version) => {
        const rs = all.filter((r) => r.version === version);
        const returned = rs.find((r) => r.status === 'RETURNED');
        const outcome = returned ? 'RETURNED' : rs.length && rs.every((r) => r.status === 'APPROVED') ? 'APPROVED' : 'PENDING';
        return { version, outcome, returnedComment: returned?.votes.find((v) => v.decision === 'RETURN' && v.comment)?.comment ?? null } as DecisionView['versions'][number];
      }),
      decisionRecord: record ? { decisionNo: record.decisionNo, decidedAt: record.decidedAt.toISOString(), minutesText: record.minutesText, contractNo: app.contractNo } : null,
      canVote,
    };
  }

  // ── "Миний батлах" таб (FR-10.2) ────────────────────────────────────────────────────────────
  async myApprovals(ctx: RequestContext): Promise<MyApprovalListResponse> {
    if (!ctx.userId) return { items: [], total: 0 };
    const now = this.clock.now();
    const pending = await this.prisma.approvalRequest.findMany({
      where: { orgId: ctx.orgId, status: 'PENDING', dueAt: { not: null }, application: { status: 'IN_APPROVAL', officerId: { not: ctx.userId }, createdBy: { not: ctx.userId } } },
      include: { votes: true, application: { include: { borrowers: { where: { role: 'PRIMARY' }, include: { customer: true }, take: 1 } } } }, orderBy: { dueAt: 'asc' },
    });
    const items: MyApprovalListResponse['items'] = [];
    for (const r of pending) {
      const app = r.application;
      if (r.version !== app.version || r.votes.some((v) => v.approverId === ctx.userId)) continue;
      const pool = await this.levelPool(this.prisma, app);
      const level = pool.find((l) => l.levelNo === r.levelNo);
      if (!level || !isLevelMember(level.members, ctx, app.branchId)) continue;
      const primary = app.borrowers[0]?.customer;
      const totalLevels = await this.prisma.approvalRequest.count({ where: { applicationId: app.id, version: app.version } });
      items.push({ applicationId: app.id, appNo: app.appNo, borrowerName: primary ? customerDisplayName(primary) : null, amount: num(app.amount), currency: app.currency, levelNo: r.levelNo, levelName: level.name, totalLevels, startedAt: r.startedAt.toISOString(), dueAt: r.dueAt?.toISOString() ?? null, overdue: isOverdue(r.dueAt, now) });
    }
    return { items, total: items.length };
  }

  async myApprovalCount(ctx: RequestContext): Promise<number> {
    return (await this.myApprovals(ctx)).total;
  }

  // ── SLA хэтрэлт (FR-10.2): улаан + мэдэгдэл (нэг түвшинд нэг удаа) ─────────────────────────────────
  async sweepSla(orgId?: string): Promise<number> {
    const now = this.clock.now();
    const overdue = await this.prisma.approvalRequest.findMany({
      where: { status: 'PENDING', dueAt: { lt: now }, ...(orgId ? { orgId } : {}), application: { status: 'IN_APPROVAL' } }, include: { application: true }, take: 200,
    });
    let notified = 0;
    for (const r of overdue) {
      const app = r.application;
      if (r.version !== app.version) continue;
      await this.prisma.$transaction(async (tx) => {
        const dup = await tx.auditLog.findFirst({ where: { orgId: r.orgId, entity: 'APPROVAL_REQUEST', entityId: r.id, action: 'APPROVAL_SLA_BREACH' }, select: { id: true } });
        if (dup) return;
        const level = (await this.levelPool(tx, app)).find((l) => l.levelNo === r.levelNo);
        await recordAudit(tx, { orgId: r.orgId, entity: 'APPROVAL_REQUEST', entityId: r.id, action: 'APPROVAL_SLA_BREACH', actorId: null, afterJson: { levelNo: r.levelNo, dueAt: r.dueAt?.toISOString() ?? null }, applicationId: app.id, correlationId: null });
        const voted = new Set((await tx.approvalVote.findMany({ where: { approvalRequestId: r.id }, select: { approverId: true } })).map((v) => v.approverId));
        const targets = [...(level?.members.map((m) => m.userId) ?? []), app.officerId].filter((u): u is string => !!u && !voted.has(u));
        await this.notifications.notifyUsers({ orgId: r.orgId, userIds: targets, type: 'SLA_BREACH', applicationId: app.id, payload: { applicationNo: app.appNo, amount: num(app.amount) } }, tx);
        notified++;
      }, TX_OPTIONS);
    }
    return notified;
  }
}
