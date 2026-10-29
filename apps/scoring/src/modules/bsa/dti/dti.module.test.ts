// DtiModule — DI холболт ба алдааны замууд (computeBsaDti-д хүрэхээс өмнө зогсох). Бодит тооцоо: dti-integration.test.ts
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BSA_CATEGORIES } from '../classify/default-catalog';
import { incomeTxn } from '../classify/testing/factories';
import { BsaAggregationError } from './aggregate';
import { DtiAnalysisService } from './dti-analysis.service';
import { DtiModule } from './dti.module';
import { toDtiParams } from './dti-params';
import { TEST_SETTINGS } from './testing/fixtures';

describe('DtiModule', () => {
  it('provides and exports DtiAnalysisService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DtiModule] }).compile();
    expect(moduleRef.get(DtiAnalysisService)).toBeInstanceOf(DtiAnalysisService);
    await moduleRef.close();
  });

  it('rejects a bad period and unknown categories before any calculation', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DtiModule] }).compile();
    const service = moduleRef.get(DtiAnalysisService);
    const params = toDtiParams(TEST_SETTINGS, { periodFrom: '2026-03-10', periodTo: '2026-09-10', proposedMonthlyPayment: 0 });
    expect(() => service.analyze({ classified: [], categories: DEFAULT_BSA_CATEGORIES, params: { ...params, periodFrom: '2026-09-10', periodTo: '2026-03-10' } })).toThrow(RangeError);
    const ghost = { txn: incomeTxn('a', 'x', { txnDate: '2026-04-01' }), result: { key: 'a', categoryCode: 'GHOST', categoryGroup: '?', confidence: 1, channel: 'OTHER' as const, isOwnTransfer: false, reason: '' } };
    expect(() => service.analyze({ classified: [ghost], categories: DEFAULT_BSA_CATEGORIES, params })).toThrow(BsaAggregationError);
    await moduleRef.close();
  });
});
