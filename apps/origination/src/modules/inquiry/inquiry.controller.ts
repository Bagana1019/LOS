import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { InquiryFetchBody, UnregisteredLoanInput, type RequestContext } from '@los/contracts';
import { Ctx, Roles, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { InquiryService } from './inquiry.service';

// docs/01 §3: унших — ЗЭЗ (өөрийн), салбарын захирал (салбар), батлагч, админ; бичих — ЗЭЗ (өөрийн хүсэлт), админ. Хүрээг ApplicationAccessService шалгана.
const READERS = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'];
const WRITERS = ['OFFICER', 'ADMIN'];
const base = 'applications/:applicationId/inquiries';
const AddLoanBody = UnregisteredLoanInput.extend({ customerId: z.string().trim().min(1).max(64) });

@Controller()
export class InquiryController {
  constructor(private readonly inquiries: InquiryService) {}

  @Get(base)
  @Roles(...READERS)
  list(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.inquiries.list(ctx, applicationId);
  }

  @Post(`${base}/fetch`)
  @Roles(...WRITERS)
  @HttpCode(200)
  fetch(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(InquiryFetchBody)) body: InquiryFetchBody) {
    return this.inquiries.fetch(ctx, applicationId, body);
  }

  @Post(`${base}/recheck`)
  @Roles(...WRITERS)
  @HttpCode(200)
  recheck(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.inquiries.recheck(ctx, applicationId);
  }

  @Post(`${base}/unregistered-loans`)
  @Roles(...WRITERS)
  @HttpCode(201)
  addLoan(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(AddLoanBody)) body: z.infer<typeof AddLoanBody>) {
    const { customerId, ...loan } = body;
    return this.inquiries.addUnregisteredLoan(ctx, applicationId, customerId, loan);
  }

  @Delete(`${base}/unregistered-loans/:loanId`)
  @Roles(...WRITERS)
  @HttpCode(204)
  async removeLoan(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('loanId') loanId: string): Promise<void> {
    await this.inquiries.removeUnregisteredLoan(ctx, applicationId, loanId);
  }
}
