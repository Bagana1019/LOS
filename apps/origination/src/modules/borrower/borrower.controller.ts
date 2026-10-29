import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { AddBorrowerRequest, BorrowerCandidatesQuery, RecordConsentRequest, UpdateBorrowerRequest } from '@los/contracts';
import { Ctx } from '@los/nest-common';
import type { RequestContext } from '@los/contracts';
import { Roles } from '@los/nest-common';
import { ZodValidationPipe } from '@los/nest-common';
import { BorrowerService } from './borrower.service';

// docs/01 §3: ЗЭЗ зөвхөн өөрийн хүсэлтэд (бичих), салбарын захирал/батлагч унших; эрхийн хүрээг ApplicationAccessService шалгана.
const READERS = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'];
const WRITERS = ['OFFICER', 'ADMIN'];

@Controller()
export class BorrowerController {
  constructor(private readonly borrowers: BorrowerService) {}

  @Get('applications/:applicationId/borrowers')
  @Roles(...READERS)
  list(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.borrowers.list(ctx, applicationId);
  }

  @Get('applications/:applicationId/borrowers/candidates')
  @Roles(...WRITERS)
  candidates(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Query(new ZodValidationPipe(BorrowerCandidatesQuery)) query: BorrowerCandidatesQuery) {
    return this.borrowers.candidates(ctx, applicationId, query.registerNo);
  }

  @Post('applications/:applicationId/borrowers')
  @Roles(...WRITERS)
  @HttpCode(201)
  add(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(AddBorrowerRequest)) body: AddBorrowerRequest) {
    return this.borrowers.add(ctx, applicationId, body);
  }

  @Patch('applications/:applicationId/borrowers/:borrowerId')
  @Roles(...WRITERS)
  update(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('borrowerId') borrowerId: string, @Body(new ZodValidationPipe(UpdateBorrowerRequest)) body: UpdateBorrowerRequest) {
    return this.borrowers.update(ctx, applicationId, borrowerId, body);
  }

  @Delete('applications/:applicationId/borrowers/:borrowerId')
  @Roles(...WRITERS)
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('borrowerId') borrowerId: string): Promise<void> {
    await this.borrowers.remove(ctx, applicationId, borrowerId);
  }

  @Post('applications/:applicationId/borrowers/:borrowerId/make-primary')
  @Roles(...WRITERS)
  @HttpCode(200)
  makePrimary(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('borrowerId') borrowerId: string) {
    return this.borrowers.makePrimary(ctx, applicationId, borrowerId);
  }

  @Post('applications/:applicationId/borrowers/:borrowerId/consent')
  @Roles(...WRITERS)
  @HttpCode(200)
  consent(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('borrowerId') borrowerId: string, @Body(new ZodValidationPipe(RecordConsentRequest)) body: RecordConsentRequest) {
    return this.borrowers.recordConsent(ctx, applicationId, borrowerId, body);
  }
}
