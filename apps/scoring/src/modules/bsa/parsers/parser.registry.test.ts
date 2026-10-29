// StatementParserRegistry — банк таних, тодорхойгүй/дэмжигдээгүй, гараар сонгох. SYNTHETIC хуулгаар (TODO(samples)).
import type { BankCode } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { BANK_PARSERS } from './banks';
import { ALL_BANKS, BANK_SPECS, bankStatement, specTransactions } from './banks/testing/bank-specs';
import { ENGINE_DEFAULTS } from './engine/defaults';
import { syntheticMeta } from './engine/text-dump';
import {
  AmbiguousBankError,
  PARSER_REGISTRY_OPTIONS,
  REGISTRY_DEFAULTS,
  StatementParserRegistry,
  UnsupportedBankError,
} from './parser.registry';
import type { ParsedStatement, StatementParser, StatementText } from './statement.types';

const real = (): StatementParserRegistry => new StatementParserRegistry(BANK_PARSERS.map((C) => new C()));

class Stub implements StatementParser {
  readonly verified = false;
  constructor(
    readonly bank: BankCode,
    private readonly score: number | Error,
    readonly id = `${bank.toLowerCase()}-stub`,
  ) {}
  detect(_text: StatementText): number {
    if (this.score instanceof Error) throw this.score;
    return this.score;
  }
  parse(_text: StatementText): ParsedStatement {
    return {
      bank: this.bank,
      parserId: this.id,
      parserVerified: false,
      accountNo: null,
      iban: null,
      holderName: null,
      currency: 'MNT',
      periodFrom: null,
      periodTo: null,
      openingBalance: null,
      closingBalance: null,
      declaredRowCount: null,
      transactions: [],
      warnings: [],
    };
  }
}

const EMPTY: StatementText = { source: 'TEXT', pages: [], meta: syntheticMeta() };

describe('REGISTRY_DEFAULTS', () => {
  it('minScore sits between the engine "no bank name" cap and "title + table header"', () => {
    const d = ENGINE_DEFAULTS.detect;
    expect(REGISTRY_DEFAULTS.minScore).toBeGreaterThan(d.noKeywordMax);
    expect(REGISTRY_DEFAULTS.minScore).toBeLessThanOrEqual(d.headerKeyword + d.tableHeader);
  });
});

describe('detect — the seven bank parsers on SYNTHETIC statements', () => {
  const registry = real();

  for (const bank of ALL_BANKS) {
    const spec = BANK_SPECS[bank];
    it(`${bank}: detected uniquely, the other six banks stay below the minimum`, () => {
      const { text } = bankStatement(spec, specTransactions(spec));
      const detection = registry.detect(text);
      expect(detection.parser.bank).toBe(bank);
      expect(detection.score).toBeGreaterThanOrEqual(REGISTRY_DEFAULTS.minScore);
      expect(detection.candidates).toHaveLength(7);
      for (const c of detection.candidates.filter((x) => x.bank !== bank)) expect(c.score, `${bank} vs ${c.bank}`).toBeLessThan(REGISTRY_DEFAULTS.minScore);
    });

    it(`${bank}: bank names inside transaction descriptions do not flip the result`, () => {
      const names = ['Хаан банк', 'Khan Bank', 'Golomt Bank', 'Голомт', 'TDB', 'ХХБ', 'Хас банк', 'XacBank', 'Капитрон', 'Төрийн банк', 'State Bank', 'M Bank', 'М банк'];
      const noisy = specTransactions(spec).map((t, i) => ({ ...t, description: `${names[i % names.length]} ${names[(i + 5) % names.length]} ${t.description}` }));
      const { text } = bankStatement(spec, noisy);
      expect(registry.detect(text).parser.bank).toBe(bank);
    });

    it(`${bank}: detected in a multi-page, newest-first, wrapped variant`, () => {
      const { text } = bankStatement(spec, specTransactions(spec), { newestFirst: true, wrapAt: 14, rowsPerPage: 4, subtotalRows: true, pageFooters: true });
      expect(registry.detect(text).parser.bank).toBe(bank);
    });
  }

  it('lists candidates from the highest score down without throwing', () => {
    const spec = BANK_SPECS.TDB;
    const { text } = bankStatement(spec, specTransactions(spec));
    const list = registry.candidates(text);
    expect(list[0].bank).toBe('TDB');
    expect([...list].sort((a, b) => b.score - a.score)).toEqual(list);
    expect(registry.candidates(EMPTY).every((c) => c.score === 0)).toBe(true);
  });
});

