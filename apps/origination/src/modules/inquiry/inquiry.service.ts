import { Inject, Injectable } from '@nestjs/common';
import {
  INQUIRY_BORROWER_ROLES, type InquiriesResponse, type InquiryFetchBody, type RequestContext, type UnregisteredLoan, type UnregisteredLoanInput,
} from '@los/contracts';
import { recordAudit } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { LoanApplication } from '.prisma/client-origination';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { DomainEvents } from '../../shared/domain-events';
import { OrgSettings } from '../../shared/org-settings';
import { applyStepUpdates, loadSteps, planScoreStale, planStepTarget } from '../../shared/step-updates';
import { BlacklistChecker } from '../borrower/blacklist-checker';
import { isEditableStatus } from '../borrower/borrower.rules';
import { customerDisplayName, customerRegisterNo, customerRegisterNoMasked } from '../borrower/customer-directory';
import { buildBorrowerView, inquiryStepTarget, type Participant } from './inquiry.rules';
import { KYC_INQUIRY_PORT, type KycInquiryPort } from './ports/kyc-inquiry.port';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };
const NOT_EDITABLE = 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л лавлагаа татна';

type Failure = InquiriesResponse['failures'][number];

/**
 * FR-3 · Лавлагаа (wizard-ийн 2-р алхам). Лавлагааны өгөгдөл `kyc.inquiry`-д (kyc эзэмшинэ); энд: эрх, оролцогч (client алхам), хар жагсаалтын тулгалт,
 * хуучралт (`inquiry.stale_days`), `inquiry` алхмын төлөв, `score` алхмыг STALE болгох. Гадны дуудлага (kyc) DB-ийн транзакцаас ГАДНА.
 * Регистрийг зөвхөн kyc руу дамжуулна; лог/аудитад бичихгүй.
 */
