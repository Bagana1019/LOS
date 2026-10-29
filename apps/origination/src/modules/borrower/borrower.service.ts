import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AddBorrowerRequest, BorrowerCandidate, BorrowerListResponse, BorrowerMutationResponse, BorrowerRole, CustomerType, RecordConsentRequest, UpdateBorrowerRequest } from '@los/contracts';
import type { LoanApplication, Prisma } from '.prisma/client-origination';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { Clock } from '@los/nest-common';
import { DomainEvents } from '../../shared/domain-events';
import { PrismaService, Tx } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import { SETTING_REGISTRY } from '@los/contracts';
import { OrgSettings } from '../../shared/org-settings';
import { BlacklistChecker } from './blacklist-checker';
import { sortBorrowers, toBorrowerView, toCandidate, toRow, type BorrowerWithCustomer } from './borrower.mapper';
import {
  checkRemovable, checkRoleFields, computeSummary, computeWarnings, isEditableStatus, isViolation, normalizeAdd, planMakePrimary, planStepUpdates, planUpdate, validateAdd,
  type Limits, type Violation,
} from './borrower.rules';
import { CustomerDirectory } from './customer-directory';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };
/** Гарын үсгийн огноо ирээдүйд байх нь цагийн зөрүүгээс болж байж болох тул нэмэлт зөвшөөрөл. */
const CONSENT_CLOCK_SKEW_MS = 5 * 60_000;

type Change = 'ADDED' | 'UPDATED' | 'REMOVED' | 'PRIMARY_CHANGED';

const fail = (v: Violation): never => {
  const body = { code: v.code, message: v.message, ...(v.details ? { details: v.details } : {}) };
  throw v.status === 409 ? new ConflictException(body) : new UnprocessableEntityException(body);
};
const throwIf = (v: Violation | null): void => { if (v) fail(v); };

/**
 * FR-2.1: хүсэлтийн оролцогчид (үндсэн / хамтран / батлан даагч / барьцаалагч).
 * Мутаци бүр: эрх (write) → нэг транзакц { хүсэлтийн мөрийг FOR UPDATE-ээр түгжих → төлөв/дүрэм шалгах → бичих → алхам шинэчлэх → BorrowersChanged outbox }.
 */
