// MBANK parser — SYNTHETIC хуулгаар (TODO(samples): таамагласан формат, бодит файлаар баталгаажаагүй).
import { describe, expect, it } from 'vitest';
import { REGISTRY_DEFAULTS } from '../parser.registry';
import { BANK_SPECS, bankStatement, specTransactions } from './testing/bank-specs';
import { describeBankParser } from './testing/bank-suite';

const spec = BANK_SPECS.MBANK;
const MIN = REGISTRY_DEFAULTS.minScore;

describeBankParser(spec);

describe('MBANK specifics', () => {
  it('accepts images and prints standard IBANs', () => {
    expect(spec.parser.policy).toEqual({ acceptsImages: true, printsNonStandardIban: false });
  });

  // Кирилл 'М' ба латин 'M' нэг түлхүүр (toMatchKey): аль ч бичлэг танигдана
  it.each(['М банк', 'М Банк', 'M Bank', 'MBANK', 'Мбанк'])('recognises the name variant "%s" in the title', (name) => {
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [name, 'Дансны хуулга'] } });
    expect(spec.parser.detect(text)).toBeGreaterThanOrEqual(MIN);
  });

  it('"М" in a longer word is not the bank name', () => {
    for (const title of ['Мөнх банк', 'AMBank']) {
      const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: [title, 'Дансны хуулга'] } });
      expect(spec.parser.detect(text), title).toBeLessThan(MIN);
    }
  });

  it("reads '1 234 567.89' amounts from a single text cell per line (spaceThousands)", () => {
    const { text, expected } = bankStatement(spec, specTransactions(spec), { textMode: 'single', amountStyle: 'space' });
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => [t.direction, t.amount, t.balanceAfter])).toEqual(
      expected.transactions.map((t) => [t.direction, t.amount, t.balanceAfter]),
    );
  });

  it('reads plain 1,234,567.89 amounts too', () => {
    const { text, expected } = bankStatement(spec, specTransactions(spec), { amountStyle: 'comma' });
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions.map((t) => t.amount)).toEqual(expected.transactions.map((t) => t.amount));
  });
});
