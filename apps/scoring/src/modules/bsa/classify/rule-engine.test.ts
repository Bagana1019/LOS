// Rule engine: эрэмбэ, тааруулалт, итгэл %, буруу дүрмийн алгасалт. Бүх текст синтетик.
import { describe, expect, it } from 'vitest';
import { CLASSIFY_CONFIDENCE, RULE_PRIORITY } from './classify.defaults';
import type { BsaRuleDef } from './classify.types';
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from './default-catalog';
import { prepareTxn } from './normalize';
import { compileRuleSet, evaluateRules } from './rule-engine';
import { category, expenseTxn, incomeTxn, keywordRule } from './testing/factories';

const defaultSet = compileRuleSet(DEFAULT_BSA_RULES, DEFAULT_BSA_CATEGORIES);
const run = (txn: ReturnType<typeof incomeTxn>, set = defaultSet) => evaluateRules(prepareTxn(txn), set);

describe('default rule set against realistic Mongolian descriptions', () => {
  it('compiles without issues', () => {
    expect(defaultSet.issues).toEqual([]);
  });

  type Row = [direction: 'INCOME' | 'EXPENSE', description: string, expectedCategory: string, expectedConfidence: number];
  const rows: Row[] = [
    // орлого
    ['INCOME', 'Цалин 2026-03', 'SALARY', 90],
    ['INCOME', 'ЦАЛИН 3-Р САР', 'SALARY', 90],
    ['INCOME', 'Tsalin 2026/04', 'SALARY', 90],
    ['INCOME', 'Сарын цалин', 'SALARY', 90],
    ['INCOME', 'Цалингийн урьдчилгаа', 'SALARY', 85],
    ['INCOME', 'Урамшуулал 2026-05', 'SALARY', 90],
    ['INCOME', 'Ажлын хөлс', 'SALARY', 90],
    ['INCOME', 'Гэрээний хөлс 12-р сар', 'CONTRACT_INCOME', 90],
    ['INCOME', 'Үйлчилгээний хөлс', 'CONTRACT_INCOME', 90],
    ['INCOME', 'Түрээсийн орлого', 'PASSIVE_INCOME', 85],
    ['INCOME', 'Ногдол ашгийн төлбөр', 'PASSIVE_INCOME', 90],
    ['INCOME', 'Тэтгэвэр', 'PASSIVE_INCOME', 90],
    ['INCOME', 'Тэтгэврийн мөнгө', 'PASSIVE_INCOME', 85],
    ['INCOME', 'Тэтгэмж', 'PASSIVE_INCOME', 90],
    ['INCOME', 'Хүү', 'PASSIVE_INCOME', 90],
    ['INCOME', 'Борлуулалтын орлого', 'BUSINESS_INCOME', 85],
    ['INCOME', 'Бараа борлуулалт #1234', 'BUSINESS_INCOME', 90],
    ['INCOME', 'QPay тооцоо', 'BUSINESS_INCOME', 90],
    ['INCOME', 'Бэлэн мөнгө байршуулсан', 'CASH_INCOME', 90],
    ['INCOME', 'Зээл олголт', 'LOAN_PROCEEDS', 90],
    ['INCOME', 'Зээлийн олголт 5011', 'LOAN_PROCEEDS', 90],
    ['INCOME', 'Цалингийн зээл', 'LOAN_PROCEEDS', 90], // 'цалин'-аас давуу
    ['INCOME', 'Буцаалт', 'NON_INCOME', 90],
    ['INCOME', 'Залруулга', 'NON_INCOME', 90],
    ['INCOME', 'Буцаалт: цалин', 'NON_INCOME', 90], // STRONG > NORMAL
    ['INCOME', 'Хандив', 'IRREGULAR_INCOME', 90],
    ['INCOME', 'Хадгаламжаас', 'OWN_TRANSFER_IN', 90],
    ['INCOME', 'Өөрийн данснаас', 'OWN_TRANSFER_IN', 85],
    ['INCOME', 'Casino ялалт', 'SUSPICIOUS_INCOME', 90],
    // зарлага
    ['EXPENSE', 'Зээлийн эргэн төлөлт', 'LOAN_PAYMENT', 90],
    ['EXPENSE', 'Зээл төлөлт', 'LOAN_PAYMENT', 90],
    ['EXPENSE', 'Зээлийн хүү', 'LOAN_PAYMENT', 90],
    ['EXPENSE', 'Лизинг', 'LOAN_PAYMENT', 90],
    ['EXPENSE', 'Лизингийн төлбөр', 'LOAN_PAYMENT', 85],
    ['EXPENSE', 'Алданги', 'LOAN_PAYMENT', 90],
    ['EXPENSE', 'Кредит карт төлбөр', 'DEBT_OBLIGATION', 90],
    ['EXPENSE', 'Түрээсийн төлбөр', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Цахилгаан', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Дулаан', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Ус', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Усны төлбөр', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Интернет', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Утасны төлбөр', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Unitel 99887766', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Mobicom', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Skytel', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'G-Mobile', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'СӨХ-ийн төлбөр', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Даатгалын шимтгэл', 'FIXED_EXPENSE', 90], // 'шимтгэл'-ээс (BANK_FEE) урт хэв ялна
    ['EXPENSE', 'Сургалтын төлбөр', 'FIXED_EXPENSE', 85],
    ['EXPENSE', 'Хичээлийн төлбөр', 'FIXED_EXPENSE', 90],
    ['EXPENSE', 'Тээврийн хэрэгслийн татвар', 'FIXED_EXPENSE', 90], // 'татвар' (BUSINESS)-аас давуу
    ['EXPENSE', 'Шатахуун', 'ESSENTIAL_EXPENSE', 90],
    ['EXPENSE', 'Номин супермаркет', 'ESSENTIAL_EXPENSE', 90],
    ['EXPENSE', 'Эмийн сан', 'ESSENTIAL_EXPENSE', 90],
    ['EXPENSE', 'Эмнэлгийн төлбөр', 'ESSENTIAL_EXPENSE', 90],
    ['EXPENSE', 'Хүнсний дэлгүүр', 'ESSENTIAL_EXPENSE', 85], // 'хүнс' NORMAL > 'дэлгүүр' WEAK
    ['EXPENSE', 'Дэлгүүр', 'ESSENTIAL_EXPENSE', 90],
    ['EXPENSE', 'Ресторан', 'DISCRETIONARY_EXPENSE', 90],
    ['EXPENSE', 'Кофе', 'DISCRETIONARY_EXPENSE', 90],
    ['EXPENSE', 'Бараа материал', 'BUSINESS_EXPENSE', 90],
    ['EXPENSE', 'Нийлүүлэгчид төлсөн', 'BUSINESS_EXPENSE', 85],
    ['EXPENSE', 'НДШ', 'BUSINESS_EXPENSE', 90],
    ['EXPENSE', 'ХХОАТ', 'BUSINESS_EXPENSE', 90],
    ['EXPENSE', 'Татвар', 'BUSINESS_EXPENSE', 90],
    ['EXPENSE', 'Нийгмийн даатгалын шимтгэл', 'BUSINESS_EXPENSE', 85], // STRONG: 'даатгал'/'шимтгэл'-ээс давуу
    ['EXPENSE', 'Худалдан авалт', 'BUSINESS_EXPENSE', 90],
    ['EXPENSE', 'Шимтгэл', 'BANK_FEE', 90],
    ['EXPENSE', 'Хураамж', 'BANK_FEE', 90],
    ['EXPENSE', 'Данс хөтөлсний хөлс', 'BANK_FEE', 90],
    ['EXPENSE', 'Үйлчилгээний хөлс', 'BANK_FEE', 90],
    ['EXPENSE', 'Хадгаламж руу шилжүүлэг', 'NON_EXPENSE', 90],
    ['EXPENSE', 'Буцаалт', 'NON_EXPENSE', 90],
    ['EXPENSE', 'Бооцоо', 'SUSPICIOUS_EXPENSE', 90],
    ['EXPENSE', 'Casino', 'SUSPICIOUS_EXPENSE', 90],
  ];
  it.each(rows)('%s «%s» → %s (%i%%)', (direction, description, category_, confidence) => {
    const txn = direction === 'INCOME' ? incomeTxn('k', description) : expenseTxn('k', description);
    const m = run(txn);
    expect(m?.rule.categoryCode).toBe(category_);
    expect(m?.confidence).toBe(confidence);
  });

  it('the same phrase written in cyrillic, latin or mixed script classifies identically', () => {
    const groups: string[][] = [
      ['Цалин', 'Tsalin', 'TSALIN', 'цaлин', 'ЦАЛИН'], // 4-р нь латин a (look-alike)
      ['Шатахуун', 'Shatakhuun', 'SHATAHUN'],
      ['Борлуулалт', 'Borluulalt', 'БОРЛУУЛАЛТ'],
      ['Даатгал', 'Daatgal', 'ДААТГАЛ'],
    ];
    for (const variants of groups) {
      const ms = variants.map((v) => run(incomeTxn('k', v)) ?? run(expenseTxn('k', v)));
      expect(new Set(ms.map((m) => `${m?.rule.categoryCode}:${m?.confidence}`)).size, variants.join('/')).toBe(1);
      expect(ms[0]).not.toBeNull();
    }
  });

  it('short keywords do not match inside longer words: "ус" is not in "мусак"/"Rus"/"Русь" but is the word "Ус"', () => {
    for (const text of ['мусак', 'Rus', 'Русь', 'Бусад', 'Гүүр']) expect(run(expenseTxn('k', text)), text).toBeNull();
    expect(run(expenseTxn('k', 'Ус'))?.rule.categoryCode).toBe('FIXED_EXPENSE');
    expect(run(expenseTxn('k', 'Ус сувгийн төлбөр'))?.rule.categoryCode).toBe('FIXED_EXPENSE');
    expect(run(incomeTxn('k', 'Хүүхдийн мөнгө'))).toBeNull(); // 'хүү' ≠ 'хүүхэд'
    expect(run(incomeTxn('k', 'Хүүхэд'))).toBeNull();
  });

  it('income and expense rules never cross direction', () => {
    expect(run(incomeTxn('k', 'Түрээсийн төлбөр'))?.rule.categoryCode).toBe('PASSIVE_INCOME');
    expect(run(expenseTxn('k', 'Түрээсийн төлбөр'))?.rule.categoryCode).toBe('FIXED_EXPENSE');
    expect(run(expenseTxn('k', 'Тэтгэвэр'))).toBeNull();
    expect(run(incomeTxn('k', 'Шимтгэл'))).toBeNull();
  });

  it('matches on the counterparty name too, not only the description', () => {
    expect(run(expenseTxn('k', 'төлбөр', { counterpartyName: 'Номин супермаркет ХХК' }))?.rule.categoryCode).toBe('ESSENTIAL_EXPENSE');
  });

  it('phrases do not match across the description/counterparty boundary', () => {
    const set = compileRuleSet([keywordRule({ direction: 'EXPENSE', pattern: 'ус сувгийн', categoryCode: 'FIXED_EXPENSE' })], DEFAULT_BSA_CATEGORIES);
    expect(run(expenseTxn('k', 'төлбөр ус', { counterpartyName: 'сувгийн газар' }), set)).toBeNull();
    expect(run(expenseTxn('k', 'ус сувгийн газар'), set)?.rule.categoryCode).toBe('FIXED_EXPENSE');
  });
});

