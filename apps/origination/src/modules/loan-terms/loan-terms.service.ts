import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  CIB_PURPOSES, type CibPurposesResponse, type LoanProductsResponse, type LoanProductView, type LoanTermsView, type ProductLimits, type RequestContext, type SaveLoanTermsRequest,
} from '@los/contracts';
import { recordAudit } from '@los/database';
import { DomainError } from '@los/nest-common';
import { Prisma, type LoanApplication, type Product } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { ApplicationStateMachine } from '../application/application-state-machine';
import { isEditable } from '../application/application.rules';
import { ScoreService } from '../score/score.service';
import { checkLimits, INSTALLMENT_STEP, LOAN_STEP, planTermsSteps, termsChanged, type TermsCore } from './loan-terms.rules';
import { PricingService } from './pricing/pricing.service';

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };
const num = (d: Prisma.Decimal | null | undefined): number | null => (d == null ? null : Number(d));
const dec = (n: number | null | undefined): Prisma.Decimal | null => (n == null ? null : new Prisma.Decimal(n));

export const limitsOf = (p: Pick<Product, 'minAmount' | 'maxAmount' | 'minTerm' | 'maxTerm' | 'minRate' | 'maxRate' | 'defaultFeeRate'>): ProductLimits => ({
  minAmount: Number(p.minAmount), maxAmount: Number(p.maxAmount), minTermMonths: p.minTerm, maxTermMonths: p.maxTerm,
  minRate: Number(p.minRate), maxRate: Number(p.maxRate), defaultFeeRate: num(p.defaultFeeRate),
});
const coreOf = (a: Pick<LoanApplication, 'productId' | 'currency' | 'amount' | 'termMonths' | 'interestRate' | 'feeRate'>): TermsCore => ({
  productId: a.productId, currency: a.currency, amount: num(a.amount), termMonths: a.termMonths, interestRate: num(a.interestRate), feeRate: num(a.feeRate),
});

/** FR-5 · Зээлийн нөхцөл (4-р алхам `loan`). Хязгаар (BR-6) бүтээгдэхүүнээс; хүү/шимтгэлийн default нь FR-5.5 шатлалаас. */
@Injectable()
export class LoanTermsService {
  private readonly logger = new Logger(LoanTermsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly machine: ApplicationStateMachine,
    private readonly pricing: PricingService,
    private readonly score: ScoreService,
  ) {}

  /** FR-5.1 · идэвхтэй бүтээгдэхүүн + хязгаар (сонгоход UI автоматаар бөглөнө). */
  async products(ctx: RequestContext): Promise<LoanProductsResponse> {
    const rows = await this.prisma.product.findMany({ where: { orgId: ctx.orgId, isActive: true }, orderBy: [{ code: 'asc' }] });
    return { items: rows.map((p): LoanProductView => ({ id: p.id, code: p.code, name: p.name, productType: p.productType, currency: p.currency, requiresCollateral: p.requiresCollateral, limits: limitsOf(p) })) };
  }

  /** FR-5.2 · ЗМС зориулалтын ангилал (DEMO каталог). */
  cibPurposes(): CibPurposesResponse {
    return { items: CIB_PURPOSES.map((p) => ({ code: p.code, name: p.name, subs: p.subs.map((s) => ({ ...s })) })) };
  }

  async get(ctx: RequestContext, applicationId: string): Promise<LoanTermsView> {
    const app = await this.access.load(ctx, applicationId, 'read');
    return this.view(ctx, app);
  }

