// GOLOMT parser — SYNTHETIC хуулгаар (TODO(samples): таамагласан формат, бодит файлаар баталгаажаагүй).
import { describe, expect, it } from 'vitest';
import { REGISTRY_DEFAULTS } from '../parser.registry';
import { BANK_SPECS, bankStatement, specTransactions } from './testing/bank-specs';
import { describeBankParser } from './testing/bank-suite';

const spec = BANK_SPECS.GOLOMT;
const MIN = REGISTRY_DEFAULTS.minScore;

describeBankParser(spec);

describe('GOLOMT specifics', () => {
  it('accepts images (QR statements) and prints standard IBANs', () => {
    expect(spec.parser.policy).toEqual({ acceptsImages: true, printsNonStandardIban: false });
  });

  it.each(['Голомт банк', 'Golomt Bank', 'GOLOMT BANK', 'GolomtBank'])('recognises the name variant "%s" in the title', (name) => {
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [name, 'Дансны хуулга'] } });
    expect(spec.parser.detect(text)).toBeGreaterThanOrEqual(MIN);
  });

  it('keeps the customer name that Golomt puts into the description (BSA-BR-5)', () => {
    const txns = specTransactions(spec).map((t, i) => (i % 3 === 0 ? { ...t, description: `Шилжүүлэг Бат-Эрдэнэ Болд ${t.description}` } : t));
    const { text, expected } = bankStatement(spec, txns);
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => t.description)).toEqual(expected.transactions.map((t) => t.description));
    expect(parsed.transactions[0].description).toContain('Бат-Эрдэнэ Болд');
  });

  it('a statement that unexpectedly prints times is still read, with a TIME_UNEXPECTED warning', () => {
    const { text, expected } = bankStatement(spec, specTransactions({ ...spec, withTime: true }), { columns: ['date', 'time', 'description', 'debit', 'credit', 'balance'] });
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.length).toBe(expected.transactions.length);
    expect(parsed.warnings.map((w) => w.code)).toContain('TIME_UNEXPECTED');
  });

  it('reads the IBAN from the header', () => {
    const { text, expected } = bankStatement(spec, specTransactions(spec));
    const parsed = spec.parser.parse(text);
    expect(parsed.iban).toBe(expected.iban);
    expect(parsed.iban).not.toBeNull();
  });
});
