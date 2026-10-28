import { Inject, Injectable } from '@nestjs/common';
import type { PortalOtpChallenge, PortalOtpRequest, PortalOtpVerify, PortalProfile, PortalRefreshRequest, PortalTokens } from '@los/contracts';
import { randomInt } from 'node:crypto';
import { hmacHex, randomToken, safeEqual } from '../../common/crypto';
import { maskPhone } from '../../common/mask';
import { PortalError } from '../../common/portal-error';
import type { CallContext } from '../../common/request-context';
import { PORTAL_CONFIG, type PortalConfig } from '../../config/portal.config';
import { AuditService } from '../../audit/audit.service';
import { CUSTOMER_DIRECTORY, type CustomerDirectoryPort } from '../../integrations/customer-directory/customer-directory.port';
import { OTP_SENDER, type OtpSenderPort } from '../../integrations/otp-sender/otp-sender.port';
import { RateLimitService } from '../../security/rate-limit.service';
import { KV_STORE, type KvStore } from '../../store/kv-store';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

interface OtpRecord {
  /** Хуурамч (decoy) challenge-д хоосон: хэрэглэгч байгаа/байхгүйг хариугаар ялгах боломжгүй болгоно. */
  customerId: string;
  mac: string;
}

interface RequestInfo {
  ip: string;
  correlationId: string;
}

const HOUR = 3600;

