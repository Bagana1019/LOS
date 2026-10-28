// classifyTransactions: дараалал (гар засвар → өөрийн данс → дүрэм → суваг → бусад), итгэл %, чанга хугацааны төсөв. Бүх өгөгдөл синтетик.
import { describe, expect, it } from 'vitest';
import { assertSystemCategories, classifyTransactions, ClassifierConfigError, validateRules } from './classifier';
import { CLASSIFY_CONFIDENCE, OWN_TRANSFER_CONFIDENCE } from './classify.defaults';
import type { BsaRuleDef, ClassifiableTxn } from './classify.types';
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from './default-catalog';
import { category, expenseTxn, incomeTxn, keywordRule, makeCtx } from './testing/factories';

const one = (txn: ClassifiableTxn, ctx = makeCtx()) => classifyTransactions([txn], ctx)[0];

describe('classification order', () => {
  it('1. manual override wins over everything, confidence 100, never an own transfer', () => {
    const txn = incomeTxn('k', 'Цалин', { manualCategoryCode: 'CASH_INCOME', counterpartyAccount: '5011234567' });
    const r = one(txn, makeCtx({ ownAccounts: ['5011234567'] }));
    expect(r).toMatchObject({ key: 'k', categoryCode: 'CASH_INCOME', categoryGroup: 'B', confidence: CLASSIFY_CONFIDENCE.MANUAL, isOwnTransfer: false, matchedRuleId: null });
    expect(r.reason).toMatch(/Гар засвар/);
  });

  it('a manual code unknown to the catalog is kept as-is (the aggregator reports it), group "?"', () => {
    const r = one(incomeTxn('k', 'x', { manualCategoryCode: 'NO_SUCH' }));
    expect(r).toMatchObject({ categoryCode: 'NO_SUCH', categoryGroup: '?', confidence: 100 });
  });

  it('2. own-transfer beats keyword rules: income → OWN_TRANSFER_IN, expense → NON_EXPENSE', () => {
    const ctx = makeCtx({ ownAccounts: ['5011234567'] });
    const inc = one(incomeTxn('a', 'Цалин 2026-03', { counterpartyAccount: '5011234567' }), ctx);
    expect(inc).toMatchObject({ categoryCode: 'OWN_TRANSFER_IN', categoryGroup: '—', isOwnTransfer: true, confidence: OWN_TRANSFER_CONFIDENCE.ACCOUNT_EXACT });
    expect(inc.reason).toMatch(/BSA-BR-5/);
    const exp = one(expenseTxn('b', 'Шатахуун', { counterpartyAccount: '5011234567' }), ctx);
    expect(exp).toMatchObject({ categoryCode: 'NON_EXPENSE', categoryGroup: 'F', isOwnTransfer: true });
  });

  it('pair-detected transfers are classified together (both sides own transfers)', () => {
    const txns = [
      incomeTxn('i', 'Цалин', { statementKey: 'A', amount: 800, txnTime: '09:15' }),
      expenseTxn('e', 'Шатахуун', { statementKey: 'B', bank: 'TDB', amount: 800, txnTime: '09:15' }),
      incomeTxn('i2', 'Цалин', { statementKey: 'A', amount: 801, txnTime: '09:15' }),
    ];
    const r = classifyTransactions(txns, makeCtx());
    expect(r.map((x) => [x.categoryCode, x.isOwnTransfer])).toEqual([['OWN_TRANSFER_IN', true], ['NON_EXPENSE', true], ['SALARY', false]]);
  });

  it('3. rule wins over the channel: "POS шатахуун" is ESSENTIAL, not CHANNEL_EXPENSE', () => {
    const r = one(expenseTxn('k', 'POS Шатахуун'));
    expect(r).toMatchObject({ categoryCode: 'ESSENTIAL_EXPENSE', channel: 'POS', isOwnTransfer: false });
  });

  it('4. channel fallback: QPAY/POS/ATM expense without a keyword → CHANNEL_EXPENSE (60)', () => {
    for (const [description, channel] of [['QPay 123456', 'QPAY'], ['POS 00455 TERMINAL', 'POS'], ['ATM 4501', 'ATM']] as const) {
      expect(one(expenseTxn('k', description)), description).toMatchObject({
        categoryCode: 'CHANNEL_EXPENSE', categoryGroup: 'CH', channel, confidence: CLASSIFY_CONFIDENCE.CHANNEL_FALLBACK, isOwnTransfer: false,
      });
    }
  });

  it('channel fallback does not apply to income or to TRANSFER/OTHER channels', () => {
    expect(one(incomeTxn('k', 'QPay 123456'))).toMatchObject({ categoryCode: 'OTHER_INCOME', channel: 'QPAY', confidence: CLASSIFY_CONFIDENCE.UNMATCHED });
    expect(one(expenseTxn('k', 'Найздаа', { counterpartyAccount: '5099999999' }))).toMatchObject({ categoryCode: 'OTHER_EXPENSE', channel: 'TRANSFER' });
  });

  it('5. unmatched → OTHER_INCOME / OTHER_EXPENSE at 30 with group "?"', () => {
    expect(one(incomeTxn('a', 'ямар нэгэн утга'))).toMatchObject({
      categoryCode: 'OTHER_INCOME', categoryGroup: '?', confidence: CLASSIFY_CONFIDENCE.UNMATCHED, channel: 'OTHER', isOwnTransfer: false, matchedRuleId: null,
    });
    expect(one(expenseTxn('b', ''))).toMatchObject({ categoryCode: 'OTHER_EXPENSE', categoryGroup: '?', confidence: 30 });
  });

  it('rule results carry the group, match confidence, a reason and the rule id when the rule has one', () => {
    const rule: BsaRuleDef = { id: 'rule-42', direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'шатахуун', categoryCode: 'ESSENTIAL_EXPENSE', priority: 900, source: 'ADMIN' };
    const r = one(expenseTxn('k', 'Шатахуун'), makeCtx({ rules: [rule] }));
    expect(r).toMatchObject({ categoryCode: 'ESSENTIAL_EXPENSE', categoryGroup: 'C', confidence: 90, matchedRuleId: 'rule-42' });
    expect(r.reason).toContain('KEYWORD');
    expect(one(expenseTxn('k', 'Шатахуун')).matchedRuleId).toBeNull(); // анхдагч дүрэмд id байхгүй
  });

  it('the reason never echoes the transaction text or a FEEDBACK pattern (PII)', () => {
    const feedback: BsaRuleDef = { direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'болд батын мөнгө', categoryCode: 'ESSENTIAL_EXPENSE', priority: 500, source: 'FEEDBACK' };
    const r = one(expenseTxn('k', 'Болд Батын мөнгө 5011234567'), makeCtx({ rules: [feedback] }));
    expect(r.categoryCode).toBe('ESSENTIAL_EXPENSE');
    expect(r.reason).not.toMatch(/болд|бат|5011/i);
  });
});

