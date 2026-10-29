// BSA-FR-3.3 / 3.4: reclassify төлөвлөгөө ба bulk дүрэм. Бүх өгөгдөл синтетик.
import { describe, expect, it } from 'vitest';
import { RULE_PRIORITY } from './classify.defaults';
import type { ClassifiableTxn } from './classify.types';
import { DEFAULT_BSA_CATEGORIES } from './default-catalog';
import { counterpartyIdentity, descriptionStem, planReclassification, ReclassifyError, type ReclassifyInput } from './reclassify';
import { expenseTxn, incomeTxn } from './testing/factories';

const plan = (txns: ClassifiableTxn[], over: Partial<ReclassifyInput> & Pick<ReclassifyInput, 'selectedKeys' | 'targetCategoryCode'>) =>
  planReclassification({ txns, applyToSimilar: false, similarBy: 'DESCRIPTION', categories: DEFAULT_BSA_CATEGORIES, ...over });

describe('descriptionStem', () => {
  it('drops dates, numbers and reference numbers: "Цалин 2026-03 #1234" ≡ "Цалин 2026-04 #1299"', () => {
    expect(descriptionStem('Цалин 2026-03 #1234')).toBe('tsalin');
    expect(descriptionStem('Цалин 2026-04 #1299')).toBe('tsalin');
    expect(descriptionStem('Цалин 3-р сар')).toBe(descriptionStem('Цалин 11-р сар'));
    expect(descriptionStem('ЦАЛИН 12.03.2026 14:25')).toBe('tsalin');
  });

  it('is script-insensitive and keeps the order of the remaining words', () => {
    expect(descriptionStem('Tsalin 2026/05 ref123456')).toBe(descriptionStem('Цалин 2026-05 REF987654'));
    expect(descriptionStem('Tsalin 2026/05 ref123456')).toBe('tsalin ref');
    expect(descriptionStem('Зээлийн эргэн төлөлт 15')).toBe('zelin ergen tololt');
  });

  it('keeps the letters of a letters+digits token only when they are meaningful (≥ 3), drops the rest', () => {
    expect(descriptionStem('Цалин цалин2026')).toBe('tsalin tsalin');
    expect(descriptionStem('Цалин AB12')).toBe('tsalin');
    expect(descriptionStem('Цалин REF98765')).toBe('tsalin ref');
  });

  it('returns "" when nothing generalizable remains (digits only, too short, empty)', () => {
    for (const d of ['12345', '2026-03-10', '#1234', '', '   ', null, undefined, 'а', 'аб']) expect(descriptionStem(d as string), String(d)).toBe('');
  });
});

describe('counterpartyIdentity', () => {
  it('prefers the normalized account, then the normalized name', () => {
    expect(counterpartyIdentity({ counterpartyAccount: '5011-234 567', counterpartyName: 'Номин' })).toEqual({ matchType: 'ACCOUNT', value: '5011234567' });
    expect(counterpartyIdentity({ counterpartyAccount: null, counterpartyName: 'Номин ХХК' })).toEqual({ matchType: 'NAME', value: 'nomin hk' });
  });
  it('ignores masked or too short accounts and too short names', () => {
    expect(counterpartyIdentity({ counterpartyAccount: '5011****4567', counterpartyName: null })).toBeNull();
    expect(counterpartyIdentity({ counterpartyAccount: '123', counterpartyName: null })).toBeNull();
    expect(counterpartyIdentity({ counterpartyAccount: null, counterpartyName: 'Аб' })).toBeNull();
    expect(counterpartyIdentity({ counterpartyAccount: null, counterpartyName: null })).toBeNull();
  });
});