describe('rule ordering', () => {
  const cats = [
    category({ code: 'A', direction: 'EXPENSE' }),
    category({ code: 'B', direction: 'EXPENSE' }),
    category({ code: 'I', direction: 'INCOME' }),
  ];
  const winner = (rules: BsaRuleDef[], text = 'цалин') => {
    const set = compileRuleSet(rules, cats);
    return evaluateRules(prepareTxn(expenseTxn('k', text)), set)?.rule;
  };
  const base = { direction: 'EXPENSE' as const, matchType: 'KEYWORD' as const };

  it('higher priority wins even when its pattern is shorter', () => {
    const w = winner([
      { ...base, pattern: 'цалингийн урьдчилгаа', categoryCode: 'A', priority: 100, source: 'ADMIN' },
      { ...base, pattern: 'цалин', categoryCode: 'B', priority: 200, source: 'ADMIN' },
    ], 'цалингийн урьдчилгаа');
    expect(w?.categoryCode).toBe('B');
  });

  it('at equal priority ADMIN beats FEEDBACK regardless of input order', () => {
    const admin: BsaRuleDef = { ...base, pattern: 'цалин', categoryCode: 'A', priority: 300, source: 'ADMIN' };
    const feedback: BsaRuleDef = { ...base, pattern: 'цалин', categoryCode: 'B', priority: 300, source: 'FEEDBACK' };
    expect(winner([feedback, admin])?.categoryCode).toBe('A');
    expect(winner([admin, feedback])?.categoryCode).toBe('A');
  });

  it('at equal priority and source the longer (more specific) pattern wins', () => {
    const short: BsaRuleDef = { ...base, pattern: 'цалин', categoryCode: 'A', priority: 200, source: 'ADMIN' };
    const long: BsaRuleDef = { ...base, pattern: 'сарын цалин', categoryCode: 'B', priority: 200, source: 'ADMIN' };
    expect(winner([short, long], 'сарын цалин')?.categoryCode).toBe('B');
    expect(winner([long, short], 'сарын цалин')?.categoryCode).toBe('B');
    expect(winner([long, short], 'цалин')?.categoryCode).toBe('A');
  });

  it('a FEEDBACK rule at its default priority beats the default catalog but loses to an ADMIN override', () => {
    const feedback: BsaRuleDef = { direction: 'INCOME', matchType: 'KEYWORD', pattern: 'цалин', categoryCode: 'BUSINESS_INCOME', priority: RULE_PRIORITY.FEEDBACK, source: 'FEEDBACK' };
    const override: BsaRuleDef = { ...feedback, categoryCode: 'CASH_INCOME', priority: RULE_PRIORITY.ADMIN_OVERRIDE, source: 'ADMIN' };
    const txn = incomeTxn('k', 'Цалин 2026-03');
    expect(run(txn, compileRuleSet([...DEFAULT_BSA_RULES, feedback], DEFAULT_BSA_CATEGORIES))?.rule.categoryCode).toBe('BUSINESS_INCOME');
    expect(run(txn, compileRuleSet([...DEFAULT_BSA_RULES, feedback, override], DEFAULT_BSA_CATEGORIES))?.rule.categoryCode).toBe('CASH_INCOME');
  });

  it('every default rule priority stays below the FEEDBACK band', () => {
    expect(Math.max(...DEFAULT_BSA_RULES.map((r) => r.priority))).toBeLessThan(RULE_PRIORITY.FEEDBACK);
  });

  it('is deterministic: identical rules in the same order always give the same winner', () => {
    const rules: BsaRuleDef[] = [
      { ...base, pattern: 'цалин', categoryCode: 'A', priority: 200, source: 'ADMIN' },
      { ...base, pattern: 'цалин', categoryCode: 'B', priority: 200, source: 'ADMIN' },
    ];
    const first = winner(rules)?.categoryCode;
    for (let i = 0; i < 5; i++) expect(winner(rules)?.categoryCode).toBe(first);
    expect(first).toBe('A'); // эцсийн тайбрейкер: оролтын эрэмбэ
  });
});

