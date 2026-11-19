import { Injectable } from '@nestjs/common';
import { ulaanbaatarDate } from '@los/calc';
import {
  PortalId, PortalLoanBalance, PortalLoanDetail, PortalLoanSummary, PortalSchedule, RepaymentType, type PortalCurrency, type RequestContext,
} from '@los/contracts';
import { Clock } from '@los/nest-common';
import type { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { todayUB } from '../../shared/clock';
import { buildLedger, type Ledger, type LedgerRow } from './portal-ledger';
import { portalError } from './portal-errors';

/** Харилцагчид харагдах зээлийн төлөв (docs/05 §6): ACTIVE + CLOSED; MIGRATED (эхний үлдэгдлээр шилжүүлсэн) → ACTIVE. */
export const PORTAL_VISIBLE_STATUSES = ['ACTIVE', 'CLOSED', 'MIGRATED'];

const LOAN_INCLUDE = { product: { select: { name: true } }, contract: { select: { generatedFileId: true, signedFileId: true } } } satisfies Prisma.LoanApplicationInclude;
export type PortalLoan = Prisma.LoanApplicationGetPayload<{ include: typeof LOAN_INCLUDE }>;

const num = (d: { toString(): string } | number | null | undefined) => (d == null ? 0 : Number(d));
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

interface LoanState { loan: PortalLoan; ledger: Ledger; repaymentType: (typeof RepaymentType)[number]; firstPaymentDate: string | null }

/**
 * PRT-FR-2/3 · PRT-NFR-1 (BOLA): зээл бүрийг `X-Customer-Id`-ийн PRIMARY зээлдэгч + байгууллага + харагдах төлвөөр НЭГ query-д шүүнэ.
 * Харьяалахгүй / байхгүй / ноорог — бүгд ижил 404 LOAN_NOT_FOUND (байгаа эсэхийг задруулахгүй).
 */
@Injectable()
export class PortalLoansService {
  constructor(private readonly prisma: PrismaService, private readonly clock: Clock) {}

  ownedFilter(ctx: RequestContext): Prisma.LoanApplicationWhereInput {
    return { orgId: ctx.orgId, status: { in: PORTAL_VISIBLE_STATUSES }, borrowers: { some: { customerId: ctx.customerId ?? '\u0000', role: 'PRIMARY' } } };
  }

  async owned(ctx: RequestContext, loanId: string): Promise<PortalLoan> {
    if (!ctx.customerId) throw portalError.loanNotFound();
    if (!PortalId.safeParse(loanId).success) throw portalError.invalid('loanId буруу');
    const loan = await this.prisma.loanApplication.findFirst({ where: { id: loanId, ...this.ownedFilter(ctx) }, include: LOAN_INCLUDE });
    if (!loan) throw portalError.loanNotFound();
    return loan;
  }

  async list(ctx: RequestContext): Promise<PortalLoanSummary[]> {
    if (!ctx.customerId) return [];
    const loans = await this.prisma.loanApplication.findMany({ where: this.ownedFilter(ctx), include: LOAN_INCLUDE, orderBy: [{ disbursedAt: 'desc' }, { createdAt: 'desc' }], take: 100 });
    const states = await Promise.all(loans.map((l) => this.stateOf(l)));
    return states.map((s) => PortalLoanSummary.parse(this.summary(s)));
  }

  async detail(ctx: RequestContext, loanId: string): Promise<PortalLoanDetail> {
    const s = await this.stateOf(await this.owned(ctx, loanId));
    return PortalLoanDetail.parse({
      ...this.summary(s), repaymentType: s.repaymentType, firstPaymentDate: s.firstPaymentDate,
      contractAvailable: !!(s.loan.contract?.signedFileId || s.loan.contract?.generatedFileId),
    });
  }

  async balance(ctx: RequestContext, loanId: string): Promise<PortalLoanBalance> {
    const s = await this.stateOf(await this.owned(ctx, loanId));
    return PortalLoanBalance.parse({
      loanId: s.loan.id, currency: currencyOf(s.loan), asOf: this.clock.now().toISOString(),
      outstandingPrincipal: s.ledger.outstandingPrincipal, accruedInterest: s.ledger.accruedInterest, accruedPenalty: s.ledger.accruedPenalty,
      overdue: s.ledger.overdue, nextInstallment: s.ledger.nextInstallment, payoff: s.ledger.payoff,
    });
  }

  async schedule(ctx: RequestContext, loanId: string): Promise<PortalSchedule> {
    const loan = await this.owned(ctx, loanId);
    const { ledger, generatedAt } = await this.load(loan);
    return PortalSchedule.parse({ loanId: loan.id, currency: currencyOf(loan), generatedAt: (generatedAt ?? this.clock.now()).toISOString(), rows: ledger.rows, totals: ledger.totals });
  }

  /** Төлбөр үүсгэх/сонголтод: эзэмшил шалгасан зээлийн одоогийн тооцоо. */
  async ledgerFor(loan: PortalLoan): Promise<Ledger> {
    return (await this.load(loan)).ledger;
  }

  private summary(s: LoanState): PortalLoanSummary {
    const { loan, ledger } = s;
    return {
      loanId: loan.id, contractNo: loan.contractNo ?? loan.appNo, productName: loan.product?.name ?? 'Зээл', currency: currencyOf(loan),
      status: loan.status === 'CLOSED' ? 'CLOSED' : 'ACTIVE', principalAmount: num(loan.amount), annualInterestRatePercent: num(loan.interestRate),
      termMonths: loan.termMonths && loan.termMonths > 0 ? loan.termMonths : Math.max(1, ledger.rows.length),
      disbursedAt: loan.disbursedAt ? ulaanbaatarDate(loan.disbursedAt) : null, maturityDate: ledger.maturityDate,
      outstandingPrincipal: ledger.outstandingPrincipal, overdueAmount: ledger.overdue.total, overdueDays: ledger.overdue.days, nextInstallment: ledger.nextInstallment,
    };
  }

  private async stateOf(loan: PortalLoan): Promise<LoanState> {
    const { ledger, params } = await this.load(loan);
    const type = RepaymentType.find((t) => t === params.type) ?? 'ANNUITY';
    return { loan, ledger, repaymentType: type, firstPaymentDate: ledger.rows[0]?.dueDate ?? null };
  }

  /** Одоогийн ЭТХ (stale биш, хамгийн сүүлийн) + мөр бүрийн allocation нийлбэр, сүүлийн төлөлтийн огноо (UB). */
  private async load(loan: PortalLoan): Promise<{ ledger: Ledger; generatedAt: Date | null; params: { type?: unknown } }> {
    const schedule = await this.prisma.repaymentSchedule.findFirst({
      where: { applicationId: loan.id, isStale: false }, orderBy: [{ generatedAt: 'desc' }, { createdAt: 'desc' }],
      include: { rows: { orderBy: { seq: 'asc' }, include: { allocations: { select: { interestPaid: true, principalPaid: true, payment: { select: { paidAt: true } } } } } } },
    });
    const rows: LedgerRow[] = (schedule?.rows ?? [])
      .filter((r) => r.seq > 0 && num(r.principal) + num(r.interest) > 0) // олголтын мөр төлбөр биш
      .map((r) => {
        const last = r.allocations.reduce<Date | null>((m, a) => (!m || a.payment.paidAt > m ? a.payment.paidAt : m), null);
        return {
          seq: r.seq, dueDate: dateOnly(r.dueDate), days: Math.max(0, r.days), principal: num(r.principal), interest: num(r.interest), total: num(r.total), balance: num(r.balance),
          paidPrincipal: r.allocations.reduce((s, a) => s + num(a.principalPaid), 0), paidInterest: r.allocations.reduce((s, a) => s + num(a.interestPaid), 0),
          paidAt: last ? ulaanbaatarDate(last) : null,
        };
      });
    const params = (schedule?.paramsJson ?? {}) as { type?: unknown };
    return { ledger: buildLedger(rows, todayUB(this.clock), { closed: loan.status === 'CLOSED' }), generatedAt: schedule?.generatedAt ?? null, params };
  }
}

export function currencyOf(loan: Pick<PortalLoan, 'currency'>): PortalCurrency {
  return loan.currency === 'USD' ? 'USD' : 'MNT';
}