describe('detect — failure paths', () => {
  const registry = real();

  it('a statement with the structure but no bank name is unsupported', () => {
    const spec = BANK_SPECS.KHAN;
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: ['Дансны хуулга'] } });
    expect(() => registry.detect(text)).toThrow(UnsupportedBankError);
  });

  it('empty and garbage input are unsupported (and carry the candidates)', () => {
    expect(() => registry.detect(EMPTY)).toThrow(UnsupportedBankError);
    const garbage: StatementText = { source: 'TEXT', pages: [{ pageNo: 1, lines: [{ text: '@@@@', cells: ['@@@@'] }] }], meta: syntheticMeta() };
    try {
      registry.detect(garbage);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedBankError);
      expect((e as UnsupportedBankError).candidates).toHaveLength(7);
      expect((e as UnsupportedBankError).code).toBe('UNSUPPORTED_BANK');
    }
  });

  it('two bank names in the title are ambiguous and list both banks', () => {
    const spec = BANK_SPECS.KHAN;
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: ['Хаан банк', 'Голомт банк', 'Дансны хуулга'] } });
    try {
      registry.detect(text);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousBankError);
      const err = e as AmbiguousBankError;
      expect(err.code).toBe('AMBIGUOUS_BANK');
      expect(err.candidates.map((c) => c.bank).sort()).toEqual(['GOLOMT', 'KHAN']);
    }
  });

  it('error messages carry bank codes and scores only (no statement text)', () => {
    const spec = BANK_SPECS.KHAN;
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: ['Хаан банк', 'Голомт банк'], holder: 'Тест Нууц Нэр' } });
    try {
      registry.detect(text);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('Нууц');
      expect((e as Error).message).not.toContain('5011223344');
    }
  });
});

describe('detect — margins and minimum (stub parsers)', () => {
  it('picks the clear winner', () => {
    const r = new StatementParserRegistry([new Stub('KHAN', 0.9), new Stub('TDB', 0.7), new Stub('XAC', 0.2)]);
    expect(r.detect(EMPTY).parser.bank).toBe('KHAN');
  });

  it('scores within 0.05 of each other are ambiguous (boundary inclusive), further apart are not', () => {
    expect(() => new StatementParserRegistry([new Stub('KHAN', 0.9), new Stub('TDB', 0.86)]).detect(EMPTY)).toThrow(AmbiguousBankError);
    expect(() => new StatementParserRegistry([new Stub('KHAN', 0.9), new Stub('TDB', 0.85)]).detect(EMPTY)).toThrow(AmbiguousBankError);
    expect(new StatementParserRegistry([new Stub('KHAN', 0.9), new Stub('TDB', 0.8)]).detect(EMPTY).parser.bank).toBe('KHAN');
  });

  it('a runner-up below the minimum never makes the result ambiguous', () => {
    const r = new StatementParserRegistry([new Stub('KHAN', 0.52), new Stub('TDB', 0.48)]);
    expect(r.detect(EMPTY).parser.bank).toBe('KHAN');
  });

  it('the best score must reach the minimum', () => {
    expect(() => new StatementParserRegistry([new Stub('KHAN', 0.49)]).detect(EMPTY)).toThrow(UnsupportedBankError);
    expect(new StatementParserRegistry([new Stub('KHAN', 0.5)]).detect(EMPTY).parser.bank).toBe('KHAN');
  });

  it('two parsers of the same bank are not ambiguous with each other; the better one is used', () => {
    const r = new StatementParserRegistry([new Stub('KHAN', 0.8, 'khan-v1'), new Stub('KHAN', 0.82, 'khan-v2')]);
    const d = r.detect(EMPTY);
    expect(d.parser.id).toBe('khan-v2');
    expect(d.candidates).toHaveLength(1);
  });

  it('a parser that throws or returns garbage scores counts as 0', () => {
    const r = new StatementParserRegistry([new Stub('KHAN', new Error('boom')), new Stub('TDB', Number.NaN), new Stub('XAC', 1.7), new Stub('GOLOMT', -3)]);
    const scores = Object.fromEntries(r.candidates(EMPTY).map((c) => [c.bank, c.score]));
    expect(scores).toEqual({ XAC: 1, GOLOMT: 0, KHAN: 0, TDB: 0 });
    expect(r.detect(EMPTY).parser.bank).toBe('XAC');
  });

  it('the minimum and the margin can be overridden through PARSER_REGISTRY_OPTIONS', () => {
    expect(PARSER_REGISTRY_OPTIONS).toBeDefined();
    const lenient = new StatementParserRegistry([new Stub('KHAN', 0.3)], { minScore: 0.2 });
    expect(lenient.detect(EMPTY).parser.bank).toBe('KHAN');
    const wide = new StatementParserRegistry([new Stub('KHAN', 0.9), new Stub('TDB', 0.7)], { ambiguityMargin: 0.3 });
    expect(() => wide.detect(EMPTY)).toThrow(AmbiguousBankError);
  });

  it('no parsers registered is unsupported', () => {
    expect(() => new StatementParserRegistry([]).detect(EMPTY)).toThrow(UnsupportedBankError);
    expect(new StatementParserRegistry([]).banks()).toEqual([]);
  });
});