describe('confidence', () => {
  const cats = [category({ code: 'A', direction: 'EXPENSE' })];
  const conf = (rule: Partial<BsaRuleDef> & Pick<BsaRuleDef, 'pattern' | 'matchType'>, txn = expenseTxn('k', 'Цалин 2026-03')) => {
    const set = compileRuleSet([{ direction: 'EXPENSE', categoryCode: 'A', priority: 200, source: 'ADMIN', ...rule }], cats);
    return evaluateRules(prepareTxn(txn), set)?.confidence;
  };

  it('uses the single CLASSIFY_CONFIDENCE table', () => {
    expect(CLASSIFY_CONFIDENCE).toMatchObject({ MANUAL: 100, COUNTERPARTY: 95, KEYWORD: 85, REGEX: 80, FEEDBACK: 85, CHANNEL_FALLBACK: 60, UNMATCHED: 30 });
    expect(CLASSIFY_CONFIDENCE.KEYWORD_WHOLE_PHRASE_BONUS).toBe(5);
  });

  it('KEYWORD 85 when the phrase is only the start of a longer word, +5 (90) when it matches whole words', () => {
    expect(conf({ matchType: 'KEYWORD', pattern: 'цали' })).toBe(85);
    expect(conf({ matchType: 'KEYWORD', pattern: 'цалин' })).toBe(90);
    expect(conf({ matchType: 'KEYWORD', pattern: 'цалин' }, expenseTxn('k', 'Цалингийн урьдчилгаа'))).toBe(85);
    expect(conf({ matchType: 'KEYWORD', pattern: 'цалин 2026' })).toBe(90);
  });

  it('COUNTERPARTY by account = 95 (formatting-insensitive), by name = 95', () => {
    const byAccount = expenseTxn('k', 'x', { counterpartyAccount: '5011 234 567' });
    expect(conf({ matchType: 'COUNTERPARTY', pattern: '5011-234-567' }, byAccount)).toBe(95);
    const byName = expenseTxn('k', 'x', { counterpartyName: 'ШАТАХУУН ХХК' });
    expect(conf({ matchType: 'COUNTERPARTY', pattern: 'Shatakhuun HHK' }, byName)).toBe(95);
  });

  it('REGEX = 80', () => {
    expect(conf({ matchType: 'REGEX', pattern: 'цалин\\s*\\d+' }, expenseTxn('k', 'Цалин 2026'))).toBe(80);
  });

  it('every FEEDBACK rule = 85 whatever its match type', () => {
    expect(conf({ matchType: 'KEYWORD', pattern: 'цалин', source: 'FEEDBACK' })).toBe(85);
    expect(conf({ matchType: 'REGEX', pattern: 'цалин', source: 'FEEDBACK' })).toBe(85);
    expect(conf({ matchType: 'COUNTERPARTY', pattern: '5011234567', source: 'FEEDBACK' }, expenseTxn('k', 'x', { counterpartyAccount: '5011234567' }))).toBe(85);
  });
});

