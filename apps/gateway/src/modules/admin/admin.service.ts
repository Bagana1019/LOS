import { Injectable } from '@nestjs/common';
import { ADMIN_BRANCH_BOUND_ROLES, type AdminBranchDto, type AdminUserDto, type AuditLogPage, type AuditLogQuery } from '@los/contracts';
import { DomainError, notFound } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';

/** M13 · Хэрэглэгч-салбар оноолт (iam). Салбарын код нь origination `contract.branch_codes` тохиргоонд (CLAUDE.md §3.2.8). */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async branches(orgId: string): Promise<AdminBranchDto[]> {
    return (await this.prisma.branch.findMany({ where: { orgId }, orderBy: { code: 'asc' } })).map((b) => ({ id: b.id, code: b.code, name: b.name, isActive: b.isActive }));
  }

  async users(orgId: string): Promise<AdminUserDto[]> {
    return (await this.prisma.user.findMany({ where: { orgId }, orderBy: { username: 'asc' } })).map((u) => ({
      id: u.id, username: u.username, fullName: u.fullName, roles: u.roles, branchId: u.branchId, isActive: u.isActive, lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    }));
  }

  /**
   * Хэрэглэгчийг салбарт оноох/салгах. ЗЭЗ, салбарын захирал салбаргүй байж болохгүй (NFR-3 хүрээ). Оноолт солигдмогц нээлттэй сессийг хүчингүй болгоно —
   * JWT дахь `branchId` шинэчлэгдэж, шинэ хүрээ дараагийн нэвтрэлтээс үйлчилнэ.
   */
  async assignBranch(orgId: string, actorId: string, userId: string, branchId: string | null, meta: { correlationId: string | null; ip: string | null }): Promise<AdminUserDto> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, orgId } });
    if (!user) throw notFound('Хэрэглэгч', userId);
    if (branchId) {
      const b = await this.prisma.branch.findFirst({ where: { id: branchId, orgId } });
      if (!b) throw notFound('Салбар', branchId);
      if (!b.isActive) throw new DomainError('BRANCH_INACTIVE', 'Идэвхгүй салбарт оноох боломжгүй', 422);
    } else if (user.roles.some((r) => (ADMIN_BRANCH_BOUND_ROLES as readonly string[]).includes(r))) {
      throw new DomainError('BRANCH_REQUIRED', 'ЗЭЗ, салбарын захирал заавал салбартай байх ёстой', 422);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { branchId, updatedBy: actorId } });
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { orgId, entity: 'USER', entityId: userId, action: 'USER_BRANCH_ASSIGNED', actorId, beforeJson: { branchId: user.branchId }, afterJson: { branchId }, correlationId: meta.correlationId, ip: meta.ip } });
    });
    return (await this.users(orgId)).find((u) => u.id === userId)!;
  }

  async audit(orgId: string, q: AuditLogQuery): Promise<AuditLogPage> {
    const where = {
      OR: [{ orgId }, { orgId: null }], // нэвтрэлтийн бүтэлгүй оролдлого org-гүй бичигддэг
      ...(q.entity ? { entity: q.entity } : {}), ...(q.entityId ? { entityId: q.entityId } : {}), ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: q.action } : {}), ...(q.applicationId ? { applicationId: q.applicationId } : {}),
      ...(q.from || q.to ? { at: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: rows.map((r) => ({ id: r.id, entity: r.entity, entityId: r.entityId, action: r.action, actorId: r.actorId, at: r.at.toISOString(), applicationId: r.applicationId, correlationId: r.correlationId, beforeJson: r.beforeJson, afterJson: r.afterJson })),
    };
  }
}
