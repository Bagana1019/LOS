import { Logger } from '@nestjs/common';
import type { RequestContext } from '@los/contracts';
import type { CreditHistory, CreditHistoryPort } from './credit-history.port';

/**
 * Бодит горим: kyc-ийн лавлагааны хураангуй (ЗМС/FICO) endpoint Модуль 3-аас өмнө байхгүй тул одоогоор `null` — «мэдэгдэхгүй».
 * Зохиомол утга ХЭЗЭЭ Ч өгөхгүй: Sosco-ийн холбогдох бүрэлдэхүүн, идэвхтэй өрийн ЗМС-ийн хэсэг тооцоонд орохгүй (BSA-ийн өр л үлдэнэ).
 */
export class KycCreditHistory implements CreditHistoryPort {
  private readonly logger = new Logger(KycCreditHistory.name);
  private warned = false;

  async get(ctx: RequestContext, applicationId: string, _customerId: string): Promise<CreditHistory | null> {
    // TODO(M03): origination → kyc `GET /api/inquiry/summary` (ЗМС, FICO, идэвхтэй зээл, хугацаа хэтрэлт) дуудаж CreditHistory болгон хөрвүүлнэ.
    if (!this.warned) {
      this.warned = true; // нэг процесст нэг удаа — дуудлага бүрт лог дүүргэхгүй
      this.logger.warn({ msg: 'credit history is not available in real mode until Module 3 (kyc inquiry summary)', applicationId, correlationId: ctx.correlationId });
    }
    return null;
  }
}
