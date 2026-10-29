// STATE parser — SYNTHETIC хуулгаар (TODO(samples): таамагласан формат, бодит файлаар баталгаажаагүй).
import { describe, expect, it } from 'vitest';
import { statementTextFromDump } from '../engine/text-dump';
import { REGISTRY_DEFAULTS } from '../parser.registry';
import { BANK_SPECS, bankStatement, specTransactions } from './testing/bank-specs';
import { describeBankParser } from './testing/bank-suite';

const spec = BANK_SPECS.STATE;
const MIN = REGISTRY_DEFAULTS.minScore;

describeBankParser(spec);

describe('STATE specifics', () => {
  it('accepts images and prints standard IBANs', () => {
    expect(spec.parser.policy).toEqual({ acceptsImages: true, printsNonStandardIban: false });
  });

  it.each(['Төрийн банк', 'State Bank of Mongolia', 'State Bank', 'ТӨРИЙН БАНК'])('recognises the name variant "%s" in the title', (name) => {
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [name, 'Дансны хуулга'] } });
    expect(spec.parser.detect(text)).toBeGreaterThanOrEqual(MIN);
  });

  it.each(['State Bank of India', 'State Bank of Pakistan', 'State Bank of Vietnam'])('rejects the foreign bank "%s"', (name) => {
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [name, 'Дансны хуулга'] } });
    expect(spec.parser.detect(text)).toBe(0);
  });

  it('reads Дт/Кт word values in the type column', () => {
    const dump = [
      'SYNTHETIC TEST DATA - NOT A REAL STATEMENT',
      'Төрийн банк',
      'Дансны хуулга',
      'Дансны дугаар: 5011223344',
      'Эхний үлдэгдэл: 500,000.00',
      ['Огноо', 'Цаг', 'Гүйлгээний утга', 'Дүн', 'Дт/Кт', 'Үлдэгдэл'].join('\t'),
      ['2026-03-01', '09:00:00', 'Цалин', '300,000.00', 'Кт', '800,000.00'].join('\t'),
      ['2026-03-01', '12:30:00', 'Дэлгүүр', '45,000.00', 'Дт', '755,000.00'].join('\t'),
    ].join('\n');
    const parsed = spec.parser.parse(statementTextFromDump(dump));
    expect(parsed.transactions.map((t) => [t.direction, t.amount, t.balanceAfter])).toEqual([
      ['INCOME', 300_000, 800_000],
      ['EXPENSE', 45_000, 755_000],
    ]);
  });

  it('Dr/Cr type column with unsigned amount', () => {
    const { text, expected } = bankStatement(spec, specTransactions(spec));
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => [t.direction, t.amount])).toEqual(expected.transactions.map((t) => [t.direction, t.amount]));
  });
});
