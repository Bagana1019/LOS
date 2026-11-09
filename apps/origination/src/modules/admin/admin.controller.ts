import { Body, Controller, Get, Put, Query, Res } from '@nestjs/common';
import { AuditLogQuery, ContractNumberTemplateBody, ReplaceApprovalLevelsRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { AdminService } from './admin.service';

/** Express.Response-ийн status() л хэрэгтэй */
type StatusRes = { status(code: number): unknown };

/** M13 · Админ. Q-124: `PUT approval-levels` нь 4 нүдний санал үүсгэнэ (202 PENDING / 201 DIRECT). Gateway-д `settings:manage` / `audit:read` (route-policy); энд давхар `@Permissions`. */
@Controller()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Permissions('settings:manage') @Get('approval-levels')
  levels(@Ctx() ctx: RequestContext) { return this.admin.listLevels(ctx); }

  @Permissions('settings:manage') @Put('approval-levels')
  replaceLevels(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ReplaceApprovalLevelsRequest)) body: ReplaceApprovalLevelsRequest, @Res({ passthrough: true }) res: StatusRes) {
    return this.admin.proposeLevels(ctx, body).then((r) => { res.status(r.outcome === 'PENDING' ? 202 : 201); return r; });
  }

  @Permissions('settings:manage') @Get('contract-number-template')
  template(@Ctx() ctx: RequestContext) { return this.admin.getTemplate(ctx); }

  @Permissions('settings:manage') @Put('contract-number-template')
  putTemplate(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ContractNumberTemplateBody)) body: ContractNumberTemplateBody) { return this.admin.putTemplate(ctx, body); }

  @Permissions('audit:read') @Get('audit-logs')
  audit(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AuditLogQuery)) q: AuditLogQuery) { return this.admin.audit(ctx, q); }
}
