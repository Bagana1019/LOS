import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../domain/errors';
import type { OtpRecord } from '../../domain/records';
import { OtpRepository } from '../repositories';
import { otpMutable, otpToCreate, otpToRecord } from './mappers';
import { isUuid } from './prisma-errors';
import { PrismaService } from './prisma.service';

// POS-BR-8: OTP. Зөвхөн HMAC hash хадгална (код өөрөө хадгалагдахгүй).
@Injectable()
export class PrismaOtpRepository extends OtpRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) { super(); }

  async insertOtp(o: OtpRecord): Promise<OtpRecord> {
    return otpToRecord(await this.prisma.posLeaseOtp.create({ data: otpToCreate(o) }));
  }

  async saveOtp(o: OtpRecord): Promise<OtpRecord> {
    if (!isUuid(o.id)) throw new DomainError('NOT_FOUND', 'otp not found');
    const row = await this.prisma.$transaction(async (tx) => {
      const res = await tx.posLeaseOtp.updateMany({ where: { id: o.id, orgId: o.orgId }, data: otpMutable(o) });
      if (res.count === 0) throw new DomainError('NOT_FOUND', 'otp not found');
      return tx.posLeaseOtp.findUniqueOrThrow({ where: { id: o.id } });
    });
    return otpToRecord(row);
  }

  /** Хамгийн сүүлд илгээсэн (sentAt); ижил sentAt бол хамгийн сүүлд бичигдсэн. */
  async latestOtp(leaseId: string, purpose: OtpRecord['purpose']): Promise<OtpRecord | null> {
    if (!isUuid(leaseId)) return null;
    const row = await this.prisma.posLeaseOtp.findFirst({ where: { leaseId, purpose }, orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }] });
    return row ? otpToRecord(row) : null;
  }

  async countOtps(leaseId: string): Promise<number> {
    if (!isUuid(leaseId)) return 0;
    return this.prisma.posLeaseOtp.count({ where: { leaseId } });
  }

  /** `attempts = attempts + 1` нь нэг SQL UPDATE (WHERE-ийг мөр түгжсэний дараа дахин үнэлнэ) тул зэрэгцээ хүсэлт хязгаараас хэтрэхгүй. */
  async registerOtpAttempt(otp: Pick<OtpRecord, 'id' | 'orgId'>, maxAttempts: number): Promise<number | null> {
    if (!isUuid(otp.id)) return null;
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.posLeaseOtp.updateMany({
        where: { id: otp.id, orgId: otp.orgId, verifiedAt: null, attempts: { lt: maxAttempts } },
        data: { attempts: { increment: 1 } },
      });
      if (res.count === 0) return null;
      return (await tx.posLeaseOtp.findUniqueOrThrow({ where: { id: otp.id }, select: { attempts: true } })).attempts; // мөр бидэнд түгжээтэй
    });
  }

  async markOtpVerified(otp: Pick<OtpRecord, 'id' | 'orgId'>, at: Date): Promise<boolean> {
    if (!isUuid(otp.id)) return false;
    const res = await this.prisma.posLeaseOtp.updateMany({ where: { id: otp.id, orgId: otp.orgId, verifiedAt: null }, data: { verifiedAt: at } });
    return res.count === 1;
  }
}
