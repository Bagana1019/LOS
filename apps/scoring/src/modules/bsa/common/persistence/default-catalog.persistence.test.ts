// prisma/seed.ts-ийн хамгаалалт: анхдагч сан DB-ийн хилийн шалгалтыг (bsa.validation) давах ёстой. Эс бөгөөс seed чимээгүй алдагдана.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from '../../classify/default-catalog';
import { categoryDefSchema, newRuleSchema } from './bsa.validation';

describe('default BSA catalog vs persistence boundary (seed)', () => {
  it('every default category passes the category schema and codes are unique per org', () => {
    for (const c of DEFAULT_BSA_CATEGORIES) expect(() => categoryDefSchema.parse(c), c.code).not.toThrow();
    expect(new Set(DEFAULT_BSA_CATEGORIES.map((c) => c.code)).size).toBe(DEFAULT_BSA_CATEGORIES.length);
  });

  it('every default rule passes the rule schema and points to a category of the same direction', () => {
    const byCode = new Map(DEFAULT_BSA_CATEGORIES.map((c) => [c.code, c]));
    for (const r of DEFAULT_BSA_RULES) {
      const { id: _id, ...rule } = r;
      expect(() => newRuleSchema.parse(rule), r.pattern).not.toThrow();
      expect(byCode.get(r.categoryCode)?.direction, `${r.pattern} → ${r.categoryCode}`).toBe(r.direction);
    }
  });

  it('rule natural keys are unique, so the seed (unique index) never silently drops a default rule', () => {
    const keys = DEFAULT_BSA_RULES.map((r) => [r.direction, r.matchType, r.pattern, r.categoryCode, r.source].join('\u0000'));
    expect(new Set(keys).size).toBe(DEFAULT_BSA_RULES.length);
  });
});