describe('planReclassification — selection only', () => {
  const txns = [
    incomeTxn('a', 'Цалин 2026-03 #1234'),
    incomeTxn('b', 'Цалин 2026-04 #1299'),
    incomeTxn('c', 'Бэлэг өгсөн'),
    expenseTxn('d', 'Шатахуун'),
  ];

  it('without applyToSimilar only the selected transactions are affected', () => {
    const p = plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'CASH_INCOME' });
    expect(p.affectedKeys).toEqual(['a']);
    expect(p.selectedKeys).toEqual(['a']);
    expect(p.similarKeys).toEqual([]);
  });

  it('affectedKeys follow the transaction order, not the selection order; duplicate keys are collapsed', () => {
    const p = plan(txns, { selectedKeys: ['c', 'a', 'c'], targetCategoryCode: 'CASH_INCOME' });
    expect(p.affectedKeys).toEqual(['a', 'c']);
  });

  it('still proposes a FEEDBACK rule from the selection (the loop of FR-3.4), independent of applyToSimilar', () => {
    const p = plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'CASH_INCOME' });
    expect(p.suggestedRule).toEqual({
      direction: 'INCOME', matchType: 'KEYWORD', pattern: 'tsalin', categoryCode: 'CASH_INCOME', priority: RULE_PRIORITY.FEEDBACK, source: 'FEEDBACK',
    });
  });
});

describe('planReclassification — similar by DESCRIPTION (bulk rule)', () => {
  const txns = [
    incomeTxn('a', 'Цалин 2026-03 #1234'),
    incomeTxn('b', 'Цалин 2026-04 #1299'),
    incomeTxn('c', 'ЦАЛИН 2026-05'),
    incomeTxn('d', 'Tsalin 2026/06'),
    incomeTxn('e', 'Цалингийн урьдчилгаа'), // өөр үндэс
    incomeTxn('f', 'Бэлэг'),
    expenseTxn('g', 'Цалин 2026-03 #1234'), // чиглэл өөр
    incomeTxn('h', 'Цалин 2026-07', { manualCategoryCode: 'SALARY' }), // өмнөх гар засвар
  ];

  it('applies to every transaction with the same stem and direction, and suggests one KEYWORD rule of the stem', () => {
    const p = plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'BUSINESS_INCOME', applyToSimilar: true });
    expect(p.affectedKeys).toEqual(['a', 'b', 'c', 'd']);
    expect(p.similarKeys).toEqual(['b', 'c', 'd']);
    expect(p.suggestedRule).toMatchObject({ direction: 'INCOME', matchType: 'KEYWORD', pattern: 'tsalin', categoryCode: 'BUSINESS_INCOME', source: 'FEEDBACK', priority: 500 });
  });

  it('does not override earlier manual decisions, other directions or different stems', () => {
    const p = plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'BUSINESS_INCOME', applyToSimilar: true });
    for (const key of ['e', 'f', 'g', 'h']) expect(p.affectedKeys).not.toContain(key);
  });

  it('a manually-overridden transaction that is explicitly selected IS reclassified', () => {
    const p = plan(txns, { selectedKeys: ['h'], targetCategoryCode: 'BUSINESS_INCOME', applyToSimilar: true });
    expect(p.affectedKeys).toEqual(['a', 'b', 'c', 'd', 'h']);
  });

  it('multiple selected transactions with different stems: union of similar groups, but no single rule is suggested', () => {
    const p = plan(txns, { selectedKeys: ['a', 'f'], targetCategoryCode: 'IRREGULAR_INCOME', applyToSimilar: true });
    expect(p.affectedKeys).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(p.suggestedRule).toBeNull();
  });

  it('a non-generalizable description (digits only) affects only the selection and suggests nothing', () => {
    const t = [incomeTxn('a', '12345'), incomeTxn('b', '67890')];
    const p = plan(t, { selectedKeys: ['a'], targetCategoryCode: 'CASH_INCOME', applyToSimilar: true });
    expect(p.affectedKeys).toEqual(['a']);
    expect(p.suggestedRule).toBeNull();
  });
});

