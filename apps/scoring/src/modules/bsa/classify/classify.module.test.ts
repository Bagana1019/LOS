// ClassifyModule — DI (explicit), stateless ClassifierService wrapper.
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ClassifyModule } from './classify.module';
import { ClassifierService } from './classify.service';
import { DEFAULT_BSA_CATEGORIES } from './default-catalog';
import { expenseTxn, incomeTxn, makeCtx } from './testing/factories';

describe('ClassifyModule', () => {
  it('provides and exports a stateless ClassifierService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ClassifyModule] }).compile();
    const service = moduleRef.get(ClassifierService);
    expect(service).toBeInstanceOf(ClassifierService);
    expect(moduleRef.get(ClassifierService)).toBe(service); // singleton, төлөвгүй
    await moduleRef.close();
  });

  it('delegates to the pure functions', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ClassifyModule] }).compile();
    const service = moduleRef.get(ClassifierService);
    const txns = [incomeTxn('a', 'Цалин 2026-03'), expenseTxn('b', 'QPay')];
    const results = service.classify(txns, makeCtx());
    expect(results.map((r) => r.categoryCode)).toEqual(['SALARY', 'CHANNEL_EXPENSE']);
    expect(service.detectChannel(txns[1])).toBe('QPAY');
    expect(service.detectOwnTransfers(txns, { ownAccounts: [], customerNames: [] }).findings).toEqual([null, null]);
    const classified = txns.map((txn, i) => ({ txn, result: results[i] }));
    expect(service.otherShare(classified, DEFAULT_BSA_CATEGORIES, 0.3)).toHaveLength(2);
    expect(service.planReclassification({
      txns, selectedKeys: ['a'], targetCategoryCode: 'CASH_INCOME', applyToSimilar: false, similarBy: 'DESCRIPTION', categories: DEFAULT_BSA_CATEGORIES,
    }).affectedKeys).toEqual(['a']);
    expect(service.validateRules([{ direction: 'INCOME', matchType: 'REGEX', pattern: '(a+)+$', categoryCode: 'SALARY', priority: 1, source: 'ADMIN' }], DEFAULT_BSA_CATEGORIES))
      .toHaveLength(1);
    await moduleRef.close();
  });
});
