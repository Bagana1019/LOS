// TDB parser — SYNTHETIC хуулгаар (TODO(samples): таамагласан формат, бодит файлаар баталгаажаагүй).
import { describe, expect, it } from 'vitest';
import { REGISTRY_DEFAULTS } from '../parser.registry';
import { BANK_SPECS, bankStatement, specTransactions } from './testing/bank-specs';
import { describeBankParser } from './testing/bank-suite';

const spec = BANK_SPECS.TDB;
const MIN = REGISTRY_DEFAULTS.minScore;

describeBankParser(spec);

describe('TDB specifics', () => {
  it('accepts images and prints standard IBANs', () => {
    expect(spec.parser.policy).toEqual({ acceptsImages: true, printsNonStandardIban: false });
  });

  it.each(['Худалдаа хөгжлийн банк', 'ХХБ', 'TDB', 'Trade and Development Bank', 'Худалдаа Хөгжлийн Банк ХХК'])(
    'recognises the name variant "%s" in the title',
    (name) => {
      const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [name, 'Дансны хуулга'] } });
      expect(spec.parser.detect(text)).toBeGreaterThanOrEqual(MIN);
    },
  );

  it('short keywords match whole words only', () => {
    for (const title of ['TDBX Corp', 'ABХХБ', 'Retdb']) {
      const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [title, 'Дансны хуулга'] } });
      expect(spec.parser.detect(text), title).toBeLessThan(MIN);
    }
  });

  it('"TDB" / "ХХБ" in the transaction descriptions of another bank statement does not make it a TDB statement', () => {
    const other = BANK_SPECS.KHAN;
    const txns = specTransactions(other).map((t) => ({ ...t, description: `TDB ХХБ Trade and Development Bank ${t.description}` }));
    const { text } = bankStatement(other, txns);
    expect(spec.parser.detect(text)).toBeLessThan(MIN);
  });

  it('empty cells dropped (PDF-like) with income before expense', () => {
    const { text, expected } = bankStatement(spec, specTransactions(spec), { emptyAmount: '', dropEmptyCells: true });
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => [t.direction, t.amount])).toEqual(expected.transactions.map((t) => [t.direction, t.amount]));
  });
});
