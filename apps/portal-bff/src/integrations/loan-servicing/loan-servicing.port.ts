import type { PortalLoanBalance, PortalLoanDetail, PortalLoanSummary, PortalSchedule } from '@los/contracts';
import type { CallContext } from '../../common/request-context';

export const LOAN_SERVICING = Symbol('LOAN_SERVICING');

/**
 * Зээлийн үйлчилгээний уншилт: origination (loan_application ACTIVE/CLOSED, repayment_schedule) +
 * Core (үлдэгдэл, төлөлтийн байдал). Бүх дуудлага `ctx.customerId`-аар хязгаарлагдана; харьяалахгүй зээл → LOAN_NOT_FOUND.
 */
export interface LoanServicingPort {
  listLoans(ctx: CallContext): Promise<PortalLoanSummary[]>;
  getLoan(ctx: CallContext, loanId: string): Promise<PortalLoanDetail>;
  getBalance(ctx: CallContext, loanId: string): Promise<PortalLoanBalance>;
  getSchedule(ctx: CallContext, loanId: string): Promise<PortalSchedule>;
}