/**
 * Нэвтрэлт: регистр + бүртгэлтэй утас → SMS OTP → access JWT + rotating refresh токен.
 * - Хэрэглэгч байгаа эсэхийг хариугаар задруулахгүй (decoy challenge, ижил хариу/алдаа).
 * - OTP-г HMAC-аар хадгална, нэг удаа, 5 оролдлогоор хязгаарлана.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(PORTAL_CONFIG) private readonly cfg: PortalConfig,
    @Inject(KV_STORE) private readonly store: KvStore,
    @Inject(CUSTOMER_DIRECTORY) private readonly directory: CustomerDirectoryPort,
    @Inject(OTP_SENDER) private readonly sender: OtpSenderPort,
    private readonly limiter: RateLimitService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async requestOtp(dto: PortalOtpRequest, req: RequestInfo): Promise<PortalOtpChallenge> {
    const a = this.cfg.auth;
    const regKey = this.mac(`reg:${dto.registerNo}`);
    const phoneKey = this.mac(`phone:${dto.phone}`);

    await this.limiter.enforce({ name: 'otp-req:ip', limit: a.otpRequestsPerHourPerIp, windowSec: HOUR }, req.ip);
    await this.limiter.enforce({ name: 'otp-req:reg', limit: a.otpRequestsPerHour, windowSec: HOUR }, regKey);
    await this.limiter.enforce({ name: 'otp-req:phone', limit: a.otpRequestsPerHour, windowSec: HOUR }, phoneKey);

    const coolKey = `otp-cool:${this.mac(`${dto.registerNo}|${dto.phone}`)}`;
    if (a.otpResendSec > 0 && !(await this.store.setIfAbsent(coolKey, '1', a.otpResendSec))) {
      throw new PortalError('RATE_LIMITED', undefined, { 'Retry-After': String(Math.max(1, await this.store.ttl(coolKey))) });
    }

    const challengeId = randomToken(16);
    const customer = await this.directory.lookupForLogin({ registerNo: dto.registerNo, phone: dto.phone }, { correlationId: req.correlationId });
    try {
      if (customer) {
        const code = a.mockOtpCode ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
        await this.saveChallenge(challengeId, { customerId: customer.customerId, mac: this.otpMac(challengeId, code) });
        await this.sender.send({ customerId: customer.customerId, code, ttlSec: a.otpTtlSec }, { correlationId: req.correlationId });
      } else {
        // Decoy: хэзээ ч таарахгүй mac. verify() ижил замаар OTP_INVALID/OTP_ATTEMPTS_EXCEEDED буцаана.
        await this.saveChallenge(challengeId, { customerId: '', mac: this.mac(`decoy:${randomToken(16)}`) });
      }
    } catch (err) {
      // Илгээж чадаагүй бол cooldown/challenge-ийг цэвэрлэж, харилцагч шууд дахин оролдож болно.
      await this.store.del(`otp:${challengeId}`).catch(() => undefined);
      await this.store.del(coolKey).catch(() => undefined);
      throw err;
    }

    await this.audit.record({
      action: 'AUTH_OTP_REQUESTED',
      correlationId: req.correlationId,
      outcome: 'SUCCESS',
      ip: req.ip,
      meta: { subject: regKey.slice(0, 12), known: customer !== null },
    });
    return { challengeId, maskedDestination: maskPhone(dto.phone), expiresInSec: a.otpTtlSec, resendAfterSec: a.otpResendSec };
  }

  async verifyOtp(dto: PortalOtpVerify, req: RequestInfo): Promise<PortalTokens> {
    await this.limiter.enforce({ name: 'otp-verify:ip', limit: 30, windowSec: 600 }, req.ip);
    const otpKey = `otp:${dto.challengeId}`;

    const attempts = await this.store.incr(`otp-att:${dto.challengeId}`, this.cfg.auth.otpTtlSec);
    if (attempts > this.cfg.auth.otpMaxAttempts) {
      await this.store.del(otpKey);
      await this.failLogin(req, 'OTP_ATTEMPTS_EXCEEDED');
      throw new PortalError('OTP_ATTEMPTS_EXCEEDED');
    }

    const raw = await this.store.get(otpKey);
    if (!raw) {
      await this.failLogin(req, 'OTP_EXPIRED');
      throw new PortalError('OTP_EXPIRED');
    }
    const record = JSON.parse(raw) as OtpRecord;
    if (!record.customerId || !safeEqual(record.mac, this.otpMac(dto.challengeId, dto.code))) {
      await this.failLogin(req, 'OTP_INVALID');
      throw new PortalError('OTP_INVALID');
    }
    // Зөв код: нэг удаагийн хэрэглээ. Зэрэг ирсэн хоёр хүсэлтийн нэг нь л авна.
    if ((await this.store.getAndDelete(otpKey)) === null) throw new PortalError('OTP_EXPIRED');
    await this.store.del(`otp-att:${dto.challengeId}`);

    const session = await this.sessions.create(record.customerId);
    await this.audit.record({
      action: 'AUTH_LOGIN',
      correlationId: req.correlationId,
      outcome: 'SUCCESS',
      customerId: record.customerId,
      ip: req.ip,
      target: { type: 'SESSION', id: session.sessionId },
    });
    return this.tokenResponse(session.customerId, session.sessionId, session.refreshToken, session.refreshExpiresInSec);
  }

  async refresh(dto: PortalRefreshRequest, req: RequestInfo): Promise<PortalTokens> {
    await this.limiter.enforce({ name: 'refresh:ip', limit: 60, windowSec: 600 }, req.ip);
    const outcome = await this.sessions.rotate(dto.refreshToken);
    if (outcome.kind === 'REUSE_DETECTED') {
      await this.audit.record({
        action: 'AUTH_REFRESH_REUSE_DETECTED',
        correlationId: req.correlationId,
        outcome: 'FAILURE',
        customerId: outcome.customerId,
        ip: req.ip,
        target: { type: 'SESSION', id: outcome.sessionId },
      });
      throw new PortalError('UNAUTHENTICATED');
    }
    await this.audit.record({
      action: 'AUTH_REFRESH',
      correlationId: req.correlationId,
      outcome: 'SUCCESS',
      customerId: outcome.customerId,
      ip: req.ip,
      target: { type: 'SESSION', id: outcome.sessionId },
    });
    return this.tokenResponse(outcome.customerId, outcome.sessionId, outcome.refreshToken, outcome.refreshExpiresInSec);
  }

  async logout(ctx: CallContext, sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
    await this.audit.record({
      action: 'AUTH_LOGOUT',
      correlationId: ctx.correlationId,
      outcome: 'SUCCESS',
      customerId: ctx.customerId,
      target: { type: 'SESSION', id: sessionId },
    });
  }

  getProfile(ctx: CallContext): Promise<PortalProfile> {
    return this.directory.getProfile(ctx);
  }

  private tokenResponse(customerId: string, sessionId: string, refreshToken: string, refreshExpiresInSec: number): PortalTokens {
    const access = this.tokens.signAccess({ customerId, sessionId });
    return { tokenType: 'Bearer', accessToken: access.token, expiresInSec: access.expiresInSec, refreshToken, refreshExpiresInSec };
  }

  private saveChallenge(challengeId: string, record: OtpRecord): Promise<void> {
    return this.store.set(`otp:${challengeId}`, JSON.stringify(record), this.cfg.auth.otpTtlSec);
  }

  private failLogin(req: RequestInfo, reason: string): Promise<void> {
    return this.audit.record({ action: 'AUTH_LOGIN_FAILED', correlationId: req.correlationId, outcome: 'FAILURE', ip: req.ip, meta: { reason } });
  }

  /** Түлхүүртэй хэш: регистр/утсыг Redis түлхүүр, аудитад plain хэлбэрээр оруулахгүй. */
  private mac(value: string): string {
    return hmacHex(this.cfg.auth.hashSecret, value);
  }

  private otpMac(challengeId: string, code: string): string {
    return this.mac(`otp:${challengeId}:${code}`);
  }
}
