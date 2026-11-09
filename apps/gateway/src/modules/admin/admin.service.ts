import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ADMIN_BRANCH_BOUND_ROLES, type AdminBranchDto, type AdminUserDto, type AuditLogPage, type AuditLogQuery, type CreateBranchBody, type CreateUserBody, type UpdateBranchBody, type UpdateUserBody, type UserCredentialResult } from '@los/contracts';
import { DomainError, notFound } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { hashPassword } from '../auth/password';

export interface Meta { correlationId: string | null; ip: string | null }
type UserRow = { id: string; username: string; fullName: string; roles: string[]; branchId: string | null; isActive: boolean; lastLoginAt: Date | null; email: string | null; phone: string | null; mustChangePassword: boolean };
const toUserDto = (u: UserRow): AdminUserDto => ({ id: u.id, username: u.username, fullName: u.fullName, roles: u.roles, branchId: u.branchId, isActive: u.isActive, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, email: u.email, phone: u.phone, mustChangePassword: u.mustChangePassword });

/** Түр нууц үг: 16 тэмдэгт, төөрөгдөл үүсгэх тэмдэгтгүй (0/O, 1/l/I), бодлогыг (том/жижиг/тоо) заавал хангана. */
function temporaryPassword(): string {
  const pick = (set: string) => set[randomInt(set.length)]!;
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnopqrstuvwxyz', D = '23456789';
  const chars = [pick(U), pick(L), pick(D), ...Array.from({ length: 13 }, () => pick(U + L + D))];
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
  return chars.join('');
}

