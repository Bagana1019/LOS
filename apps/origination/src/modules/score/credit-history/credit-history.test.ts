import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@los/contracts';
import { createCreditHistory } from './credit-history.provider';
import { KycCreditHistory } from './kyc-credit-history';
import { MockCreditHistory, mockCreditHistoryFor } from './mock-credit-history';

const ctx: RequestContext = { userId: 'u1', roles: ['OFFICER'], branchId: 'b1', orgId: 'o1', customerId: null, correlationId: 'corr-1' };
afterEach(() => vi.restoreAllMocks());

describe('MockCreditHistory (DEMO)', () => {
  it('нэг харилцагчид үргэлж ижил, deterministic fixture өгнө (applicationId, дуудлагын тооноос үл хамаарна)', async () => {
    const mock = new MockCreditHistory();
    const a = await mock.get(ctx, 'app-1', 'customer-1');
    expect(await mock.get(ctx, 'app-2', 'customer-1')).toEqual(a);
    expect(await new MockCreditHistory().get(ctx, 'app-1', 'customer-1')).toEqual(a);
    expect(a).toEqual(mockCreditHistoryFor('customer-1'));
  });

  it('өөр харилцагчид өөр утга гарч болно, бүгд баримтжуулсан мужид', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const h = mockCreditHistoryFor(`customer-${i}`);
      seen.add(JSON.stringify(h));
      expect(h.ficoScore).toBeGreaterThanOrEqual(520);
      expect(h.ficoScore).toBeLessThanOrEqual(819);
      expect(Number.isInteger(h.activeLoanCount)).toBe(true);
      expect(h.activeLoanCount).toBeGreaterThanOrEqual(0);
      expect(h.activeLoanCount).toBeLessThanOrEqual(3);
      expect(h.overdueHistoryMonths).toBeGreaterThanOrEqual(0);
      expect(h.overdueHistoryMonths).toBeLessThanOrEqual(3);
      // идэвхтэй зээлгүй бол өрийн төлбөр 0; зээл бүр 150–400 мянга
      if (h.activeLoanCount === 0) expect(h.existingDebtServiceMonthly).toBe(0);
      else {
        expect(h.existingDebtServiceMonthly! / h.activeLoanCount!).toBeGreaterThanOrEqual(150_000);
        expect(h.existingDebtServiceMonthly! / h.activeLoanCount!).toBeLessThanOrEqual(400_000);
      }
    }
    expect(seen.size).toBeGreaterThan(50);
  });

  it('DEMO гэж тэмдэглэгдсэн; нэг fixture-ийг тогтмол утгаар баталгаажуулна (hash өөрчлөгдвөл тест мэдэгдэнэ)', () => {
    expect(new MockCreditHistory().demo).toBe(true);
    expect(mockCreditHistoryFor('customer-1')).toEqual({ ficoScore: 636, activeLoanCount: 3, overdueHistoryMonths: 0, existingDebtServiceMonthly: 1_020_000 });
  });
});

describe('KycCreditHistory (real горим, Модуль 3 хүртэл)', () => {
  it('null буцаана — зохиомол утга хэзээ ч өгөхгүй', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(new KycCreditHistory().get(ctx, 'app-1', 'customer-1')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('not available');
  });

  it('анхааруулгыг нэг instance-д нэг л удаа логлоно; харилцагчийн id логт орохгүй', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const port = new KycCreditHistory();
    await port.get(ctx, 'app-1', 'customer-SECRET');
    await port.get(ctx, 'app-1', 'customer-SECRET');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('customer-SECRET');
  });
});

describe('createCreditHistory · INTEGRATION_MODE', () => {
  it('анхдагч (env-гүй) = mock', () => {
    expect(createCreditHistory({})).toBeInstanceOf(MockCreditHistory);
    expect(createCreditHistory({ INTEGRATION_MODE: 'mock' })).toBeInstanceOf(MockCreditHistory);
  });
  it('INTEGRATION_MODE=real → KycCreditHistory; INTEGRATION_MODE_CREDIT_HISTORY тусад нь солино', () => {
    expect(createCreditHistory({ INTEGRATION_MODE: 'real' })).toBeInstanceOf(KycCreditHistory);
    expect(createCreditHistory({ INTEGRATION_MODE_CREDIT_HISTORY: 'real' })).toBeInstanceOf(KycCreditHistory);
    expect(createCreditHistory({ INTEGRATION_MODE: 'real', INTEGRATION_MODE_CREDIT_HISTORY: 'mock' })).toBeInstanceOf(MockCreditHistory);
  });
  it('буруу утга → тодорхой алдаа', () => {
    expect(() => createCreditHistory({ INTEGRATION_MODE: 'live' })).toThrow(/credit-history/);
  });
});