describe('COUNTERPARTY rules', () => {
  const cats = [category({ code: 'A', direction: 'EXPENSE' })];
  const rule = (pattern: string): BsaRuleDef => ({ direction: 'EXPENSE', matchType: 'COUNTERPARTY', pattern, categoryCode: 'A', priority: 200, source: 'ADMIN' });
  const hit = (pattern: string, txn: ReturnType<typeof expenseTxn>) => evaluateRules(prepareTxn(txn), compileRuleSet([rule(pattern)], cats)) !== null;

  it('matches an exact normalized account, not a substring or different account', () => {
    expect(hit('5011234567', expenseTxn('k', 'x', { counterpartyAccount: '5011-234-567' }))).toBe(true);
    expect(hit('5011234567', expenseTxn('k', 'x', { counterpartyAccount: '15011234567' }))).toBe(false);
    expect(hit('5011234567', expenseTxn('k', 'x', { counterpartyAccount: null }))).toBe(false);
    expect(hit('5011234567', expenseTxn('k', '5011234567'))).toBe(false); // зөвхөн харьцсан данс талбар
  });

  it('matches IBANs case/space-insensitively', () => {
    expect(hit('MN58 0050 0991 2345 6789', expenseTxn('k', 'x', { counterpartyAccount: 'mn580050099123456789' }))).toBe(true);
  });

  it('matches a normalized counterparty name exactly (script-insensitive), not a partial name', () => {
    expect(hit('Номин ХХК', expenseTxn('k', 'x', { counterpartyName: 'NOMIN HHK' }))).toBe(true);
    expect(hit('Номин', expenseTxn('k', 'x', { counterpartyName: 'Номин ХХК' }))).toBe(false);
    expect(hit('Номин', expenseTxn('k', 'x', { counterpartyName: null }))).toBe(false);
  });
});