/** M13 · Хэрэглэгч-салбар оноолт (iam). Салбарын код нь origination `contract.branch_codes` тохиргоонд (CLAUDE.md §3.2.8). */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async branches(orgId: string): Promise<AdminBranchDto[]> {
    const [rows, counts] = await Promise.all([
      this.prisma.branch.findMany({ where: { orgId }, orderBy: { code: 'asc' } }),
      this.prisma.user.groupBy({ by: ['branchId'], where: { orgId, isActive: true, branchId: { not: null } }, _count: { _all: true } }),
    ]);
    const n = new Map(counts.map((c) => [c.branchId, c._count._all]));
    return rows.map((b) => ({ id: b.id, code: b.code, name: b.name, isActive: b.isActive, activeUserCount: n.get(b.id) ?? 0 }));
  }

  async users(orgId: string): Promise<AdminUserDto[]> {
    return (await this.prisma.user.findMany({ where: { orgId }, orderBy: { username: 'asc' } })).map(toUserDto);
  }

  private async userDto(orgId: string, id: string): Promise<AdminUserDto> {
    return toUserDto((await this.prisma.user.findFirstOrThrow({ where: { id, orgId } })));
  }

  // ── Салбар (устгахгүй: хүсэлт, аудит ID-аар заасан) ──
  async createBranch(orgId: string, actorId: string, body: CreateBranchBody, meta: Meta): Promise<AdminBranchDto> {
    if (await this.prisma.branch.findUnique({ where: { orgId_code: { orgId, code: body.code } } })) throw new DomainError('BRANCH_CODE_TAKEN', 'Энэ кодтой салбар бүртгэлтэй байна', 409);
    const b = await this.prisma.$transaction(async (tx) => {
      const created = await tx.branch.create({ data: { orgId, code: body.code, name: body.name, createdBy: actorId, updatedBy: actorId } });
      await tx.auditLog.create({ data: { orgId, entity: 'BRANCH', entityId: created.id, action: 'BRANCH_CREATED', actorId, afterJson: { code: created.code, name: created.name }, ...meta } });
      return created;
    });
    return { id: b.id, code: b.code, name: b.name, isActive: b.isActive, activeUserCount: 0 };
  }

  async updateBranch(orgId: string, actorId: string, id: string, body: UpdateBranchBody, meta: Meta): Promise<AdminBranchDto> {
    const before = await this.prisma.branch.findFirst({ where: { id, orgId } });
    if (!before) throw notFound('Салбар', id);
    await this.prisma.$transaction(async (tx) => {
      await tx.branch.update({ where: { id }, data: { name: body.name, updatedBy: actorId } });
      await tx.auditLog.create({ data: { orgId, entity: 'BRANCH', entityId: id, action: 'BRANCH_UPDATED', actorId, beforeJson: { name: before.name }, afterJson: { name: body.name }, ...meta } });
    });
    return (await this.branches(orgId)).find((b) => b.id === id)!;
  }

  /** Идэвхгүй болгох: идэвхтэй хэрэглэгч үлдсэн салбарыг болихгүй (эхлээд шилжүүлнэ). Сэргээх боломжтой. */
  async setBranchActive(orgId: string, actorId: string, id: string, isActive: boolean, meta: Meta): Promise<AdminBranchDto> {
    const before = await this.prisma.branch.findFirst({ where: { id, orgId } });
    if (!before) throw notFound('Салбар', id);
    if (before.isActive === isActive) return (await this.branches(orgId)).find((b) => b.id === id)!;
    if (!isActive) {
      const n = await this.prisma.user.count({ where: { orgId, branchId: id, isActive: true } });
      if (n > 0) throw new DomainError('BRANCH_HAS_ACTIVE_USERS', `Салбарт ${n} идэвхтэй хэрэглэгч байна. Эхлээд өөр салбарт шилжүүлнэ үү`, 422);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.branch.update({ where: { id }, data: { isActive, updatedBy: actorId } });
      await tx.auditLog.create({ data: { orgId, entity: 'BRANCH', entityId: id, action: isActive ? 'BRANCH_REACTIVATED' : 'BRANCH_DEACTIVATED', actorId, beforeJson: { isActive: before.isActive }, afterJson: { isActive }, ...meta } });
    });
    return (await this.branches(orgId)).find((b) => b.id === id)!;
  }

  // ── Хэрэглэгч ──
  /** Дүр ↔ салбар: ЗЭЗ/салбарын захирал заавал идэвхтэй салбартай (NFR-3 хүрээ). */
  private async checkRolesBranch(orgId: string, roles: readonly string[], branchId: string | null): Promise<void> {
    if (branchId) {
      const b = await this.prisma.branch.findFirst({ where: { id: branchId, orgId } });
      if (!b) throw notFound('Салбар', branchId);
      if (!b.isActive) throw new DomainError('BRANCH_INACTIVE', 'Идэвхгүй салбарт оноох боломжгүй', 422);
    } else if (roles.some((r) => (ADMIN_BRANCH_BOUND_ROLES as readonly string[]).includes(r))) {
      throw new DomainError('BRANCH_REQUIRED', 'ЗЭЗ, салбарын захирал заавал салбартай байх ёстой', 422);
    }
  }

  /** Сүүлийн идэвхтэй ADMIN-ыг (өөрийгөө оролцуулан) алдахаас сэргийлнэ. */
  private async assertAnotherAdmin(orgId: string, exceptUserId: string): Promise<void> {
    const n = await this.prisma.user.count({ where: { orgId, isActive: true, id: { not: exceptUserId }, roles: { has: 'ADMIN' } } });
    if (n === 0) throw new DomainError('LAST_ADMIN', 'Сүүлийн идэвхтэй админыг хасах боломжгүй', 422);
  }

  /** Шинэ хэрэглэгч + түр нууц үг (нэг удаа буцна; эхний нэвтрэлтээр заавал солино). Нууц үг, ПИИ аудитад орохгүй. */
  async createUser(orgId: string, actorId: string, body: CreateUserBody, meta: Meta): Promise<UserCredentialResult> {
    if (await this.prisma.user.findUnique({ where: { username: body.username } })) throw new DomainError('USERNAME_TAKEN', 'Энэ нэвтрэх нэр бүртгэлтэй байна', 409);
    await this.checkRolesBranch(orgId, body.roles, body.branchId);
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    const created = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { orgId, branchId: body.branchId, username: body.username, passwordHash, fullName: body.fullName, email: body.email, phone: body.phone, roles: body.roles, mustChangePassword: true, createdBy: actorId, updatedBy: actorId } });
      await tx.auditLog.create({ data: { orgId, entity: 'USER', entityId: u.id, action: 'USER_CREATED', actorId, afterJson: { username: u.username, roles: u.roles, branchId: u.branchId }, ...meta } });
      return u;
    });
    return { user: toUserDto(created), temporaryPassword: password };
  }

  /** Мэдээлэл, дүр, салбар засах. Дүр/салбар өөрчлөгдвөл сесс хүчингүй (шинэ эрх шууд үйлчилнэ). Өөрийн ADMIN дүрийг хасах боломжгүй. */
  async updateUser(orgId: string, actorId: string, id: string, body: UpdateUserBody, meta: Meta): Promise<AdminUserDto> {
    const before = await this.prisma.user.findFirst({ where: { id, orgId } });
    if (!before) throw notFound('Хэрэглэгч', id);
    const losesAdmin = before.roles.includes('ADMIN') && !body.roles.includes('ADMIN');
    if (losesAdmin) {
      if (id === actorId) throw new DomainError('SELF_ADMIN_REMOVAL', 'Өөрийн админ эрхийг хасах боломжгүй', 422);
      if (before.isActive) await this.assertAnotherAdmin(orgId, id);
    }
    await this.checkRolesBranch(orgId, body.roles, body.branchId);
    const sameRoles = [...before.roles].sort().join() === [...body.roles].sort().join();
    const accessChanged = !sameRoles || before.branchId !== body.branchId;
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { fullName: body.fullName, email: body.email, phone: body.phone, roles: body.roles, branchId: body.branchId, updatedBy: actorId } });
      if (accessChanged) await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({
        data: {
          orgId, entity: 'USER', entityId: id, action: sameRoles ? 'USER_UPDATED' : 'USER_ROLES_CHANGED', actorId,
          beforeJson: { roles: before.roles, branchId: before.branchId }, afterJson: { roles: body.roles, branchId: body.branchId, profileChanged: before.fullName !== body.fullName || before.email !== body.email || before.phone !== body.phone }, ...meta,
        },
      });
    });
    return this.userDto(orgId, id);
  }

  /** Идэвхгүй болгох/сэргээх. Идэвхгүй хэрэглэгч нэвтэрч чадахгүй, нээлттэй сесс бүгд хүчингүй. Өөрийгөө, сүүлийн админыг болохгүй. */
  async setUserActive(orgId: string, actorId: string, id: string, isActive: boolean, meta: Meta): Promise<AdminUserDto> {
    const before = await this.prisma.user.findFirst({ where: { id, orgId } });
    if (!before) throw notFound('Хэрэглэгч', id);
    if (before.isActive === isActive) return toUserDto(before);
    if (!isActive) {
      if (id === actorId) throw new DomainError('SELF_DEACTIVATION', 'Өөрийгөө идэвхгүй болгох боломжгүй', 422);
      if (before.roles.includes('ADMIN')) await this.assertAnotherAdmin(orgId, id);
    } else if (before.branchId) {
      const b = await this.prisma.branch.findUnique({ where: { id: before.branchId } });
      if (b && !b.isActive) throw new DomainError('BRANCH_INACTIVE', 'Хэрэглэгчийн салбар идэвхгүй байна. Эхлээд салбарыг сэргээх эсвэл өөр салбар онооно уу', 422);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { isActive, deactivatedAt: isActive ? null : new Date(), failedLoginCount: 0, lockedUntil: null, updatedBy: actorId } });
      if (!isActive) await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { orgId, entity: 'USER', entityId: id, action: isActive ? 'USER_REACTIVATED' : 'USER_DEACTIVATED', actorId, beforeJson: { isActive: before.isActive }, afterJson: { isActive }, ...meta } });
    });
    return this.userDto(orgId, id);
  }

  /** Нууц үг шинэчлэх: шинэ түр нууц үг (нэг удаа), заавал солих туг, сесс хүчингүй, түгжээ цэвэрлэнэ. Өөрийнхийг энд биш /auth/change-password-оор. */
  async resetPassword(orgId: string, actorId: string, id: string, meta: Meta): Promise<UserCredentialResult> {
    const before = await this.prisma.user.findFirst({ where: { id, orgId } });
    if (!before) throw notFound('Хэрэглэгч', id);
    if (id === actorId) throw new DomainError('SELF_PASSWORD_RESET', 'Өөрийн нууц үгийг "Нууц үг солих" хэсгээс сольно уу', 422);
    if (!before.isActive) throw new DomainError('USER_INACTIVE', 'Идэвхгүй хэрэглэгчийн нууц үгийг шинэчлэх боломжгүй', 422);
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, updatedBy: actorId } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { orgId, entity: 'USER', entityId: id, action: 'USER_PASSWORD_RESET', actorId, ...meta } });
    });
    return { user: await this.userDto(orgId, id), temporaryPassword: password };
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
