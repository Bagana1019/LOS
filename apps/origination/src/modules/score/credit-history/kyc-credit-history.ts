import { Logger } from '@nestjs/common';
import type { RequestContext } from '@los/contracts';
import { createKycInquiryPort, type KycInquiryPort } from '../../inquiry/ports/kyc-inquiry.port';
import type { CreditHistory, CreditHistoryPort } from './credit-history.port';

/**
 * Бодит горим (FR-3, Модуль 3): kyc-ийн лавлагааны хураангуй (`GET /api/inquiry/credit-history`) — энэ хүсэлтэд татсан ЗМС/FICO-ийн хамгийн сүүлийн мөр
 * + гараар оруулсан бүртгэлгүй зээл. Лавлагаа татаагүй талбар `null` ("мэдэгдэхгүй") — зохиомол утга ХЭЗЭЭ Ч өгөхгүй.
 * kyc унасан/хугацаа хэтэрсэн бол мөн `null` (тооцоолол унахгүй; ЗМС-ийн хэсэг тооцоонд орохгүй, BSA-ийн өр л үлдэнэ) — харин лог-д анхааруулга бичнэ.
 */
export class KycCreditHistory implements CreditHistoryPort {
  private readonly logger = new Logger(KycCreditHistory.name);

  constructor(private readonly kyc: KycInquiryPort = createKycInquiryPort()) {}

  async get(ctx: RequestContext, applicationId: string, customerId: string): Promise<CreditHistory | null> {
    try {
      return await this.kyc.creditHistory(ctx, applicationId, customerId);
    } catch (e) {
      // Харилцагчийн id, регистр лог-д орохгүй (CLAUDE.md §6.5); applicationId + correlationId л.
      this.logger.warn({ msg: 'credit history unavailable from kyc, treating as unknown', applicationId, correlationId: ctx.correlationId, error: e instanceof Error ? e.name : 'unknown' });
      return null;
    }
  }
}
