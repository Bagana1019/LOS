import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseFilters } from '@nestjs/common';
import { z } from 'zod';
import {
  ApproveChangeRequest, CancelChangeRequest, ListChangeRequestsQuery, MakerCheckerPolicy, RejectChangeRequest, SubmitChangeRequest,
} from '@los/contracts';
import { CurrentActor, type Actor } from './actor';
import { MakerCheckerExceptionFilter } from './maker-checker.filter';
import { MakerCheckerService } from './maker-checker.service';
import { ZodPipe } from './zod.pipe';

const Id = new ZodPipe(z.string().uuid());
const PolicyParams = z.object({ targetType: MakerCheckerPolicy.shape.targetType, action: MakerCheckerPolicy.shape.action });
const PolicyBody = MakerCheckerPolicy.omit({ targetType: true, action: true }).extend({ reason: z.string().trim().min(3).max(2000) });

interface StatusRes { status(code: number): unknown }

/** Gateway `/api/maker-checker/*`-ийг origination руу дамжуулна. Хэрэглэгч: X-User-Id, X-Roles, X-Branch-Id, X-Org-Id, X-Correlation-Id. */
@Controller('maker-checker')
@UseFilters(MakerCheckerExceptionFilter)
export class MakerCheckerController {
  constructor(@Inject(MakerCheckerService) private readonly svc: MakerCheckerService) {}

  /** 202 — checker хүлээж байна; 201 — policy идэвхгүй тул шууд хэрэгжиж аудитлагдсан */
  @Post('requests')
  async submit(@CurrentActor() actor: Actor, @Body(new ZodPipe(SubmitChangeRequest)) body: SubmitChangeRequest, @Res({ passthrough: true }) res: StatusRes) {
    const result = await this.svc.submit(actor, body);
    res.status(result.outcome === 'PENDING' ? 202 : 201);
    return result;
  }

  @Get('requests')
  list(@CurrentActor() actor: Actor, @Query(new ZodPipe(ListChangeRequestsQuery)) query: ListChangeRequestsQuery) { return this.svc.list(actor, query); }

  @Get('requests/summary')
  summary(@CurrentActor() actor: Actor) { return this.svc.summary(actor); }

  @Get('requests/:id')
  get(@CurrentActor() actor: Actor, @Param('id', Id) id: string) { return this.svc.get(actor, id); }

  @Post('requests/:id/approve')
  @HttpCode(200)
  approve(@CurrentActor() actor: Actor, @Param('id', Id) id: string, @Body(new ZodPipe(ApproveChangeRequest)) body: ApproveChangeRequest) {
    return this.svc.approve(actor, id, body.comment);
  }

  @Post('requests/:id/reject')
  @HttpCode(200)
  reject(@CurrentActor() actor: Actor, @Param('id', Id) id: string, @Body(new ZodPipe(RejectChangeRequest)) body: RejectChangeRequest) {
    return this.svc.reject(actor, id, body.comment);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentActor() actor: Actor, @Param('id', Id) id: string, @Body(new ZodPipe(CancelChangeRequest)) body: CancelChangeRequest) {
    return this.svc.cancel(actor, id, body.comment);
  }

  @Get('policies')
  policies(@CurrentActor() actor: Actor) { return this.svc.listPolicies(actor); }

  /** Policy өөрчлөх нь өөрөө 4 нүдтэй хүсэлт (MC-BR-8) → 202 */
  @Put('policies/:targetType/:action')
  async changePolicy(
    @CurrentActor() actor: Actor, @Param(new ZodPipe(PolicyParams)) params: z.infer<typeof PolicyParams>,
    @Body(new ZodPipe(PolicyBody)) body: z.infer<typeof PolicyBody>, @Res({ passthrough: true }) res: StatusRes,
  ) {
    const { reason, ...rest } = body;
    const result = await this.svc.submitPolicyChange(actor, { ...params, ...rest }, reason);
    res.status(202);
    return result;
  }
}