describe('REGEX rules', () => {
  const cats = [category({ code: 'A', direction: 'EXPENSE' })];
  const rule = (pattern: string): BsaRuleDef => ({ direction: 'EXPENSE', matchType: 'REGEX', pattern, categoryCode: 'A', priority: 200, source: 'ADMIN' });
  const hit = (pattern: string, description: string) =>
    evaluateRules(prepareTxn(expenseTxn('k', description)), compileRuleSet([rule(pattern)], cats)) !== null;

  it('matches the original text case-insensitively and also the normalized key', () => {
    expect(hit('цалин\\s*\\d{4}', 'ЦАЛИН 2026')).toBe(true);
    expect(hit('tsalin\\s*\\d{4}', 'ЦАЛИН 2026')).toBe(true); // араг ясан дээр бичсэн regex
    expect(hit('цалин\\s*\\d{4}', 'Цалин март')).toBe(false);
  });

  it('a catastrophic pattern is dropped (reported) and cannot hang the engine, even on a huge adversarial text', () => {
    const set = compileRuleSet([rule('(a+)+$'), { ...rule('шатахуун'), matchType: 'KEYWORD' }], cats);
    expect(set.issues).toHaveLength(1);
    expect(set.issues[0]).toMatchObject({ index: 0, code: 'REGEX_UNSAFE' });
    const t0 = performance.now();
    const m = evaluateRules(prepareTxn(expenseTxn('k', `${'a'.repeat(100_000)}!`)), set);
    expect(m).toBeNull();
    expect(performance.now() - t0).toBeLessThan(250);
    expect(evaluateRules(prepareTxn(expenseTxn('k', 'Шатахуун')), set)?.rule.pattern).toBe('шатахуун'); // бусад дүрэм үргэлжилнэ
  });
});

