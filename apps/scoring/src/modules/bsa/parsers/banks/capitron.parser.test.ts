// CAPITRON parser — SYNTHETIC хуулгаар (TODO(samples): таамагласан формат, бодит файлаар баталгаажаагүй).
import { describe, expect, it } from 'vitest';
import { REGISTRY_DEFAULTS } from '../parser.registry';
import { BANK_SPECS, bankStatement, specTransactions } from './testing/bank-specs';
import { describeBankParser } from './testing/bank-suite';

const spec = BANK_SPECS.CAPITRON;
const MIN = REGISTRY_DEFAULTS.minScore;

describeBankParser(spec);

describe('CAPITRON specifics', () => {
  it('accepts images and prints standard IBANs', () => {
    expect(spec.parser.policy).toEqual({ acceptsImages: true, printsNonStandardIban: false });
  });

  it.each(['Капитрон банк', 'Capitron Bank', 'CAPITRON BANK', 'CapitronBank'])('recognises the name variant "%s" in the title', (name) => {
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [name, 'Дансны хуулга'] } });
    expect(spec.parser.detect(text)).toBeGreaterThanOrEqual(MIN);
  });

  it('signed amount column: the sign gives the direction', () => {
    const { text, expected } = bankStatement(spec, specTransactions(spec));
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => [t.direction, t.amount])).toEqual(expected.transactions.map((t) => [t.direction, t.amount]));
    expect(parsed.warnings.map((w) => w.code)).not.toContain('DIRECTION_FROM_BALANCE');
  });

  it('income-only statement without any minus sign: direction comes from the balance change', () => {
    const incomeOnly = specTransactions(spec).map((t) => ({ ...t, direction: 'INCOME' as const }));
    const { text, expected } = bankStatement(spec, incomeOnly, { plusSign: false });
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => [t.direction, t.amount, t.balanceAfter])).toEqual(
      expected.transactions.map((t) => [t.direction, t.amount, t.balanceAfter]),
    );
  });

  it('header values in the next cell (label cell, value cell)', () => {
    const { text, expected } = bankStatement(spec, specTransactions(spec));
    const parsed = spec.parser.parse(text);
    expect(parsed.accountNo).toBe(expected.accountNo);
    expect(parsed.holderName).toBe(expected.holderName);
  });
});
