import { Inject, Injectable } from '@nestjs/common';
import type { PortalLoanBalance, PortalLoanDetail, PortalLoanSummary, PortalSchedule } from '@los/contracts';
import type { CallContext } from '../../common/request-context';
import { LOAN_SERVICING, type LoanServicingPort } from '../../integrations/loan-servicing/loan-servicing.port';
import { LoanOwnershipService, ensureSameLoan } from './loan-ownership.service';

@Injectable()
export class LoansService {
  constructor(
    @Inject(LOAN_SERVICING) private readonly loans: LoanServicingPort,
    private readonly ownership: LoanOwnershipService,
  ) {}

  async list(ctx: CallContext): Promise<PortalLoanSummary[]> {
    const loans = await this.loans.listLoans(ctx);
    await this.ownership.remember(ctx.customerId, loans.map((l) => l.loanId));
    return loans;
  }

  async detail(ctx: CallContext, loanId: string): Promise<PortalLoanDetail> {
    await this.ownership.assertOwned(ctx, loanId);
    const loan = await this.loans.getLoan(ctx, loanId);
    ensureSameLoan(loanId, loan.loanId);
    return loan;
  }

  async balance(ctx: CallContext, loanId: string): Promise<PortalLoanBalance> {
    await this.ownership.assertOwned(ctx, loanId);
    const balance = await this.loans.getBalance(ctx, loanId);
    ensureSameLoan(loanId, balance.loanId);
    return balance;
  }

  async schedule(ctx: CallContext, loanId: string): Promise<PortalSchedule> {
    await this.ownership.assertOwned(ctx, loanId);
    const schedule = await this.loans.getSchedule(ctx, loanId);
    ensureSameLoan(loanId, schedule.loanId);
    return schedule;
  }
}
