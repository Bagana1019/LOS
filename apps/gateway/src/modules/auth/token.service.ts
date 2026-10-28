import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenClaims, type UserRole } from '@los/contracts';
import { createHash, randomBytes } from 'node:crypto';
import { AUTH_CONFIG, type AuthConfig } from './auth.config';

@Injectable()
export class TokenService {
  private readonly jwt: JwtService;
  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfig) {
    this.jwt = new JwtService({ secret: cfg.jwtSecret, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } });
  }

  signAccess(u: { id: string; orgId: string; branchId: string | null; roles: UserRole[] }, sessionId: string): string {
    return this.jwt.sign({ org: u.orgId, br: u.branchId, roles: u.roles, sid: sessionId }, { subject: u.id, expiresIn: this.cfg.accessTtlSeconds });
  }

  verifyAccess(token: string): AccessTokenClaims {
    try {
      return AccessTokenClaims.parse(this.jwt.verify(token));
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Нэвтрэх хугацаа дууссан эсвэл токен буруу' });
    }
  }

  /** Refresh token: 256 бит санамсаргүй; DB-д зөвхөн SHA-256 hash. */
  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: TokenService.hashRefresh(token) };
  }
  static hashRefresh(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}
