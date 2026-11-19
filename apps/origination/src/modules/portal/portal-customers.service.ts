import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { PortalCustomerLookup, PortalOtpRequest, PortalProfile, normalizeRegisterNo, type RequestContext } from '@los/contracts';
import { blindIndex } from '@los/database';
import { z } from 'zod';
import type { SmsGateway } from '../../integrations/sms/sms.gateway';
import { SMS_GATEWAY } from '../../integrations/sms/sms.provider';
import { PrismaService } from '../../prisma.service';
import { normalizeMnPhone } from '../notification/phone';
import { portalError } from './portal-errors';
import { PORTAL_VISIBLE_STATUSES } from './portal-loans.service';
import { displayName, maskPhone } from './portal-mask';

/** portal-bff RealOtpSender-ийн бие: `{ code, ttlSec }`. Код зөвхөн SMS-ийн текстэд — лог/аудит/хариунд хэзээ ч биш. */
export const PortalOtpSendBody = z.object({ code: z.string().regex(/^\d{6}$/), ttlSec: z.number().int().min(30).max(3600) }).strict();

/** PRT-FR-1: нэвтрэлтийн lookup, профайл, OTP SMS (docs/05 §6). */
@Injectable()
export class PortalCustomersService {
  private readonly logger = new Logger('PortalCustomers');

  constructor(private readonly prisma: PrismaService, @Inject(SMS_GATEWAY) private readonly sms: SmsGateway) {}

  /**
   * Регистр + БҮРТГЭЛТЭЙ утас таарсан, ≥1 харагдах (ACTIVE/CLOSED/MIGRATED) PRIMARY зээлтэй харилцагч.
   * PRT-FR-1.4: таарахгүй бүх тохиолдол (регистр/утас/зээл) ИЖИЛ 404 `NOT_FOUND` — аль нь буруу болохыг задруулахгүй.
   */
  async lookup(ctx: RequestContext, body: unknown): Promise<PortalCustomerLookup> {
    const parsed = PortalOtpRequest.safeParse(body);
    if (!parsed.success) throw portalError.invalid();
    const { registerNo, phone } = parsed.data;
    const customer = await this.prisma.customer.findUnique({
      where: { orgId_registerNoHash: { orgId: ctx.orgId, registerNoHash: blindIndex(normalizeRegisterNo(registerNo)) } },
      select: { id: true, phone: true, lastName: true, firstName: true },
    });
    const phoneMatches = !!customer && normalizeMnPhone(customer.phone) !== null && normalizeMnPhone(customer.phone) === normalizeMnPhone(phone);
    if (!customer || !phoneMatches || !(await this.hasEligibleLoan(ctx.orgId, customer.id))) throw portalError.notFound();
    return PortalCustomerLookup.parse({ customerId: customer.id, displayName: displayName(customer) });
  }

  async profile(ctx: RequestContext): Promise<PortalProfile> {
    const customer = await this.findSelf(ctx);
    return PortalProfile.parse({ displayName: displayName(customer), phoneMasked: maskPhone(customer.phone) });
  }

  /** POST /otp: lookup-аар тодорхойлогдсон харилцагчийн бүртгэлтэй утас руу. Утас/зээлгүй бол 404 (portal-bff арын ажилд аудитлана). */
  async sendOtp(ctx: RequestContext, body: unknown): Promise<Record<string, never>> {
    const parsed = PortalOtpSendBody.safeParse(body);
    if (!parsed.success) throw portalError.invalid();
    const customer = await this.findSelf(ctx);
    const to = normalizeMnPhone(customer.phone);
    if (!to || !(await this.hasEligibleLoan(ctx.orgId, customer.id))) throw portalError.notFound();
    const minutes = Math.max(1, Math.round(parsed.data.ttlSec / 60));
    try {
      await this.sms.send({ to, reference: `portal-otp-${randomUUID()}`, text: `Нэвтрэх код: ${parsed.data.code}. ${minutes} минут хүчинтэй. Кодыг хэнд ч бүү өгнө үү.` });
    } catch (e) {
      // Код, утас лог-д орохгүй — зөвхөн алдааны төрөл
      this.logger.warn({ msg: 'portal otp sms failed', correlationId: ctx.correlationId, error: e instanceof Error ? e.name : 'unknown' });
      throw new HttpException({ code: 'SMS_UNAVAILABLE' }, 503);
    }
    return {};
  }

  private async findSelf(ctx: RequestContext) {
    const customer = ctx.customerId
      ? await this.prisma.customer.findFirst({ where: { id: ctx.customerId, orgId: ctx.orgId }, select: { id: true, phone: true, lastName: true, firstName: true } })
      : null;
    if (!customer) throw portalError.notFound();
    return customer;
  }

  private async hasEligibleLoan(orgId: string, customerId: string): Promise<boolean> {
    const link = await this.prisma.loanApplicationBorrower.findFirst({
      where: { customerId, role: 'PRIMARY', application: { orgId, status: { in: PORTAL_VISIBLE_STATUSES } } }, select: { id: true },
    });
    return !!link;
  }
}