describe('planReclassification — similar by COUNTERPARTY', () => {
  const txns = [
    expenseTxn('a', 'Шилжүүлэг 1', { counterpartyAccount: '5011-234-567' }),
    expenseTxn('b', 'Хоол', { counterpartyAccount: '5011 234 567' }),
    expenseTxn('c', 'Хоол', { counterpartyAccount: '5099999999' }),
    expenseTxn('d', 'Төлбөр', { counterpartyName: 'Номин ХХК' }),
    expenseTxn('e', 'Төлбөр', { counterpartyName: 'NOMIN HHK' }),
    expenseTxn('f', 'Төлбөр'),
    incomeTxn('g', 'Орлого', { counterpartyAccount: '5011234567' }),
  ];

  it('same normalized account → same counterparty; COUNTERPARTY rule with the account digits', () => {
    const p = plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'DISCRETIONARY_EXPENSE', applyToSimilar: true, similarBy: 'COUNTERPARTY' });
    expect(p.affectedKeys).toEqual(['a', 'b']);
    expect(p.suggestedRule).toMatchObject({ direction: 'EXPENSE', matchType: 'COUNTERPARTY', pattern: '5011234567', source: 'FEEDBACK', categoryCode: 'DISCRETIONARY_EXPENSE' });
  });

  it('no account → same normalized name (script-insensitive)', () => {
    const p = plan(txns, { selectedKeys: ['d'], targetCategoryCode: 'ESSENTIAL_EXPENSE', applyToSimilar: true, similarBy: 'COUNTERPARTY' });
    expect(p.affectedKeys).toEqual(['d', 'e']);
    expect(p.suggestedRule).toMatchObject({ matchType: 'COUNTERPARTY', pattern: 'nomin hk' });
  });

  it('a selected transaction without any counterparty generalizes to nothing', () => {
    const p = plan(txns, { selectedKeys: ['f'], targetCategoryCode: 'ESSENTIAL_EXPENSE', applyToSimilar: true, similarBy: 'COUNTERPARTY' });
    expect(p.affectedKeys).toEqual(['f']);
    expect(p.suggestedRule).toBeNull();
  });

  it('different counterparties in the selection → no single rule', () => {
    const p = plan(txns, { selectedKeys: ['a', 'd'], targetCategoryCode: 'ESSENTIAL_EXPENSE', applyToSimilar: true, similarBy: 'COUNTERPARTY' });
    expect(p.affectedKeys).toEqual(['a', 'b', 'd', 'e']);
    expect(p.suggestedRule).toBeNull();
  });

  it('never crosses direction (an income from the same account is untouched)', () => {
    const p = plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'DISCRETIONARY_EXPENSE', applyToSimilar: true, similarBy: 'COUNTERPARTY' });
    expect(p.affectedKeys).not.toContain('g');
  });
});

describe('planReclassification — errors', () => {
  const txns = [incomeTxn('a', 'Цалин'), expenseTxn('b', 'Шатахуун')];
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return e instanceof ReclassifyError ? e.code : `other:${String(e)}`;
    }
    return undefined;
  };

  it('rejects an income transaction moved to an expense category (and vice versa) with DIRECTION_MISMATCH', () => {
    expect(code(() => plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'FIXED_EXPENSE' }))).toBe('DIRECTION_MISMATCH');
    expect(code(() => plan(txns, { selectedKeys: ['b'], targetCategoryCode: 'SALARY' }))).toBe('DIRECTION_MISMATCH');
    expect(code(() => plan(txns, { selectedKeys: ['a', 'b'], targetCategoryCode: 'SALARY' }))).toBe('DIRECTION_MISMATCH');
  });

  it('rejects an empty selection, an unknown or inactive target and keys that are not in the transaction list', () => {
    expect(code(() => plan(txns, { selectedKeys: [], targetCategoryCode: 'SALARY' }))).toBe('EMPTY_SELECTION');
    expect(code(() => plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'NOPE' }))).toBe('UNKNOWN_CATEGORY');
    const inactive = DEFAULT_BSA_CATEGORIES.map((c) => (c.code === 'SALARY' ? { ...c, isActive: false } : c));
    expect(code(() => plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'SALARY', categories: inactive }))).toBe('CATEGORY_INACTIVE');
    expect(code(() => plan(txns, { selectedKeys: ['a', 'ghost'], targetCategoryCode: 'SALARY' }))).toBe('SELECTION_NOT_FOUND');
  });

  it('error messages carry no transaction text (PII)', () => {
    try {
      plan([incomeTxn('a', 'Болд Бат 5011234567')], { selectedKeys: ['a'], targetCategoryCode: 'FIXED_EXPENSE' });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Болд|5011/);
      expect((e as Error).name).toBe('ReclassifyError');
    }
  });

  it('a mismatched transaction is rejected even when applyToSimilar would otherwise skip it', () => {
    expect(code(() => plan(txns, { selectedKeys: ['a'], targetCategoryCode: 'FIXED_EXPENSE', applyToSimilar: true }))).toBe('DIRECTION_MISMATCH');
  });
});