describe('invalid rules are skipped and reported, never thrown', () => {
  const cats = [
    category({ code: 'A', direction: 'EXPENSE' }),
    category({ code: 'OFF', direction: 'EXPENSE', isActive: false }),
    category({ code: 'I', direction: 'INCOME' }),
  ];
  it('reports each reason with a rule index and id, without echoing the pattern', () => {
    const rules: BsaRuleDef[] = [
      { id: 'r0', direction: 'EXPENSE', matchType: 'KEYWORD', pattern: '!!!', categoryCode: 'A', priority: 1, source: 'ADMIN' },
      { id: 'r1', direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'нууц нэр', categoryCode: 'NOPE', priority: 1, source: 'ADMIN' },
      { id: 'r2', direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'x', categoryCode: 'OFF', priority: 1, source: 'ADMIN' },
      { id: 'r3', direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'x', categoryCode: 'I', priority: 1, source: 'ADMIN' },
      { id: 'r4', direction: 'EXPENSE', matchType: 'REGEX', pattern: '(', categoryCode: 'A', priority: 1, source: 'ADMIN' },
      { id: 'r5', direction: 'EXPENSE', matchType: 'COUNTERPARTY', pattern: '   ', categoryCode: 'A', priority: 1, source: 'ADMIN' },
      { id: 'r6', direction: 'EXPENSE', matchType: 'NOPE' as never, pattern: 'x', categoryCode: 'A', priority: 1, source: 'ADMIN' },
      { id: 'r7', direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'x', categoryCode: 'A', priority: Number.NaN, source: 'ADMIN' },
      { id: 'r8', direction: 'SIDEWAYS' as never, matchType: 'KEYWORD', pattern: 'x', categoryCode: 'A', priority: 1, source: 'ADMIN' },
      { id: 'r9', direction: 'constructor' as never, matchType: 'KEYWORD', pattern: 'x', categoryCode: 'A', priority: 1, source: 'ADMIN' },
      { id: 'ok', direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'x', categoryCode: 'A', priority: 1, source: 'ADMIN' },
    ];
    const { issues, byDirection } = compileRuleSet(rules, cats);
    expect(issues.map((i) => [i.ruleId, i.code])).toEqual([
      ['r0', 'EMPTY_PATTERN'],
      ['r1', 'UNKNOWN_CATEGORY'],
      ['r2', 'CATEGORY_INACTIVE'],
      ['r3', 'DIRECTION_MISMATCH'],
      ['r4', 'REGEX_INVALID'],
      ['r5', 'EMPTY_PATTERN'],
      ['r6', 'INVALID_RULE'],
      ['r7', 'INVALID_RULE'],
      ['r8', 'INVALID_RULE'],
      ['r9', 'INVALID_RULE'],
    ]);
    expect(byDirection.EXPENSE).toHaveLength(1);
    expect(JSON.stringify(issues)).not.toContain('нууц нэр');
  });
});
