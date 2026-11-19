import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { type AccessTokenClaims, type AuthResponse, menuFor, permissionsFor, type SessionUser } from '@los/contracts';
import { Clock } from '@los/nest-common';
import { Prisma } from '.prisma/client-gateway';
import { normalizeUsername } from './login-limiter';
import { PrismaService } from '../../prisma.service';
import { AuditService } from '../audit/audit.service';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from './password';
import { TokenService } from './token.service';
import { resolvePrincipal } from './merchant-principal';

export interface ClientMeta { ip: string | null; userAgent: string | null; correlationId: string }
export interface Issued { response: AuthResponse; refreshToken: string; refreshExpiresAt: Date }
type DbUser = { id: string; orgId: string; branchId: string | null; username: string; fullName: string; roles: string[]; merchantId?: string | null; storeId?: string | null };
export interface Authenticated { claims: AccessTokenClaims; user: SessionUser; mustChangePassword: boolean }

const BAD_CREDENTIALS = () => new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Нэвтрэх нэр эсвэл нууц үг буруу' });
const BAD_REFRESH = () => new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN', message: 'Дахин нэвтэрнэ үү' });

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
  ) {}

  /**
   * AC: 5 хэрэглэгчээр нэвтэрнэ; нэвтрэлт бүр iam.audit_log-д бичигдэнэ. Тохиолдол бүр ижил алдаа (username enumeration-гүй).
   * M7: дансны оролдлогыг нууц үг шалгахаас ӨМНӨ атомараар нөөцөлнө (`failedLoginCount` increment, `< LOGIN_MAX_FAILURES` нөхцөлтэй) —
   * зэрэг ирсэн burst нийлээд LOGIN_MAX_FAILURES-аас илүү нууц үг шалгуулж чадахгүй; босгонд хүрвэл LOGIN_LOCK_MINUTES түгжинэ.
   */
  async login(usernameRaw: string, password: string, meta: ClientMeta): Promise<Issued> {
    const username = normalizeUsername(usernameRaw);
    const now = this.clock.now();
    const user = await this.prisma.user.findUnique({ where: { username } });
    const attempt = user?.isActive ? await this.reserveAttempt(user.id, now) : null;
    // Хэрэглэгч байхгүй / идэвхгүй / түгжээтэй ч ижил хугацаа зарцуулна
    const ok = user && attempt !== null ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await dummyHash()), false);
    const locked = !!user?.isActive && attempt === null;

    if (!user || !ok) {
      if (user && (locked || attempt! >= this.cfg.maxFailures)) await this.lockIfExhausted(user.id, now);
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
    return { claims, user: this.toSessionUser(session.user), mustChangePassword: session.user.mustChangePassword };
  }

  me(user: SessionUser, mustChangePassword = false) { return { user, permissions: permissionsFor(user.roles), menu: menuFor(user.roles), ...(mustChangePassword ? { mustChangePassword } : {}) }; }

  /** FR-13 · Өөрийн нууц үгээ солих. Бүх сесс хүчингүй болно (хулгайлагдсан token-ийг тасална), хэрэглэгч шинэ нууц үгээр дахин нэвтэрнэ. Нууц үгийг лог/аудитад бичихгүй. */
  async changePassword(userId: string, currentPassword: string, newPassword: string, meta: ClientMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Одоогийн нууц үг буруу' });
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new UnprocessableEntityException({ code: 'PASSWORD_UNCHANGED', message: 'Шинэ нууц үг одоогийнхоос өөр байх ёстой' });
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null, updatedBy: userId } }),
      this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: this.clock.now() } }),
    ]);
    await this.audit.record({ orgId: user.orgId, entity: 'USER', entityId: userId, action: 'PASSWORD_CHANGED', actorId: userId, correlationId: meta.correlationId, ip: meta.ip, userAgent: meta.userAgent });
  }

  /** Нэг оролдлого нөөцлөөд шинэ тоог буцаана; түгжээтэй эсвэл босго дүүрсэн бол null. Postgres UPDATE … WHERE нь мөрийн түгжээгээр атомар. */
  private async reserveAttempt(userId: string, now: Date): Promise<number | null> {
    try {
      const u = await this.prisma.user.update({
        where: { id: userId, failedLoginCount: { lt: this.cfg.maxFailures }, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
        data: { failedLoginCount: { increment: 1 } }, select: { failedLoginCount: true },
      });
      return u.failedLoginCount;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return null;
      throw e;
    }
  }

  /** Босго дүүрсэн бол түгжинэ (тоолуур 0). Түгжээгүй атлаа дүүрсэн (жнь процесс унасан) төлөв мөнхийн түгжээ болохгүй — хугацаатай түгжээ болно. */
  private async lockIfExhausted(userId: string, now: Date): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, failedLoginCount: { gte: this.cfg.maxFailures } },
      data: { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + this.cfg.lockMinutes * 60_000) },
    });
  }

  private toSessionUser(u: DbUser): SessionUser {
    // docs/05-merchant-pos.md §2: мерчантын хүрээ DB-ээс; буруу тохиргоо → дүргүй (merchant-principal.ts)
    const p = resolvePrincipal({ roles: u.roles, merchantId: u.merchantId ?? null, storeId: u.storeId ?? null });
    return { id: u.id, orgId: u.orgId, branchId: u.branchId, username: u.username, fullName: u.fullName, roles: p.roles, merchantId: p.merchantId, storeId: p.storeId };
  }

  private async issue(u: DbUser & { mustChangePassword?: boolean }, familyId: string, meta: ClientMeta): Promise<Issued> {
    const now = this.clock.now();
    const refresh = this.tokens.newRefreshToken();
    const expiresAt = new Date(now.getTime() + this.cfg.refreshTtlSeconds * 1000);
    const session = await this.prisma.session.create({ data: { userId: u.id, refreshTokenHash: refresh.hash, familyId, userAgent: meta.userAgent?.slice(0, 300) ?? null, ip: meta.ip, expiresAt } });
    const user = this.toSessionUser(u);
    return {
      refreshToken: refresh.token, refreshExpiresAt: expiresAt,
      response: { accessToken: this.tokens.signAccess(user, session.id), expiresIn: this.cfg.accessTtlSeconds, ...this.me(user, u.mustChangePassword) },
    };
  }
}