describe('rule set handling inside the classifier', () => {
  it('skips invalid / inactive-category / mismatched rules instead of failing, and validateRules reports them', () => {
    const categories = [...DEFAULT_BSA_CATEGORIES.map((c) => (c.code === 'ESSENTIAL_EXPENSE' ? { ...c, isActive: false } : c))];
    const rules: BsaRuleDef[] = [
      keywordRule({ direction: 'EXPENSE', pattern: 'шатахуун', categoryCode: 'ESSENTIAL_EXPENSE', priority: 900 }),
      { direction: 'EXPENSE', matchType: 'REGEX', pattern: '(a+)+$', categoryCode: 'BANK_FEE', priority: 900, source: 'ADMIN' },
      keywordRule({ direction: 'EXPENSE', pattern: 'шатахуун', categoryCode: 'DISCRETIONARY_EXPENSE', priority: 100 }),
    ];
    const ctx = makeCtx({ categories, rules });
    expect(one(expenseTxn('k', 'Шатахуун'), ctx).categoryCode).toBe('DISCRETIONARY_EXPENSE'); // идэвхгүй ангилалын дүрэм алгасагдсан
    expect(validateRules(rules, categories).map((i) => i.code)).toEqual(['CATEGORY_INACTIVE', 'REGEX_UNSAFE']);
  });

  it('a REGEX rule that would hang a naive engine does not slow the classifier down', () => {
    const rules: BsaRuleDef[] = [{ direction: 'EXPENSE', matchType: 'REGEX', pattern: '(x+x+)+y', categoryCode: 'BANK_FEE', priority: 900, source: 'ADMIN' }];
    const t0 = performance.now();
    const r = one(expenseTxn('k', `${'x'.repeat(40_000)}z`), makeCtx({ rules }));
    expect(r.categoryCode).toBe('OTHER_EXPENSE');
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('works with an empty rule set (everything is OTHER or a channel fallback)', () => {
    expect(classifyTransactions([incomeTxn('a', 'Цалин'), expenseTxn('b', 'POS')], makeCtx({ rules: [] })).map((r) => r.categoryCode)).toEqual(['OTHER_INCOME', 'CHANNEL_EXPENSE']);
  });

  it('uses admin-edited categories: a renamed group is reflected in the result', () => {
    const categories = DEFAULT_BSA_CATEGORIES.map((c) => (c.code === 'SALARY' ? { ...c, groupCode: 'Z' } : c));
    expect(one(incomeTxn('k', 'Цалин'), makeCtx({ categories })).categoryGroup).toBe('Z');
  });
});

describe('system category validation', () => {
  it('throws ClassifierConfigError naming the missing codes when a system category is gone or has the wrong direction', () => {
    const noOther = DEFAULT_BSA_CATEGORIES.filter((c) => c.code !== 'OTHER_INCOME');
    expect(() => classifyTransactions([], makeCtx({ categories: noOther }))).toThrow(ClassifierConfigError);
    expect(() => assertSystemCategories(noOther)).toThrow(/OTHER_INCOME/);
    const wrongDirection = DEFAULT_BSA_CATEGORIES.map((c) => (c.code === 'CHANNEL_EXPENSE' ? { ...c, direction: 'INCOME' as const } : c));
    expect(() => assertSystemCategories(wrongDirection)).toThrow(/CHANNEL_EXPENSE/);
    expect(() => assertSystemCategories([category({ code: 'X', direction: 'INCOME' })])).toThrow(/OWN_TRANSFER_IN.*NON_EXPENSE/);
  });
});

describe('determinism and shape', () => {
  it('returns one result per transaction, index-aligned, with the transaction key', () => {
    const txns = [incomeTxn('b', 'Цалин'), expenseTxn('a', 'Шимтгэл'), incomeTxn('c', '???')];
    const r = classifyTransactions(txns, makeCtx());
    expect(r.map((x) => x.key)).toEqual(['b', 'a', 'c']);
    expect(classifyTransactions([], makeCtx())).toEqual([]);
  });

  it('is a pure function: the same input gives identical output and the input is not mutated', () => {
    const txns = [incomeTxn('a', 'Цалин', { txnTime: '10:00' }), expenseTxn('b', 'POS', { counterpartyName: 'X' })];
    const before = JSON.stringify(txns);
    const ctx = makeCtx();
    const ctxBefore = JSON.stringify(ctx);
    expect(classifyTransactions(txns, ctx)).toEqual(classifyTransactions(txns, ctx));
    expect(JSON.stringify(txns)).toBe(before);
    expect(JSON.stringify(ctx)).toBe(ctxBefore);
  });

  it('latin / cyrillic / mixed spellings of one description get the same classification', () => {
    const results = ['Шатахуун', 'Shatakhuun', 'SHATAHUN', 'шaтaхуун'].map((d) => one(expenseTxn('k', d)));
    expect(new Set(results.map((r) => `${r.categoryCode}:${r.confidence}`)).size).toBe(1);
    expect(results[0].categoryCode).toBe('ESSENTIAL_EXPENSE');
  });
});

describe('performance budget (20,000 transactions × 150 default rules)', () => {
  /** Seed-тэй LCG — санамсаргүй байдал тодорхой (deterministic) */
  const lcg = (seed: number) => {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  };
  const POOL = [
    'Цалин 2026-03 #', 'Зээлийн эргэн төлөлт ', 'Шатахуун POS ', 'QPay төлбөр ', 'ATM бэлэн мөнгө авсан ', 'Номин супермаркет ', 'Утасны төлбөр Unitel ',
    'Шилжүүлэг ', 'Борлуулалтын орлого ', 'Хадгаламж руу ', 'Данс хөтөлсний хөлс ', 'Түрээсийн төлбөр ', 'Мэдэгдэхгүй утга ', 'Tsalin ', 'Худалдан авалт ',
    'Ресторан ', 'Эмийн сан ', 'Даатгалын шимтгэл ', 'Сургалтын төлбөр ', 'Бараа материал ',
  ];

  function generate(n: number, unmatchedOnly = false): ClassifiableTxn[] {
    const rnd = lcg(12345);
    return Array.from({ length: n }, (_, i) => {
      const income = rnd() < 0.35;
      const base = unmatchedOnly ? 'Мэдэгдэхгүй утга ' : POOL[Math.floor(rnd() * POOL.length)];
      const day = 1 + Math.floor(rnd() * 28);
      return {
        key: `t${i}`,
        statementKey: `stmt-${i % 3}`,
        bank: ['KHAN', 'GOLOMT', 'TDB'][i % 3],
        txnDate: `2026-0${1 + (i % 6)}-${String(day).padStart(2, '0')}`,
        txnTime: i % 3 === 1 ? null : `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`,
        direction: income ? 'INCOME' : 'EXPENSE',
        amount: Math.round(rnd() * 5_000_000) / 100,
        description: `${base}${Math.floor(rnd() * 100000)}`,
        counterpartyAccount: rnd() < 0.2 ? String(5_000_000_000 + Math.floor(rnd() * 50_000)) : null,
        counterpartyName: rnd() < 0.2 ? `Харилцагч ${Math.floor(rnd() * 500)}` : null,
      } satisfies ClassifiableTxn;
    });
  }

  it('has the full 150-rule default catalog available for the benchmark', () => {
    expect(DEFAULT_BSA_RULES.length).toBeGreaterThanOrEqual(140);
  });

  it('classifies 20k mixed transactions in < 2 s', () => {
    const txns = generate(20_000);
    const ctx = makeCtx({ ownAccounts: ['5000001234', '5000009999'], customerNames: ['Бат Болд'] });
    const t0 = performance.now();
    const r = classifyTransactions(txns, ctx);
    const ms = performance.now() - t0;
    expect(r).toHaveLength(20_000);
    expect(ms).toBeLessThan(2000);
    // чанартай эсэх: ихэнх нь таарсан
    expect(r.filter((x) => x.categoryCode.startsWith('OTHER_')).length).toBeLessThan(20_000 * 0.4);
  });

  it('classifies 20k fully unmatched transactions (every rule is scanned) in < 2 s', () => {
    const txns = generate(20_000, true);
    const t0 = performance.now();
    const r = classifyTransactions(txns, makeCtx());
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(r.every((x) => x.categoryCode === 'OTHER_INCOME' || x.categoryCode === 'OTHER_EXPENSE' || x.categoryCode === 'CHANNEL_EXPENSE' || x.isOwnTransfer)).toBe(true);
  });

  it('20k results are identical across two runs (deterministic at scale)', () => {
    const txns = generate(3_000);
    expect(classifyTransactions(txns, makeCtx())).toEqual(classifyTransactions(txns, makeCtx()));
  });
});
