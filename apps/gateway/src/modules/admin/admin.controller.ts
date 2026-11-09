import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { AssignUserBranchBody, AuditLogQuery, CreateBranchBody, CreateUserBody, UpdateBranchBody, UpdateUserBody, hasPermission, type Permission, type SessionUser } from '@los/contracts';
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

  private meta(req: Req_) { return { correlationId: contextOf(req as never).correlationId ?? null, ip: req.ip ?? null }; }

  // FR-13 · Салбар
  @Post('branches') @HttpCode(201)
  createBranch(@Req() req: Req_, @Body(new ZodValidationPipe(CreateBranchBody)) body: CreateBranchBody) { const u = this.actor(req, 'user:manage'); return this.admin.createBranch(u.orgId, u.id, body, this.meta(req)); }
  @Put('branches/:id')
  updateBranch(@Req() req: Req_, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(UpdateBranchBody)) body: UpdateBranchBody) { const u = this.actor(req, 'user:manage'); return this.admin.updateBranch(u.orgId, u.id, id, body, this.meta(req)); }
  @Post('branches/:id/deactivate') @HttpCode(200)
  deactivateBranch(@Req() req: Req_, @Param('id', new ParseUUIDPipe()) id: string) { const u = this.actor(req, 'user:manage'); return this.admin.setBranchActive(u.orgId, u.id, id, false, this.meta(req)); }
  @Post('branches/:id/reactivate') @HttpCode(200)
  reactivateBranch(@Req() req: Req_, @Param('id', new ParseUUIDPipe()) id: string) { const u = this.actor(req, 'user:manage'); return this.admin.setBranchActive(u.orgId, u.id, id, true, this.meta(req)); }

  // FR-13 · Хэрэглэгч
  @Post('users') @HttpCode(201)
  createUser(@Req() req: Req_, @Body(new ZodValidationPipe(CreateUserBody)) body: CreateUserBody) { const u = this.actor(req, 'user:manage'); return this.admin.createUser(u.orgId, u.id, body, this.meta(req)); }
  @Put('users/:id')
  updateUser(@Req() req: Req_, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(UpdateUserBody)) body: UpdateUserBody) { const u = this.actor(req, 'user:manage'); return this.admin.updateUser(u.orgId, u.id, id, body, this.meta(req)); }
  @Post('users/:id/deactivate') @HttpCode(200)
  deactivateUser(@Req() req: Req_, @Param('id', new ParseUUIDPipe()) id: string) { const u = this.actor(req, 'user:manage'); return this.admin.setUserActive(u.orgId, u.id, id, false, this.meta(req)); }
  @Post('users/:id/reactivate') @HttpCode(200)
  reactivateUser(@Req() req: Req_, @Param('id', new ParseUUIDPipe()) id: string) { const u = this.actor(req, 'user:manage'); return this.admin.setUserActive(u.orgId, u.id, id, true, this.meta(req)); }
  @Post('users/:id/reset-password') @HttpCode(200)
  resetPassword(@Req() req: Req_, @Param('id', new ParseUUIDPipe()) id: string) { const u = this.actor(req, 'user:manage'); return this.admin.resetPassword(u.orgId, u.id, id, this.meta(req)); }

  @Get('audit-logs')
  audit(@Req() req: Req_, @Query(new ZodValidationPipe(AuditLogQuery)) q: AuditLogQuery) { return this.admin.audit(this.actor(req, 'audit:read').orgId, q); }
}
