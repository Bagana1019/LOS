import { createHash } from 'node:crypto';
import type { RequestContext } from '@los/contracts';
import type { CreditHistory, CreditHistoryPort } from './credit-history.port';

/**
 * DEMO — бодит ЗМС/FICO биш! `customerId`-ийн hash-аас гаргасан тогтвортой fixture (нэг харилцагч үргэлж ижил утга).
 * Зөвхөн `INTEGRATION_MODE=mock` (анхдагч) үед; бодит горимд `KycCreditHistory` ашиглана (docs/04 «Хүний оролцоо» №1).
 * Утгын муж: FICO 520–819; идэвхтэй зээл 0–3 (нэг зээл ≈ 150–400 мянга ₮/сар); хугацаа хэтэрсэн сар 0–3 (ихэнхдээ 0).
 */
export class MockCreditHistory implements CreditHistoryPort {
  readonly demo = true;

  async get(_ctx: RequestContext, _applicationId: string, customerId: string): Promise<CreditHistory> {
    return mockCreditHistoryFor(customerId);
  }
}

export function mockCreditHistoryFor(customerId: string): CreditHistory {
  const h = createHash('sha256').update(`credit-history-demo:${customerId}`).digest();
  const ficoScore = 520 + (h.readUInt16BE(0) % 300);
  const activeLoanCount = h[2]! % 4;
  const overdueRoll = h[3]! % 10;
  const overdueHistoryMonths = overdueRoll < 7 ? 0 : overdueRoll - 6; // 70% нь 0, үлдсэн нь 1–3
  const perLoan = 150_000 + (h.readUInt16BE(4) % 26) * 10_000; // 150,000 … 400,000
  return { ficoScore, activeLoanCount, overdueHistoryMonths, existingDebtServiceMonthly: activeLoanCount * perLoan };
}