@Injectable()
export class BorrowerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly settings: OrgSettings,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
    private readonly directory: CustomerDirectory,
    private readonly blacklist: BlacklistChecker,
  ) {}

  // ── унших ──────────────────────────────────────────────────────────────────────────
  async list(ctx: RequestContext, applicationId: string): Promise<BorrowerListResponse> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const limits = await this.limits(app.orgId);
    const raw = await this.loadRows(this.prisma, app.id);
    return this.buildList(this.prisma, app, raw, limits);
  }

  /** Регистрээр байгаа харилцагч хайх. Олдохгүй бол [] (харилцагч бүртгэх нь Модуль 1). */
  async candidates(ctx: RequestContext, applicationId: string, registerNo: string): Promise<BorrowerCandidate[]> {
    const app = await this.access.load(ctx, applicationId, 'write');
    const customer = await this.directory.findByRegisterNo(this.prisma, app.orgId, registerNo);
    if (!customer) return [];
    const linked = await this.prisma.loanApplicationBorrower.findMany({ where: { applicationId: app.id, customerId: customer.id }, select: { role: true } });
    return [toCandidate(customer, linked.map((l) => l.role as BorrowerRole))];
  }

  // ── нэмэх ──────────────────────────────────────────────────────────────────────────
  async add(ctx: RequestContext, applicationId: string, input: AddBorrowerRequest): Promise<BorrowerMutationResponse> {
    await this.access.load(ctx, applicationId, 'write');
    const limits = await this.limits(ctx.orgId);
    return this.prisma.$transaction(async (tx) => {
      const { app, raw } = await this.begin(tx, ctx, applicationId);
      const fields = normalizeAdd(input);
      throwIf(checkRoleFields(input.role, fields));
      const customer = await this.directory.findById(tx, ctx.orgId, input.customerId);
      if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Харилцагч олдсонгүй' });
      throwIf(validateAdd({ role: input.role, customerId: customer.id, customerType: customer.customerType as CustomerType, fields, existing: raw.map(toRow), limits }));

      const created = await tx.loanApplicationBorrower.create({
        data: {
          orgId: app.orgId, applicationId: app.id, customerId: customer.id, role: input.role, isPrimary: input.role === 'PRIMARY', ...fields,
          createdBy: ctx.userId, updatedBy: ctx.userId,
        },
      });
      await this.afterChange(tx, ctx, app, { change: 'ADDED', customerId: customer.id, role: input.role }, { borrowerAdded: true, compositionChanged: input.role === 'PRIMARY' || input.role === 'CO_BORROWER' });
      return this.respond(tx, app, created.id, limits);
    }, TX_OPTIONS);
  }

  // ── засах ──────────────────────────────────────────────────────────────────────────
  async update(ctx: RequestContext, applicationId: string, borrowerId: string, patch: UpdateBorrowerRequest): Promise<BorrowerMutationResponse> {
    await this.access.load(ctx, applicationId, 'write');
    const limits = await this.limits(ctx.orgId);
    return this.prisma.$transaction(async (tx) => {
      const { app, raw } = await this.begin(tx, ctx, applicationId);
      const target = this.findTarget(raw, borrowerId);
      const plan = planUpdate(toRow(target), patch, raw.filter((r) => r.id !== target.id).map(toRow));
      if (isViolation(plan)) return fail(plan);
      if (plan.changed.length) {
        const data: Prisma.LoanApplicationBorrowerUncheckedUpdateInput = { updatedBy: ctx.userId };
        for (const k of plan.changed) (data as Record<string, unknown>)[k] = plan.next[k];
        await tx.loanApplicationBorrower.update({ where: { id: target.id }, data });
        await this.afterChange(tx, ctx, app, { change: 'UPDATED', customerId: target.customerId, role: target.role as BorrowerRole }, { borrowerAdded: false, compositionChanged: plan.compositionChanged });
      }
      return this.respond(tx, app, target.id, limits);
    }, TX_OPTIONS);
  }

  // ── устгах ─────────────────────────────────────────────────────────────────────────
  async remove(ctx: RequestContext, applicationId: string, borrowerId: string): Promise<void> {
    await this.access.load(ctx, applicationId, 'write');
    await this.prisma.$transaction(async (tx) => {
      const { app, raw } = await this.begin(tx, ctx, applicationId);
      const target = this.findTarget(raw, borrowerId);
      // (10) Барьцаа хөрөнгийн өмчлөгч барьцаалагчийг хасахгүй.
      const ownsCollateral = target.role === 'PLEDGOR' && !!(await tx.collateral.findFirst({ where: { applicationId: app.id, ownerCustomerId: target.customerId }, select: { id: true } }));
      throwIf(checkRemovable(toRow(target), raw.map(toRow), ownsCollateral));
      await tx.loanApplicationBorrower.delete({ where: { id: target.id } });
      await this.afterChange(tx, ctx, app, { change: 'REMOVED', customerId: target.customerId, role: target.role as BorrowerRole }, { borrowerAdded: false, compositionChanged: target.role === 'PRIMARY' || target.role === 'CO_BORROWER' });
    }, TX_OPTIONS);
  }

  // ── үндсэн зээлдэгч солих ────────────────────────────────────────────────────────────
  async makePrimary(ctx: RequestContext, applicationId: string, borrowerId: string): Promise<BorrowerMutationResponse> {
    await this.access.load(ctx, applicationId, 'write');
    const limits = await this.limits(ctx.orgId);
    return this.prisma.$transaction(async (tx) => {
      const { app, raw } = await this.begin(tx, ctx, applicationId);
      const target = this.findTarget(raw, borrowerId);
      const plan = planMakePrimary(raw.map(toRow), target.id);
      if (isViolation(plan)) return fail(plan);
      if (!plan.noop) {
        if (plan.demote) await tx.loanApplicationBorrower.update({ where: { id: plan.demote.id }, data: { role: 'CO_BORROWER', isPrimary: false, liabilityShare: plan.demote.liabilityShare, relationToPrimary: null, updatedBy: ctx.userId } });
        await tx.loanApplicationBorrower.update({ where: { id: target.id }, data: { role: 'PRIMARY', isPrimary: true, liabilityShare: null, relationToPrimary: null, updatedBy: ctx.userId } });
        await this.afterChange(tx, ctx, app, { change: 'PRIMARY_CHANGED', customerId: target.customerId, role: 'PRIMARY' }, { borrowerAdded: false, compositionChanged: true });
      }
      return this.respond(tx, app, target.id, limits);
    }, TX_OPTIONS);
  }

  // ── зөвшөөрөл ──────────────────────────────────────────────────────────────────────
  async recordConsent(ctx: RequestContext, applicationId: string, borrowerId: string, input: RecordConsentRequest): Promise<BorrowerMutationResponse> {
    await this.access.load(ctx, applicationId, 'write');
    const limits = await this.limits(ctx.orgId);
    const signedAt = new Date(input.signedAt);
    return this.prisma.$transaction(async (tx) => {
      const { app, raw } = await this.begin(tx, ctx, applicationId);
      const target = this.findTarget(raw, borrowerId);
      if (signedAt.getTime() > this.clock.now().getTime() + CONSENT_CLOCK_SKEW_MS)
        fail({ status: 422, code: 'CONSENT_SIGNED_IN_FUTURE', message: 'Зөвшөөрөлд гарын үсэг зурсан огноо ирээдүйд байж болохгүй' });
      const same = target.consentFileId === input.fileId && target.consentSignedAt?.getTime() === signedAt.getTime();
      if (!same) {
        await tx.loanApplicationBorrower.update({ where: { id: target.id }, data: { consentFileId: input.fileId, consentSignedAt: signedAt, updatedBy: ctx.userId } });
        await this.afterChange(tx, ctx, app, { change: 'UPDATED', customerId: target.customerId, role: target.role as BorrowerRole }, { borrowerAdded: false, compositionChanged: false });
      }
      return this.respond(tx, app, target.id, limits);
    }, TX_OPTIONS);
  }

  // ── дотоод туслахууд ────────────────────────────────────────────────────────────────
  private async limits(orgId: string): Promise<Limits> {
    const read = async (key: 'borrower.max_co_borrowers' | 'borrower.max_guarantors'): Promise<number> => {
      const v = Number(await this.settings.get(orgId, key));
      return Number.isInteger(v) && v >= 0 ? v : SETTING_REGISTRY[key].default as number;
    };
    return { maxCoBorrowers: await read('borrower.max_co_borrowers'), maxGuarantors: await read('borrower.max_guarantors') };
  }

  private loadRows(db: Tx, applicationId: string): Promise<BorrowerWithCustomer[]> {
    return db.loanApplicationBorrower.findMany({ where: { applicationId }, include: { customer: true } }).then(sortBorrowers);
  }

  /** (9) Хүсэлтийн мөрийг түгжиж сериалчилна; түгжээ авсны дараа төлөвийг дахин уншина (READ COMMITTED). (1) Зөвхөн DRAFT/RETURNED. */
  private async begin(tx: Tx, ctx: RequestContext, applicationId: string): Promise<{ app: LoanApplication; raw: BorrowerWithCustomer[] }> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM origination.loan_application WHERE id = ${applicationId} AND org_id = ${ctx.orgId} FOR UPDATE`;
    if (!locked.length) throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: 'Хүсэлт олдсонгүй' });
    const app = await tx.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });
    if (!isEditableStatus(app.status))
      throw new ConflictException({ code: 'APPLICATION_NOT_EDITABLE', message: 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л оролцогчийг өөрчилнө', details: { status: app.status } });
    return { app, raw: await this.loadRows(tx, applicationId) };
  }

  private findTarget(raw: BorrowerWithCustomer[], borrowerId: string): BorrowerWithCustomer {
    const target = raw.find((r) => r.id === borrowerId);
    if (!target) throw new NotFoundException({ code: 'BORROWER_NOT_FOUND', message: 'Оролцогч олдсонгүй' });
    return target;
  }

  /** (8) Алхмын төлөв шинэчлэх + BorrowersChanged event — бизнес өөрчлөлттэй нэг транзакцид (CLAUDE.md §3.2.4). */
  private async afterChange(tx: Tx, ctx: RequestContext, app: LoanApplication, ev: { change: Change; customerId: string; role: BorrowerRole }, flags: { borrowerAdded: boolean; compositionChanged: boolean }): Promise<void> {
    const rows = (await this.loadRows(tx, app.id)).map(toRow);
    const steps = await tx.loanApplicationStep.findMany({ where: { applicationId: app.id }, select: { id: true, stepKey: true, status: true, staleReason: true } });
    const updates = planStepUpdates(steps, { hasPrimary: rows.some((r) => r.role === 'PRIMARY'), ...flags }, this.clock.now());
    for (const u of updates) {
      await tx.loanApplicationStep.updateMany({
        where: { id: u.id, status: { not: 'LOCKED' } },
        data: { status: u.status, staleReason: u.staleReason, ...(u.completedAt !== undefined ? { completedAt: u.completedAt } : {}) },
      });
    }
    await this.events.publish(tx, {
      type: 'BorrowersChanged', applicationId: app.id, change: ev.change, customerId: ev.customerId, role: ev.role,
      borrowers: rows.map((r) => ({ customerId: r.customerId, role: r.role, incomeIncluded: r.incomeIncluded })),
    }, ctx);
  }

  private async buildList(db: Tx, app: LoanApplication, raw: BorrowerWithCustomer[], limits: Limits): Promise<BorrowerListResponse> {
    const rows = raw.map(toRow);
    const loanAmount = app.amount == null ? null : Number(app.amount);
    const hits = await this.blacklist.findHits(db, app.orgId, raw.map((r) => r.customer));
    return {
      items: raw.map(toBorrowerView),
      summary: computeSummary({ rows, loanAmount, limits, status: app.status }),
      warnings: computeWarnings({ rows, loanAmount, hits }),
    };
  }

  private async respond(tx: Tx, app: LoanApplication, borrowerId: string, limits: Limits): Promise<BorrowerMutationResponse> {
    const raw = await this.loadRows(tx, app.id);
    const list = await this.buildList(tx, app, raw, limits);
    const borrower = list.items.find((i) => i.id === borrowerId);
    if (!borrower) throw new NotFoundException({ code: 'BORROWER_NOT_FOUND', message: 'Оролцогч олдсонгүй' });
    return { borrower, summary: list.summary, warnings: list.warnings };
  }
}
