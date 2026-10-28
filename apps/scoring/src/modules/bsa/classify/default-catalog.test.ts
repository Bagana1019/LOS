// Анхдагч сангийн бүтцийн шалгалт (docs/02 §4). Persistence нэгж эндээс seed хийдэг тул гэрээг тогтооно.
import { describe, expect, it } from 'vitest';
import { BsaDtiRole } from '@los/contracts';
import { toMatchKey } from '@los/ocr';
import { OTHER_GROUP_CODE, RULE_PRIORITY, SYSTEM_CATEGORY } from './classify.defaults';
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from './default-catalog';
import { assertSystemCategories } from './classifier';
import { compileRuleSet } from './rule-engine';

const byCode = new Map(DEFAULT_BSA_CATEGORIES.map((c) => [c.code, c]));

describe('DEFAULT_BSA_CATEGORIES (docs/02 §4)', () => {
  it('has the 12 income and 11 expense categories with unique codes', () => {
    expect(DEFAULT_BSA_CATEGORIES.filter((c) => c.direction === 'INCOME')).toHaveLength(12);
    expect(DEFAULT_BSA_CATEGORIES.filter((c) => c.direction === 'EXPENSE')).toHaveLength(11);
    expect(byCode.size).toBe(DEFAULT_BSA_CATEGORIES.length);
    for (const c of DEFAULT_BSA_CATEGORIES) expect(c.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('income categories: group + default mobilisation weight from docs/02', () => {
    const income: Array<[string, string, number]> = [
      ['SALARY', 'A', 1], ['CASH_INCOME', 'B', 0.5], ['BUSINESS_INCOME', 'B', 0.85], ['PASSIVE_INCOME', 'C', 1], ['CONTRACT_INCOME', 'D', 0.7],
      ['OTHER_INCOME', '?', 0.1], ['IRREGULAR_INCOME', '—', 0], ['LOAN_PROCEEDS', '—', 0], ['NON_INCOME', '—', 0], ['ABNORMAL_INCOME', '—', 0],
      ['SUSPICIOUS_INCOME', '—', 0], ['OWN_TRANSFER_IN', '—', 0],
    ];
    for (const [code, group, weight] of income) {
      expect(byCode.get(code), code).toMatchObject({ direction: 'INCOME', groupCode: group, weight, isActive: true });
    }
  });

  it('every income category except OWN_TRANSFER_IN has dtiRole INCOME (zero weights still add to the gross total)', () => {
    for (const c of DEFAULT_BSA_CATEGORIES.filter((x) => x.direction === 'INCOME')) {
      expect(c.dtiRole, c.code).toBe(c.code === 'OWN_TRANSFER_IN' ? 'EXCLUDE' : 'INCOME');
    }
  });

  it('expense categories: group + DTI role from docs/02', () => {
    const expense: Array<[string, string, string]> = [
      ['LOAN_PAYMENT', 'A', 'DEBT_SERVICE'], ['DEBT_OBLIGATION', 'A', 'DEBT_SERVICE'], ['FIXED_EXPENSE', 'B', 'HOUSEHOLD'],
      ['ESSENTIAL_EXPENSE', 'C', 'HOUSEHOLD'], ['DISCRETIONARY_EXPENSE', 'D', 'INFO'], ['BUSINESS_EXPENSE', 'E', 'BUSINESS_EXPENSE'],
      ['BANK_FEE', 'F', 'INFO'], ['NON_EXPENSE', 'F', 'EXCLUDE'], ['SUSPICIOUS_EXPENSE', 'G', 'INFO'], ['CHANNEL_EXPENSE', 'CH', 'INFO'],
      ['OTHER_EXPENSE', '?', 'INFO'],
    ];
    for (const [code, group, role] of expense) {
      expect(byCode.get(code), code).toMatchObject({ direction: 'EXPENSE', groupCode: group, dtiRole: role, weight: 1, isActive: true });
    }
  });

  it('uses only valid dtiRoles, Mongolian names, weights within 0..1', () => {
    for (const c of DEFAULT_BSA_CATEGORIES) {
      expect(BsaDtiRole).toContain(c.dtiRole);
      expect(c.name).toMatch(/[Ѐ-ӿ]/); // кирилл
      expect(c.weight).toBeGreaterThanOrEqual(0);
      expect(c.weight).toBeLessThanOrEqual(1);
    }
  });

  it('contains every system category the classifier needs, and "Бусад" categories are the "?" group', () => {
    expect(() => assertSystemCategories(DEFAULT_BSA_CATEGORIES)).not.toThrow();
    expect(Object.values(SYSTEM_CATEGORY).every((code) => byCode.has(code))).toBe(true);
    expect(DEFAULT_BSA_CATEGORIES.filter((c) => c.groupCode === OTHER_GROUP_CODE).map((c) => c.code).sort()).toEqual(['OTHER_EXPENSE', 'OTHER_INCOME']);
  });
});

describe('DEFAULT_BSA_RULES', () => {
  it('is a data-driven table of ~80..150 rules (admin edits it later)', () => {
    expect(DEFAULT_BSA_RULES.length).toBeGreaterThanOrEqual(80);
    expect(DEFAULT_BSA_RULES.length).toBeLessThanOrEqual(150);
  });

  it('every rule is a KEYWORD/ADMIN rule pointing to an existing, same-direction category and compiles cleanly', () => {
    for (const r of DEFAULT_BSA_RULES) {
      expect(r.matchType).toBe('KEYWORD');
      expect(r.source).toBe('ADMIN');
      const c = byCode.get(r.categoryCode);
      expect(c, r.categoryCode).toBeDefined();
      expect(c?.direction, `${r.pattern} → ${r.categoryCode}`).toBe(r.direction);
      expect(toMatchKey(r.pattern), r.pattern).not.toBe('');
    }
    expect(compileRuleSet(DEFAULT_BSA_RULES, DEFAULT_BSA_CATEGORIES).issues).toEqual([]);
  });

  it('has no two rules with the same normalized pattern in one direction (latin/cyrillic duplicates are one rule)', () => {
    const seen = new Map<string, string>();
    for (const r of DEFAULT_BSA_RULES) {
      const key = `${r.direction}:${toMatchKey(r.pattern)}`;
      expect(seen.has(key), `${key} duplicates ${seen.get(key)}`).toBe(false);
      seen.set(key, r.pattern);
    }
  });

  it('priorities stay in the default band (< FEEDBACK) and use only the three tiers', () => {
    const tiers = new Set<number>([RULE_PRIORITY.WEAK, RULE_PRIORITY.NORMAL, RULE_PRIORITY.STRONG]);
    for (const r of DEFAULT_BSA_RULES) expect(tiers.has(r.priority), `${r.pattern}`).toBe(true);
    expect(RULE_PRIORITY.STRONG).toBeLessThan(RULE_PRIORITY.FEEDBACK);
    expect(RULE_PRIORITY.FEEDBACK).toBeLessThan(RULE_PRIORITY.ADMIN_OVERRIDE);
  });

  it('covers every category group the task lists (spot check of required wording)', () => {
    const has = (direction: string, category: string, pattern: string) =>
      DEFAULT_BSA_RULES.some((r) => r.direction === direction && r.categoryCode === category && toMatchKey(r.pattern) === toMatchKey(pattern));
    expect(has('INCOME', 'SALARY', 'цалин')).toBe(true);
    expect(has('INCOME', 'SALARY', 'сарын цалин')).toBe(true);
    expect(has('INCOME', 'PASSIVE_INCOME', 'түрээс')).toBe(true);
    expect(has('EXPENSE', 'FIXED_EXPENSE', 'түрээсийн төлбөр')).toBe(true);
    expect(has('EXPENSE', 'LOAN_PAYMENT', 'зээлийн эргэн төлөлт')).toBe(true);
    expect(has('INCOME', 'LOAN_PROCEEDS', 'зээл олголт')).toBe(true);
    expect(has('EXPENSE', 'BANK_FEE', 'данс хөтөлсний хөлс')).toBe(true);
    expect(has('EXPENSE', 'SUSPICIOUS_EXPENSE', 'бооцоо')).toBe(true);
    expect(has('EXPENSE', 'NON_EXPENSE', 'хадгаламж')).toBe(true);
    expect(has('INCOME', 'NON_INCOME', 'буцаалт')).toBe(true);
  });
});
