// Тестийн туслахууд. БҮХ ӨГӨГДӨЛ СИНТЕТИК: нэр, данс, утга зохиомол; бодит хүн/хуулга байхгүй.
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from '../default-catalog';
import type { BsaCategoryDef, BsaRuleDef, ClassifiableTxn, ClassificationContext, ClassifiedTxn } from '../classify.types';
import { classifyTransactions } from '../classifier';

export function makeTxn(over: Partial<ClassifiableTxn> & { key: string }): ClassifiableTxn {
  return {
    statementKey: 'stmt-1',
    bank: 'KHAN',
    txnDate: '2026-03-10',
    txnTime: null,
    direction: 'EXPENSE',
    amount: 1000,
    description: '',
    counterpartyAccount: null,
    counterpartyName: null,
    ...over,
  };
}

export const incomeTxn = (key: string, description: string, over: Partial<ClassifiableTxn> = {}): ClassifiableTxn =>
  makeTxn({ key, direction: 'INCOME', description, ...over });
export const expenseTxn = (key: string, description: string, over: Partial<ClassifiableTxn> = {}): ClassifiableTxn =>
  makeTxn({ key, direction: 'EXPENSE', description, ...over });

export function makeCtx(over: Partial<ClassificationContext> = {}): ClassificationContext {
  return { categories: DEFAULT_BSA_CATEGORIES, rules: DEFAULT_BSA_RULES, ownAccounts: [], customerNames: [], ...over };
}

export function keywordRule(over: Partial<BsaRuleDef> & Pick<BsaRuleDef, 'pattern' | 'categoryCode' | 'direction'>): BsaRuleDef {
  return { matchType: 'KEYWORD', priority: 200, source: 'ADMIN', ...over };
}

export function category(over: Partial<BsaCategoryDef> & Pick<BsaCategoryDef, 'code' | 'direction'>): BsaCategoryDef {
  return { groupCode: 'T', name: over.code, weight: 1, dtiRole: over.direction === 'INCOME' ? 'INCOME' : 'INFO', isActive: true, ...over };
}

/** Ангилагчаар ангилаад { txn, result } хосууд болгоно */
export function classifyAll(txns: ClassifiableTxn[], ctx: ClassificationContext = makeCtx()): ClassifiedTxn[] {
  const results = classifyTransactions(txns, ctx);
  return txns.map((txn, i) => ({ txn, result: results[i] }));
}
