import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { AuditLogQuery, ContractNumberTemplateBody, ReplaceApprovalLevelsBody, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { AdminService } from './admin.service';

/** M13 · Админ. Gateway-д `settings:manage` / `audit:read` (route-policy); энд давхар `@Permissions`. */
@Controller()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Permissions('settings:manage') @Get('approval-levels')
  levels(@Ctx() ctx: RequestContext) { return this.admin.listLevels(ctx); }

  @Permissions('settings:manage') @Put('approval-levels')
  replaceLevels(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ReplaceApprovalLevelsBody)) body: ReplaceApprovalLevelsBody) { return this.admin.replaceLevels(ctx, body); }

  @Permissions('settings:manage') @Get('contract-number-template')
  template(@Ctx() ctx: RequestContext) { return this.admin.getTemplate(ctx); }

  @Permissions('settings:manage') @Put('contract-number-template')
  putTemplate(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ContractNumberTemplateBody)) body: ContractNumberTemplateBody) { return this.admin.putTemplate(ctx, body); }

  @Permissions('audit:read') @Get('audit-logs')
  audit(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AuditLogQuery)) q: AuditLogQuery) { return this.admin.audit(ctx, q); }
}
