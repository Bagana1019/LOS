// XAC parser — SYNTHETIC хуулгаар (TODO(samples): таамагласан формат, бодит файлаар баталгаажаагүй).
import { describe, expect, it } from 'vitest';
import { REGISTRY_DEFAULTS } from '../parser.registry';
import { BANK_SPECS, bankStatement, specTransactions } from './testing/bank-specs';
import { describeBankParser } from './testing/bank-suite';

const spec = BANK_SPECS.XAC;
const MIN = REGISTRY_DEFAULTS.minScore;

describeBankParser(spec);

describe('XAC specifics', () => {
  it('accepts images and prints standard IBANs', () => {
    expect(spec.parser.policy).toEqual({ acceptsImages: true, printsNonStandardIban: false });
  });

  it.each(['Хас банк', 'Хасбанк', 'XacBank', 'Xac Bank', 'XACBANK'])('recognises the name variant "%s" in the title', (name) => {
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [name, 'Дансны хуулга'] } });
    expect(spec.parser.detect(text)).toBeGreaterThanOrEqual(MIN);
  });

  it('expense column comes first and "-" marks the empty side', () => {
    const { text, expected } = bankStatement(spec, specTransactions(spec));
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => [t.direction, t.amount])).toEqual(expected.transactions.map((t) => [t.direction, t.amount]));
    expect(parsed.warnings.map((w) => w.code)).not.toContain('DIRECTION_SWAPPED');
  });

  it('a file whose debit/credit columns are systematically reversed is swapped back using the balance (DIRECTION_SWAPPED)', () => {
    const { text, expected } = bankStatement(spec, specTransactions(spec), {
      columns: ['date', 'description', 'debit', 'credit', 'balance'],
      debitIsIncome: true,
    });
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => [t.direction, t.amount])).toEqual(expected.transactions.map((t) => [t.direction, t.amount]));
    expect(parsed.warnings.map((w) => w.code)).toContain('DIRECTION_SWAPPED');
  });

  it('prints dd/mm/yyyy dates which are read day-first (DMY)', () => {
    const { text } = bankStatement(spec, specTransactions(spec));
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions[0].txnDate).toBe('2026-02-26');
  });
});