describe('parse and the explicit bank override', () => {
  const registry = real();

  it('parses with the detected parser when no bank is given', () => {
    const spec = BANK_SPECS.CAPITRON;
    const { text, expected } = bankStatement(spec, specTransactions(spec));
    const parsed = registry.parse(text);
    expect(parsed.bank).toBe('CAPITRON');
    expect(parsed.transactions).toHaveLength(expected.transactions.length);
  });

  it('uses the chosen bank even when detection is ambiguous', () => {
    const spec = BANK_SPECS.KHAN;
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: ['Хаан банк', 'Голомт банк'] } });
    expect(() => registry.parse(text)).toThrow(AmbiguousBankError);
    const parsed = registry.parse(text, 'KHAN');
    expect(parsed.bank).toBe('KHAN');
    expect(parsed.transactions.length).toBeGreaterThan(0);
    expect(parsed.warnings.map((w) => w.code)).not.toContain('BANK_OVERRIDE_UNCONFIRMED');
  });

  it('uses the chosen bank for an unrecognised statement and flags that the choice is unconfirmed', () => {
    const spec = BANK_SPECS.TDB;
    const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: ['Дансны хуулга'] } });
    expect(() => registry.parse(text)).toThrow(UnsupportedBankError);
    const parsed = registry.parse(text, 'TDB');
    expect(parsed.bank).toBe('TDB');
    expect(parsed.transactions.length).toBeGreaterThan(0);
    expect(parsed.warnings.map((w) => w.code)).toContain('BANK_OVERRIDE_UNCONFIRMED');
  });

  it('a wrongly chosen bank is flagged (the statement belongs to another bank)', () => {
    const spec = BANK_SPECS.GOLOMT;
    const { text } = bankStatement(spec, specTransactions(spec));
    const parsed = registry.parse(text, 'XAC');
    expect(parsed.bank).toBe('XAC');
    expect(parsed.warnings.map((w) => w.code)).toContain('BANK_OVERRIDE_UNCONFIRMED');
  });

  it('an override for a bank without a registered parser is unsupported', () => {
    const r = new StatementParserRegistry([new Stub('KHAN', 0.9)]);
    expect(() => r.parse(EMPTY, 'TDB')).toThrow(UnsupportedBankError);
    expect(() => r.get('TDB')).toThrow(UnsupportedBankError);
  });
});

describe('banks and policyFor', () => {
  const registry = real();

  it('lists the seven mandatory banks', () => {
    expect([...registry.banks()].sort()).toEqual([...ALL_BANKS].sort());
  });

  it('Khan does not accept images; the others do (samples/README.md)', () => {
    expect(registry.policyFor('KHAN').acceptsImages).toBe(false);
    for (const bank of ALL_BANKS.filter((b) => b !== 'KHAN')) expect(registry.policyFor(bank).acceptsImages, bank).toBe(true);
  });

  it('a parser without a policy and an unregistered bank get the default policy', () => {
    const r = new StatementParserRegistry([new Stub('KHAN', 0.9)]);
    expect(r.policyFor('KHAN')).toEqual({ acceptsImages: true, printsNonStandardIban: false });
    expect(r.policyFor('MBANK')).toEqual({ acceptsImages: true, printsNonStandardIban: false });
  });

  it('every shipped parser is unverified until real samples exist', () => {
    for (const bank of ALL_BANKS) expect(registry.get(bank).verified, bank).toBe(false);
  });
});
