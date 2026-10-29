import { Controller, Get, Param } from '@nestjs/common';
import { PortalId, type PortalLoanBalance, type PortalLoanDetail, type PortalLoanSummary, type PortalSchedule } from '@los/contracts';
import type { CallContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { CallCtx } from '../auth/call-context.decorator';
import { LoansService } from './loans.service';

const loanIdPipe = new ZodPipe(PortalId);

@Controller('portal/loans')
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  /** Миний зээлүүд (идэвхтэй, хаагдсан): үлдэгдэл, дараагийн төлөлт, хугацаа хэтэрсэн дүн. */
  @Get()
  list(@CallCtx() ctx: CallContext): Promise<PortalLoanSummary[]> {
    return this.loans.list(ctx);
  }

  @Get(':loanId')
  detail(@CallCtx() ctx: CallContext, @Param('loanId', loanIdPipe) loanId: string): Promise<PortalLoanDetail> {
    return this.loans.detail(ctx, loanId);
  }

  /** Зээлийн үлдэгдэл: үндсэн, хүү, хугацаа хэтэрсэн, өнөөдөр бүрэн хаах дүн. */
  @Get(':loanId/balance')
  balance(@CallCtx() ctx: CallContext, @Param('loanId', loanIdPipe) loanId: string): Promise<PortalLoanBalance> {
    return this.loans.balance(ctx, loanId);
  }

  /** Эргэн төлөлтийн хуваарь (FR-7.2 баганууд) + мөр бүрийн төлөв. */
  @Get(':loanId/schedule')
  schedule(@CallCtx() ctx: CallContext, @Param('loanId', loanIdPipe) loanId: string): Promise<PortalSchedule> {
    return this.loans.schedule(ctx, loanId);
  }
}
