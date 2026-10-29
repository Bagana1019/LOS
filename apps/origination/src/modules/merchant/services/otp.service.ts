import { createHmac, timingSafeEqual } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OtpSent, PosOtpPurpose } from '@los/contracts';
import { maskPhone } from '../common/masking';
import type { RequestContext } from '../common/request-context';
import { addSeconds } from '../common/time';
import { POS_CONFIG, type PosConfig } from '../config/pos.config';
import { DomainError } from '../domain/errors';
import type { LeaseRecord, OtpRecord } from '../domain/records';
import { Clock, IdGenerator, OtpGenerator, SmsGateway } from '../ports';
import { MerchantRepository, OtpRepository } from '../persistence/repositories';

/** Худалдан авагчийн утсанд очих SMS-ийн агуулга. ТЕКСТИЙГ ХЭЗЭЭ Ч ЛОГЛОХГҮЙ (код агуулна). */
export function otpSmsText(merchantName: string, purpose: PosOtpPurpose, code: string, validityMinutes: number): string {
  const sentence = purpose === 'CONSENT'
    ? 'Та зээлийн мэдээллээ шалгуулж, лизингийн хүсэлт гаргахыг зөвшөөрч байвал энэ кодыг ажилтанд хэлнэ үү.'
    : 'Та лизингийн нөхцөлийг хүлээн зөвшөөрч байвал энэ кодыг ажилтанд хэлнэ үү.';
  return `${merchantName}: Баталгаажуулах код ${code}. ${sentence} Код ${validityMinutes} минут хүчинтэй.`;
}

/**
 * POS-BR-8 — OTP: 6 орон, TTL, оролдлогын тоо, дахин илгээх хязгаар, лизинг тутамд илгээлтийн дээд тоо.
 * Код HMAC-SHA256(POS_OTP_SECRET, leaseId:purpose:code) hash-аар хадгалагдаж timing-safe харьцуулагдана. Кодыг API-д хэзээ ч буцаахгүй.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(OtpRepository) private readonly otps: OtpRepository,
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
    @Inject(SmsGateway) private readonly sms: SmsGateway,
    @Inject(OtpGenerator) private readonly generator: OtpGenerator,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(IdGenerator) private readonly ids: IdGenerator,
    @Inject(POS_CONFIG) private readonly config: PosConfig,
  ) {}

  hashCode(leaseId: string, purpose: PosOtpPurpose, code: string): string {
    return createHmac('sha256', this.config.otpSecret).update(`${leaseId}:${purpose}:${code}`).digest('hex');
  }

  toOtpSent(o: Pick<OtpRecord, 'purpose' | 'sentToMasked' | 'expiresAt' | 'sentAt'>): OtpSent {
    return { purpose: o.purpose, phoneMasked: o.sentToMasked, expiresAt: o.expiresAt.toISOString(), resendAvailableAt: addSeconds(o.sentAt, this.config.otpResendSeconds).toISOString() };
  }

  latest(leaseId: string, purpose: PosOtpPurpose) {
    return this.otps.latestOtp(leaseId, purpose);
  }

  async issue(lease: LeaseRecord, purpose: PosOtpPurpose, _ctx: RequestContext): Promise<OtpSent> {
    const now = this.clock.now();
    const latest = await this.otps.latestOtp(lease.id, purpose);
    if (latest) {
      const availableAt = addSeconds(latest.sentAt, this.config.otpResendSeconds);
      if (now < availableAt) {
        throw new DomainError('OTP_RESEND_TOO_SOON', 'Please wait before requesting another code', { retryAfterSeconds: Math.ceil((availableAt.getTime() - now.getTime()) / 1000) });
      }
    }
    if ((await this.otps.countOtps(lease.id)) >= this.config.otpMaxSends) {
      throw new DomainError('OTP_ATTEMPTS_EXCEEDED', 'Maximum number of codes sent for this lease', { reason: 'MAX_SENDS', maxSends: this.config.otpMaxSends });
    }
    const merchant = await this.merchants.findMerchant(lease.orgId, lease.merchantId);
    const code = this.generator.next();
    // SMS эхлээд: амжилтгүй бол өмнөх код хүчинтэй хэвээр, дахин илгээх хязгаар/тоолуур нэмэгдэхгүй (кассир шууд resend хийж чадна).
    try {
      await this.sms.send(lease.buyerPhone, otpSmsText(merchant?.name ?? 'Лизинг', purpose, code, Math.ceil(this.config.otpTtlSeconds / 60)));
    } catch (e) {
      throw e instanceof DomainError && e.code === 'SMS_UNAVAILABLE' ? e : new DomainError('SMS_UNAVAILABLE', 'SMS could not be sent');
    }
    const record = await this.otps.insertOtp({
      id: this.ids.uuid(), orgId: lease.orgId, leaseId: lease.id, purpose, codeHash: this.hashCode(lease.id, purpose, code),
      expiresAt: addSeconds(now, this.config.otpTtlSeconds), attempts: 0, sentToMasked: maskPhone(lease.buyerPhone), sentAt: now, verifiedAt: null,
    });
    return this.toOtpSent(record);
  }

  /** Оролдлого АТОМААР тоологдож дараа нь үр дүн буцна — алдаатай үед ч. Баталгаажсан код дахин ашиглагдахгүй (зэрэгцээ хүсэлтэд ч нэг л удаа). */
  async verify(lease: LeaseRecord, purpose: PosOtpPurpose, code: string): Promise<void> {
    const now = this.clock.now();
    const otp = await this.otps.latestOtp(lease.id, purpose);
    if (!otp) throw new DomainError('OTP_NOT_REQUESTED', 'No code has been requested');
    if (otp.verifiedAt) throw new DomainError('OTP_NOT_REQUESTED', 'The code was already used; request a new one', { reason: 'ALREADY_USED' });
    if (otp.expiresAt.getTime() <= now.getTime()) throw new DomainError('OTP_EXPIRED', 'The code has expired');
    if (otp.attempts >= this.config.otpMaxAttempts) throw new DomainError('OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts', { reason: 'MAX_ATTEMPTS' });

    // Оролдлогыг атомаар тооцно: зэрэгцээ хүсэлтүүд хязгаараас илүү таах боломжгүй.
    const attempts = await this.otps.registerOtpAttempt(otp, this.config.otpMaxAttempts);
    if (attempts === null) {
      const fresh = await this.otps.latestOtp(lease.id, purpose);
      if (fresh?.verifiedAt) throw new DomainError('OTP_NOT_REQUESTED', 'The code was already used; request a new one', { reason: 'ALREADY_USED' });
      throw new DomainError('OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts', { reason: 'MAX_ATTEMPTS' });
    }
    if (!this.matches(otp.codeHash, this.hashCode(lease.id, purpose, code))) {
      const attemptsLeft = Math.max(0, this.config.otpMaxAttempts - attempts);
      if (attemptsLeft === 0) throw new DomainError('OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts', { reason: 'MAX_ATTEMPTS' });
      throw new DomainError('OTP_INVALID', 'The code is incorrect', { attemptsLeft });
    }
    // Зэрэгцээ хоёр зөв код ирвэл зөвхөн нэг нь амжилттай.
    if (!(await this.otps.markOtpVerified(otp, now))) throw new DomainError('OTP_NOT_REQUESTED', 'The code was already used; request a new one', { reason: 'ALREADY_USED' });
  }

  private matches(expectedHex: string, actualHex: string): boolean {
    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(actualHex, 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  }
}
