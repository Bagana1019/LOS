import { PortalLoanBalance, PortalLoanDetail, PortalLoanSummary, PortalSchedule } from '@los/contracts';
import { z } from 'zod';
import type { CallContext } from '../../common/request-context';
import { InternalHttpClient, seg } from '../internal-http.client';
import type { LoanServicingPort } from './loan-servicing.port';

const BASE = '/api/internal/portal/loans';

/** origination `/api/internal/portal/loans/*` — харилцагчаар хязгаарлагдсан зээлийн уншилт. */
export class RealLoanServicing implements LoanServicingPort {
  constructor(private readonly http: InternalHttpClient) {}

  listLoans(ctx: CallContext) {
    return this.http.json({ method: 'GET', path: BASE, ctx, schema: z.array(PortalLoanSummary) });
  }
  getLoan(ctx: CallContext, loanId: string) {
    return this.http.json({ method: 'GET', path: `${BASE}/${seg(loanId)}`, ctx, schema: PortalLoanDetail, notFound: 'LOAN_NOT_FOUND' });
  }
  getBalance(ctx: CallContext, loanId: string) {
    return this.http.json({ method: 'GET', path: `${BASE}/${seg(loanId)}/balance`, ctx, schema: PortalLoanBalance, notFound: 'LOAN_NOT_FOUND' });
  }
  getSchedule(ctx: CallContext, loanId: string) {
    return this.http.json({ method: 'GET', path: `${BASE}/${seg(loanId)}/schedule`, ctx, schema: PortalSchedule, notFound: 'LOAN_NOT_FOUND' });
  }
}
