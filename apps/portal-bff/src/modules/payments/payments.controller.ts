import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  PortalCreatePayment,
  PortalId,
  type PortalPayment,
  type PortalPaymentList,
  PortalPaymentListQuery,
  type PortalPaymentOptions,
} from '@los/contracts';
import type { Response } from 'express';
import type { CallContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { RateLimit } from '../../security/rate-limit.decorator';
import { CallCtx } from '../auth/call-context.decorator';
import { PaymentsService } from './payments.service';

const idPipe = new ZodPipe(PortalId);

@Controller('portal')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('loans/:loanId/payment-options')
  options(@CallCtx() ctx: CallContext, @Param('loanId', idPipe) loanId: string): Promise<PortalPaymentOptions> {
    return this.payments.options(ctx, loanId);
  }

  /**
   * Төлбөр эхлүүлэх → провайдерын нэхэмжлэх (QR / deeplink). `Idempotency-Key` толгой заавал.
   * Давтан илгээсэн хүсэлтэд `Idempotent-Replayed: true`.
   */
  @Post('loans/:loanId/payments')
  @HttpCode(201)
  @RateLimit({ customer: { limit: 10, windowSec: 60 } })
  async create(
    @CallCtx() ctx: CallContext,
    @Param('loanId', idPipe) loanId: string,
    @Body(new ZodPipe(PortalCreatePayment)) body: PortalCreatePayment,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalPayment> {
    const { payment, replayed } = await this.payments.create(ctx, loanId, body, idempotencyKey);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return payment;
  }

  @Get('loans/:loanId/payments')
  list(
    @CallCtx() ctx: CallContext,
    @Param('loanId', idPipe) loanId: string,
    @Query(new ZodPipe(PortalPaymentListQuery)) query: PortalPaymentListQuery,
  ): Promise<PortalPaymentList> {
    return this.payments.list(ctx, loanId, query);
  }

  /** Төлбөрийн төлөв: PENDING → PAID / FAILED / EXPIRED. Клиент 2–3 секунд тутам асууж болно. */
  @Get('payments/:paymentId')
  @RateLimit({ customer: { limit: 120, windowSec: 60 } })
  get(@CallCtx() ctx: CallContext, @Param('paymentId', idPipe) paymentId: string): Promise<PortalPayment> {
    return this.payments.get(ctx, paymentId);
  }
}
