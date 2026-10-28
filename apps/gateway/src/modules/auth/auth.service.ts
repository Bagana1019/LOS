import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type AccessTokenClaims, type AuthResponse, menuFor, permissionsFor, type SessionUser, type UserRole, UserRole as UserRoles } from '@los/contracts';
import { Clock } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { AuditService } from '../audit/audit.service';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from './password';
import { TokenService } from './token.service';

export interface ClientMeta { ip: string | null; userAgent: string | null; correlationId: string }
export interface Issued { response: AuthResponse; refreshToken: string; refreshExpiresAt: Date }
export interface Authenticated { claims: AccessTokenClaims; user: SessionUser }

const BAD_CREDENTIALS = () => new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Нэвтрэх нэр эсвэл нууц үг буруу' });
const BAD_REFRESH = () => new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN', message: 'Дахин нэвтэрнэ үү' });
const knownRoles = (roles: string[]): UserRole[] => roles.filter((r): r is UserRole => (UserRoles as readonly string[]).includes(r));

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
  ) {}

  /** AC: 5 хэрэглэгчээр нэвтэрнэ; нэвтрэлт бүр iam.audit_log-д бичигдэнэ. Тохиолдол бүр ижил алдаа (username enumeration-гүй). */
  async login(usernameRaw: string, password: string, meta: ClientMeta): Promise<Issued> {
    const username = usernameRaw.trim().toLowerCase();
    const now = this.clock.now();
    const user = await this.prisma.user.findUnique({ where: { username } });
    // Хэрэглэгч байхгүй ч ижил хугацаа зарцуулна
    const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await dummyHash()), false);
    const locked = !!user?.lockedUntil && user.lockedUntil > now;

    if (!user || !ok || locked || !user.isActive) {
      if (user && !locked && user.isActive) {
        const failed = user.failedLoginCount + 1;
        const lock = failed >= this.cfg.maxFailures;
        await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + this.cfg.lockMinutes * 60_000) : null } });
      }
      await this.audit.record({
        orgId: user?.orgId, entity: 'USER', entityId: user?.id ?? 'unknown', action: locked ? 'LOGIN_LOCKED' : 'LOGIN_FAILED', actorId: null,
        afterJson: { username: username.slice(0, 100), reason: !user ? 'UNKNOWN_USER' : !user.isActive ? 'INACTIVE' : locked ? 'LOCKED' : 'BAD_PASSWORD' },
        correlationId: meta.correlationId, ip: meta.ip, userAgent: meta.userAgent,
      });
      throw BAD_CREDENTIALS();
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(password) } : {}) },
    });
    const issued = await this.issue(user, randomUUID(), meta);
    await this.audit.record({ orgId: user.orgId, entity: 'USER', entityId: user.id, action: 'LOGIN_SUCCESS', actorId: user.id, correlationId: meta.correlationId, ip: meta.ip, userAgent: meta.userAgent });
    return issued;
  }

  /** Refresh token rotation: хуучин нэг удаагийнх. Хэрэглэсэн token-ийг дахин ирүүлбэл (хулгайлагдсан гэж үзээд) гинжийг бүхэлд нь хүчингүй болгоно. */
  async refresh(rawToken: string | undefined, meta: ClientMeta): Promise<Issued> {
    if (!rawToken) throw BAD_REFRESH();
    const now = this.clock.now();
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: TokenService.hashRefresh(rawToken) }, include: { user: true } });
    if (!session) throw BAD_REFRESH();

    const claimed = session.revokedAt === null && session.expiresAt > now
      ? (await this.prisma.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: now } })).count === 1
      : false;
    if (!claimed) {
      if (session.revokedAt !== null) {
        await this.prisma.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: now } });
        await this.audit.record({ orgId: session.user.orgId, entity: 'SESSION', entityId: session.id, action: 'TOKEN_REUSE_DETECTED', actorId: session.userId, correlationId: meta.correlationId, ip: meta.ip, userAgent: meta.userAgent });
      }
      throw BAD_REFRESH();
    }
    if (!session.user.isActive) throw BAD_REFRESH();
    const issued = await this.issue(session.user, session.familyId, meta);
    await this.audit.record({ orgId: session.user.orgId, entity: 'SESSION', entityId: session.id, action: 'TOKEN_REFRESH', actorId: session.userId, correlationId: meta.correlationId, ip: meta.ip, userAgent: meta.userAgent });
    return issued;
  }

  async logout(rawToken: string | undefined, meta: ClientMeta): Promise<void> {
    if (!rawToken) return;
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: TokenService.hashRefresh(rawToken) }, include: { user: { select: { orgId: true } } } });
    if (!session) return;
    await this.prisma.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: this.clock.now() } });
    await this.audit.record({ orgId: session.user.orgId, entity: 'SESSION', entityId: session.id, action: 'LOGOUT', actorId: session.userId, correlationId: meta.correlationId, ip: meta.ip, userAgent: meta.userAgent });
  }

  /** Access token + сесс идэвхтэй эсэх + хэрэглэгч идэвхтэй эсэх (logout, идэвхгүй болгосон нь шууд хүчин төгөлдөр). */
  async authenticate(accessToken: string): Promise<Authenticated> {
    const claims = this.tokens.verifyAccess(accessToken);
    const session = await this.prisma.session.findUnique({ where: { id: claims.sid }, include: { user: { include: { branch: { select: { id: true } } } } } });
    if (!session || session.revokedAt !== null || session.expiresAt <= this.clock.now() || !session.user.isActive || session.userId !== claims.sub) {
      throw new UnauthorizedException({ code: 'SESSION_ENDED', message: 'Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү' });
    }
    // Эрх/салбар токеноос биш DB-ээс (эрх өөрчлөгдвөл шууд хүчинтэй)
    return { claims, user: this.toSessionUser(session.user) };
  }

  me(user: SessionUser) { return { user, permissions: permissionsFor(user.roles), menu: menuFor(user.roles) }; }

  private toSessionUser(u: { id: string; orgId: string; branchId: string | null; username: string; fullName: string; roles: string[] }): SessionUser {
    return { id: u.id, orgId: u.orgId, branchId: u.branchId, username: u.username, fullName: u.fullName, roles: knownRoles(u.roles) };
  }

  private async issue(u: { id: string; orgId: string; branchId: string | null; username: string; fullName: string; roles: string[] }, familyId: string, meta: ClientMeta): Promise<Issued> {
    const now = this.clock.now();
    const refresh = this.tokens.newRefreshToken();
    const expiresAt = new Date(now.getTime() + this.cfg.refreshTtlSeconds * 1000);
    const session = await this.prisma.session.create({ data: { userId: u.id, refreshTokenHash: refresh.hash, familyId, userAgent: meta.userAgent?.slice(0, 300) ?? null, ip: meta.ip, expiresAt } });
    const user = this.toSessionUser(u);
    return {
      refreshToken: refresh.token, refreshExpiresAt: expiresAt,
      response: { accessToken: this.tokens.signAccess(user, session.id), expiresIn: this.cfg.accessTtlSeconds, ...this.me(user) },
    };
  }
}