  async save(ctx: RequestContext, applicationId: string, input: SaveLoanTermsRequest): Promise<LoanTermsView> {
    const before = await this.access.load(ctx, applicationId, 'write');
    if (!isEditable(before.status)) throw new ConflictException({ code: 'APPLICATION_NOT_EDITABLE', message: 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л нөхцөлийг өөрчилнө', details: { status: before.status } });

    const product = await this.prisma.product.findFirst({ where: { id: input.productId, orgId: ctx.orgId, isActive: true } });
    if (!product) throw new DomainError('PRODUCT_NOT_FOUND', 'Бүтээгдэхүүн олдсонгүй эсвэл идэвхгүй', 422);
    const limits = limitsOf(product);

    // Хүү/шимтгэл хоосон бол FR-5.5-ын default шатлалаас (Sosco Score-гүй үеийн санал); шатлал тохируулагдаагүй бол бүтээгдэхүүний доод хүү.
    let interestRate = input.interestRate;
    let feeRate = input.feeRate;
    if (interestRate === undefined || feeRate === undefined) {
      const quote = await this.pricing.quote(ctx, { productId: product.id, soscoScore: null, amount: input.amount }).catch((e: unknown) => {
        if (e instanceof DomainError && e.code === 'PRICING_NOT_CONFIGURED') return null;
        throw e;
      });
      interestRate ??= quote?.interestRate ?? limits.minRate;
      feeRate ??= quote?.feeRate ?? limits.defaultFeeRate ?? 0;
    }

    const violations = checkLimits({ amount: input.amount, termMonths: input.termMonths, interestRate }, limits);
    if (violations.length) throw new DomainError('LOAN_TERMS_OUT_OF_LIMITS', 'Зээлийн нөхцөл бүтээгдэхүүний хязгаараас хэтэрсэн тул хадгалах боломжгүй', 422, { violations, limits });

    const changed = await this.prisma.$transaction(async (tx) => {
      const locked = await this.machine.lock(tx, ctx.orgId, applicationId);
      if (!isEditable(locked.status)) throw new ConflictException({ code: 'APPLICATION_NOT_EDITABLE', message: 'Хүсэлтийн төлөв өөрчлөгдсөн байна', details: { status: locked.status } });
      const next: TermsCore = { productId: product.id, currency: product.currency, amount: input.amount, termMonths: input.termMonths, interestRate, feeRate };
      const isChanged = termsChanged(coreOf(locked), next);
      await tx.loanApplication.update({
        where: { id: applicationId },
        data: {
          productId: product.id, currency: product.currency, amount: dec(input.amount), termMonths: input.termMonths, interestRate: dec(interestRate), feeRate: dec(feeRate),
          downPayment: dec(input.downPayment ?? null), charges: dec(input.charges ?? null), insurance: dec(input.insurance ?? null),
          purpose: input.purpose, purposeDetail: input.purposeDetail ?? null, cibPurposeCode: input.cibPurposeCode ?? null, cibSubCode: input.cibSubCode ?? null,
          officerNote: input.officerNote ?? null, updatedBy: ctx.userId,
        },
      });
      const steps = await tx.loanApplicationStep.findMany({ where: { applicationId }, select: { id: true, stepKey: true, status: true } });
      const now = new Date();
      for (const p of planTermsSteps(steps, isChanged, now)) {
        await tx.loanApplicationStep.update({ where: { id: p.id }, data: { status: p.status, staleReason: p.staleReason, ...(p.completedAt ? { completedAt: p.completedAt } : {}), updatedBy: ctx.userId } });
      }
      // FR-7.3: нөхцөл өөрчлөгдсөн бол ЭТХ хуучирсан (алхам нь COMPLETED биш байсан ч мөр өөрөө).
      if (isChanged) await tx.repaymentSchedule.updateMany({ where: { applicationId, isStale: false }, data: { isStale: true, updatedBy: ctx.userId } });
      await recordAudit(tx, {
        orgId: ctx.orgId, entity: 'LOAN_APPLICATION', entityId: applicationId, action: 'LOAN_TERMS_SAVED', actorId: ctx.userId,
        beforeJson: { ...coreOf(locked) }, afterJson: { ...next, changed: isChanged }, applicationId, correlationId: ctx.correlationId,
      });
      return isChanged;
    }, TX_OPTIONS);

    // FR-7.3: commit-ийн дараа тооцооллыг хуучирсан гэж тэмдэглэнэ (scoring унасан ч нөхцөл хадгалагдсан хэвээр — алхам нь эцсийн эх сурвалж).
    if (changed) await this.markScoreStale(ctx, applicationId);
    return this.get(ctx, applicationId);
  }

  private async markScoreStale(ctx: RequestContext, applicationId: string): Promise<void> {
    try {
      await this.score.markStale(ctx, applicationId, 'Зээлийн нөхцөл өөрчлөгдсөн');
    } catch (e) {
      this.logger.warn({ msg: 'could not mark the calculation stale after loan terms change', applicationId, correlationId: ctx.correlationId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async view(ctx: RequestContext, app: LoanApplication): Promise<LoanTermsView> {
    const [product, steps, canWrite] = await Promise.all([
      app.productId ? this.prisma.product.findFirst({ where: { id: app.productId, orgId: ctx.orgId } }) : null,
      this.prisma.loanApplicationStep.findMany({ where: { applicationId: app.id, stepKey: { in: [LOAN_STEP, INSTALLMENT_STEP] } }, select: { stepKey: true, status: true, staleReason: true } }),
      this.access.can(ctx, app, 'write'),
    ]);
    const stepOf = (key: string) => {
      const s = steps.find((x) => x.stepKey === key);
      return s ? { status: s.status as 'LOCKED' | 'PENDING' | 'COMPLETED' | 'STALE', staleReason: s.staleReason } : null;
    };
    const amount = num(app.amount);
    const feeRate = num(app.feeRate);
    return {
      applicationId: app.id, editable: isEditable(app.status) && canWrite, productId: app.productId, currency: app.currency,
      amount, termMonths: app.termMonths, interestRate: num(app.interestRate), feeRate,
      feeAmount: amount != null && feeRate != null ? Math.round(amount * feeRate * 100) / 100 : null,
      downPayment: num(app.downPayment), charges: num(app.charges), insurance: num(app.insurance),
      purpose: app.purpose, purposeDetail: app.purposeDetail, cibPurposeCode: app.cibPurposeCode, cibSubCode: app.cibSubCode, officerNote: app.officerNote,
      limits: product ? limitsOf(product) : null, step: stepOf(LOAN_STEP), installmentStep: stepOf(INSTALLMENT_STEP),
    };
  }
}
