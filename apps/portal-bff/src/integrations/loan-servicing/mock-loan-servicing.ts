import type { CallContext } from '../../common/request-context';
import type { MockLedger } from '../mock/mock-ledger';
import type { LoanServicingPort } from './loan-servicing.port';

export class MockLoanServicing implements LoanServicingPort {
  constructor(private readonly ledger: MockLedger) {}

  async listLoans(ctx: CallContext) {
    return this.ledger.listLoans(ctx.customerId);
  }
  async getLoan(ctx: CallContext, loanId: string) {
    return this.ledger.getLoan(ctx.customerId, loanId);
  }
  async getBalance(ctx: CallContext, loanId: string) {
    return this.ledger.getBalance(ctx.customerId, loanId);
  }
  async getSchedule(ctx: CallContext, loanId: string) {
    return this.ledger.getSchedule(ctx.customerId, loanId);
  }
}