@Injectable()
export class InquiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly settings: OrgSettings,
    private readonly clock: Clock,
    private readonly events: DomainEvents,
    private readonly blacklist: BlacklistChecker,
    @Inject(KYC_INQUIRY_PORT) private readonly kyc: KycInquiryPort,
  ) {}

  async list(ctx: RequestContext, applicationId: string): Promise<InquiriesResponse> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const snap = await this.snapshot(ctx, app);
    const step = await this.prisma.loanApplicationStep.findFirst({ where: { applicationId: app.id, stepKey: 'inquiry' }, select: { status: true, staleReason: true } });
    return this.respond(snap.views, snap.staleDays, step ? { status: step.status, reason: step.staleReason } : { status: null, reason: null }, []);
  }

  /** FR-3.1–3.4: нэг (эсвэл бүх) оролцогчийн лавлагааг татна. */
  async fetch(ctx: RequestContext, applicationId: string, body: InquiryFetchBody): Promise<InquiriesResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    const all = await this.participants(this.prisma, app.id);
    const targets = body.customerId ? all.filter((p) => p.view.customerId === body.customerId) : all;
    if (body.customerId && !targets.length) throw new DomainError('INQUIRY_BORROWER_NOT_FOUND', 'Энэ харилцагч хүсэлтийн лавлагаа авах оролцогч биш байна', 404);
    const staleDays = await this.staleDays(app.orgId);
    const hits = await this.blacklist.findHits(this.prisma, app.orgId, targets.map((t) => t.customer));

    const failures: Failure[] = [];
    const thrown: unknown[] = [];
    const completed: string[] = [];
    await Promise.all(targets.map(async (t) => {
      const customerHits = hits.filter((h) => h.customerId === t.view.customerId);
      try {
        const res = await this.kyc.fetch(ctx, {
          applicationId: app.id, customerId: t.view.customerId, registerNo: customerRegisterNo(t.customer), staleDays, sources: body.sources,
          blacklist: { hit: customerHits.length > 0, reasons: customerHits.map((h) => ({ reasonCode: h.reasonCode, listType: h.listType })) },
        });
        for (const f of res.failures) failures.push({ customerId: t.view.customerId, source: f.source, code: f.code, message: f.message });
        if (!res.failures.length) completed.push(t.view.customerId);
      } catch (e) {
        thrown.push(e);
        const err = e instanceof DomainError ? { code: e.code, message: e.message } : { code: 'KYC_UNAVAILABLE', message: 'Лавлагааны сервис хариу өгсөнгүй' };
        failures.push({ customerId: t.view.customerId, source: null, code: err.code, message: err.message });
      }
    }));
    // Бүх оролцогчийн дуудлага шидсэн бол (жишээ нь бодит холболтгүй 501) тодорхой алдааг шууд буцаана.
    if (targets.length && thrown.length === targets.length) throw thrown[0];

    const done = await this.afterChange(ctx, app, { scoreAffected: true, action: 'INQUIRY_FETCHED', after: { customerIds: targets.map((t) => t.view.customerId), sources: body.sources ?? 'ALL', failed: failures.length } });
    // KycCompleted: бүх эх сурвалж амжилттай татагдсан оролцогч бүрт (хар жагсаалтын анхааруулгатай эсэх).
    if (completed.length) await this.publishKycCompleted(ctx, app, completed, hits);
    return this.respond(done.views, done.staleDays, done.step, failures);
  }

  /** Алхмыг одоогийн хуучралтаар дахин тооцно (өөрчлөлтгүй, дахин татахгүй). */
  async recheck(ctx: RequestContext, applicationId: string): Promise<InquiriesResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    const done = await this.afterChange(ctx, app, { scoreAffected: false });
    return this.respond(done.views, done.staleDays, done.step, []);
  }

  /** FR-3.2 · ЗМС-д бүртгэлгүй зээлийг гараар. */
  async addUnregisteredLoan(ctx: RequestContext, applicationId: string, customerId: string, input: UnregisteredLoanInput): Promise<UnregisteredLoan> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    const all = await this.participants(this.prisma, app.id);
    if (!all.some((p) => p.view.customerId === customerId)) throw new DomainError('INQUIRY_BORROWER_NOT_FOUND', 'Энэ харилцагч хүсэлтийн лавлагаа авах оролцогч биш байна', 404);
    const loan = await this.kyc.addUnregisteredLoan(ctx, { ...input, applicationId: app.id, customerId });
    await this.afterChange(ctx, app, { scoreAffected: true, action: 'UNREGISTERED_LOAN_ADDED', after: { loanId: loan.id, customerId, monthlyPayment: loan.monthlyPayment } });
    return loan;
  }

  async removeUnregisteredLoan(ctx: RequestContext, applicationId: string, loanId: string): Promise<void> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.assertEditable(app);
    await this.kyc.removeUnregisteredLoan(ctx, app.id, loanId);
    await this.afterChange(ctx, app, { scoreAffected: true, action: 'UNREGISTERED_LOAN_REMOVED', after: { loanId } });
  }

  // ── дотоод ───────────────────────────────────────────────────────────────────────────
  private assertEditable(app: Pick<LoanApplication, 'status'>): void {
    if (!isEditableStatus(app.status)) throw new DomainError('APPLICATION_NOT_EDITABLE', NOT_EDITABLE, 409, { status: app.status });
  }

  private async staleDays(orgId: string): Promise<number> {
    const v = Number(await this.settings.get(orgId, 'inquiry.stale_days'));
    return Number.isInteger(v) && v > 0 ? v : 30;
  }

  /** Лавлагаа авах оролцогчид (PRIMARY, CO_BORROWER, GUARANTOR) — харилцагчийн хамт. Барьцаалагчаас лавлагаа авахгүй. */
  private async participants(db: Tx, applicationId: string) {
    const rows = await db.loanApplicationBorrower.findMany({ where: { applicationId, role: { in: [...INQUIRY_BORROWER_ROLES] } }, include: { customer: true } });
    const order = new Map<string, number>(INQUIRY_BORROWER_ROLES.map((r, i) => [r, i]));
    const seen = new Set<string>();
    return rows
      .sort((a, b) => (order.get(a.role) ?? 9) - (order.get(b.role) ?? 9) || a.createdAt.getTime() - b.createdAt.getTime())
      .filter((r) => (seen.has(r.customerId) ? false : (seen.add(r.customerId), true)))
      .map((r) => ({
        customer: r.customer,
        view: { customerId: r.customerId, role: r.role as Participant['role'], displayName: customerDisplayName(r.customer), registerNoMasked: customerRegisterNoMasked(r.customer) } satisfies Participant,
      }));
  }

  /** kyc-ийн хамгийн сүүлийн лавлагаа + оролцогч + хуучралтаар оролцогч бүрийн төлөв. */
  private async snapshot(ctx: RequestContext, app: LoanApplication) {
    const staleDays = await this.staleDays(app.orgId);
    const participants = await this.participants(this.prisma, app.id);
    const listing = await this.kyc.list(ctx, app.id);
    const now = this.clock.now();
    return { staleDays, now, views: participants.map((p) => buildBorrowerView(p.view, listing.items, listing.unregisteredLoans, staleDays, now)) };
  }

  /** Бичилтийн дараа: kyc-ээс хамгийн сүүлийн төлөв → алхам шинэчлэх + аудит (нэг транзакц). */
  private async afterChange(ctx: RequestContext, app: LoanApplication, o: { scoreAffected: boolean; action?: string; after?: unknown }) {
    const { staleDays, now, views } = await this.snapshot(ctx, app);
    const target = inquiryStepTarget(views);
    const step = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM origination.loan_application WHERE id = ${app.id} AND org_id = ${ctx.orgId} FOR UPDATE`;
      if (!locked.length) throw new DomainError('APPLICATION_NOT_FOUND', 'Хүсэлт олдсонгүй', 404);
      const current = await tx.loanApplication.findUniqueOrThrow({ where: { id: app.id }, select: { status: true } });
      this.assertEditable(current);
      const steps = await loadSteps(tx, app.id);
      const updates = [...planStepTarget(steps, 'inquiry', target, now), ...(o.scoreAffected ? planScoreStale(steps, 'INQUIRY_CHANGED') : [])];
      await applyStepUpdates(tx, updates, ctx.userId);
      if (o.action) await recordAudit(tx, { orgId: ctx.orgId, entity: 'INQUIRY', entityId: app.id, action: o.action, actorId: ctx.userId, beforeJson: null, afterJson: (o.after ?? null) as never, applicationId: app.id, correlationId: ctx.correlationId });
      const after = await tx.loanApplicationStep.findFirst({ where: { applicationId: app.id, stepKey: 'inquiry' }, select: { status: true, staleReason: true } });
      return after ? { status: after.status, reason: after.staleReason } : { status: null, reason: null };
    }, TX_OPTIONS);
    return { views, staleDays, step };
  }

  private async publishKycCompleted(ctx: RequestContext, app: LoanApplication, customerIds: string[], hits: Array<{ customerId: string }>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const customerId of customerIds) await this.events.publish(tx, { type: 'KycCompleted', applicationId: app.id, customerId, blacklisted: hits.some((h) => h.customerId === customerId) }, ctx);
    }, TX_OPTIONS);
  }

  private respond(borrowers: InquiriesResponse['borrowers'], staleDays: number, step: InquiriesResponse['step'], failures: Failure[]): InquiriesResponse {
    return { staleDays, borrowers, complete: borrowers.length > 0 && borrowers.every((v) => v.complete), step, failures };
  }
}
