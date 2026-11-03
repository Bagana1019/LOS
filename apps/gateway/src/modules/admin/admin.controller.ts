import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import { AssignUserBranchBody, AuditLogQuery, hasPermission, type Permission, type SessionUser } from '@los/contracts';
import { ZodValidationPipe, contextOf } from '@los/nest-common';
import { AdminService } from './admin.service';

type Req_ = { user?: SessionUser; headers: Record<string, string | string[] | undefined>; ip?: string };

/** `/api/admin/*` — gateway-ийн өөрийн (iam) админ API. Эрх: users → `user:manage`, audit → `audit:read`. */
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  private actor(req: Req_, need: Permission): SessionUser {
    const u = req.user;
    if (!u || !hasPermission(u.roles, need)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' });
    return u;
  }

  @Get('branches') branches(@Req() req: Req_) { return this.admin.branches(this.actor(req, 'user:manage').orgId); }
  @Get('users') users(@Req() req: Req_) { return this.admin.users(this.actor(req, 'user:manage').orgId); }

  @Put('users/:id/branch')
  assign(@Req() req: Req_, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(AssignUserBranchBody)) body: AssignUserBranchBody) {
    const u = this.actor(req, 'user:manage');
    return this.admin.assignBranch(u.orgId, u.id, id, body.branchId, { correlationId: contextOf(req as never).correlationId ?? null, ip: req.ip ?? null });
  }

  @Get('audit-logs')
  audit(@Req() req: Req_, @Query(new ZodValidationPipe(AuditLogQuery)) q: AuditLogQuery) { return this.admin.audit(this.actor(req, 'audit:read').orgId, q); }
}
