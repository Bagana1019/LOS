import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { VoteRequest, type RequestContext } from '@los/contracts';
import { Ctx, Roles, ZodValidationPipe } from '@los/nest-common';
import { ApprovalService } from './approval.service';

// FR-10.3: батлагч зөвхөн Батлах / Буцаах — нөхцөл засах endpoint байхгүй. Түвшний гишүүнчлэлийг ApprovalService шалгана.
const READERS = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'];
const VOTERS = ['BRANCH_MANAGER', 'APPROVER', 'ADMIN'];

@Controller()
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get('applications/:applicationId/decision')
  @Roles(...READERS)
  decision(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.approvals.decisionView(ctx, applicationId);
  }

  @Post('applications/:applicationId/approval/vote')
  @Roles(...VOTERS)
  @HttpCode(200)
  vote(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(VoteRequest)) body: VoteRequest) {
    return this.approvals.vote(ctx, applicationId, body);
  }

  @Get('approvals/mine')
  @Roles(...VOTERS)
  mine(@Ctx() ctx: RequestContext) {
    return this.approvals.myApprovals(ctx);
  }

  @Post('approvals/sla-sweep')
  @Roles('ADMIN')
  @HttpCode(200)
  async sweep(@Ctx() ctx: RequestContext) {
    return { notified: await this.approvals.sweepSla(ctx.orgId) };
  }
}
