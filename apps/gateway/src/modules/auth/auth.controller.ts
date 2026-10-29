import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LoginRequest, type MeResponse, type AuthResponse, type SessionUser } from '@los/contracts';
import { Public, ZodValidationPipe, contextOf } from '@los/nest-common';
import { Inject } from '@nestjs/common';
import { AUTH_CONFIG, REFRESH_COOKIE, type AuthConfig } from './auth.config';
import { AuthService, type ClientMeta, type Issued } from './auth.service';

type Req_ = { headers: Record<string, string | string[] | undefined>; cookies?: Record<string, string>; ip?: string; user?: SessionUser };
type Res_ = { cookie(n: string, v: string, o: object): void; clearCookie(n: string, o: object): void };

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig) {}

  private meta(req: Req_): ClientMeta {
    const ua = req.headers['user-agent'];
    return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null, correlationId: contextOf(req as never).correlationId };
  }
  private cookieOpts(expires?: Date) {
    return { httpOnly: true, secure: this.cfg.cookieSecure, sameSite: 'strict' as const, path: '/api/auth', ...(expires ? { expires } : {}) };
  }
  private send(res: Res_, issued: Issued): AuthResponse {
    res.cookie(REFRESH_COOKIE, issued.refreshToken, this.cookieOpts(issued.refreshExpiresAt));
    return issued.response;
  }
  /** Cookie-д суурилсан endpoint (refresh/logout): Origin байвал зөвшөөрөгдсөн web origin байх ёстой (CSRF-ийн нэмэлт хамгаалалт). */
  private checkOrigin(req: Req_) {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !this.cfg.webOrigins.includes(origin)) throw new ForbiddenException({ code: 'BAD_ORIGIN', message: 'Зөвшөөрөгдөөгүй origin' });
  }

  @Public() @Throttle({ default: { limit: () => Number(process.env.LOGIN_RATE_LIMIT ?? 10), ttl: 60_000 } }) @Post('login') @HttpCode(200)
  async login(@Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest, @Req() req: Req_, @Res({ passthrough: true }) res: Res_): Promise<AuthResponse> {
    return this.send(res, await this.auth.login(body.username, body.password, this.meta(req)));
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Post('refresh') @HttpCode(200)
  async refresh(@Req() req: Req_, @Res({ passthrough: true }) res: Res_): Promise<AuthResponse> {
    this.checkOrigin(req);
    try {
      return this.send(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], this.meta(req)));
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOpts());
      throw e;
    }
  }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Req() req: Req_, @Res({ passthrough: true }) res: Res_): Promise<void> {
    this.checkOrigin(req);
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE], this.meta(req));
    res.clearCookie(REFRESH_COOKIE, this.cookieOpts());
  }

  @Get('me')
  me(@Req() req: Req_): MeResponse {
    return this.auth.me(req.user!);
  }
}
