// Robustness / fuzz: хог оролт, хоосон хуудас, 20k мөр < 3 с, adversarial урт мөр (regex backtracking-гүй). SYNTHETIC, seed-тэй.
import { describe, expect, it, vi } from 'vitest';
import { BANK_PARSERS } from '../banks';
import { ALL_BANKS, BANK_SPECS, bankStatement, SPEC_OPENING } from '../banks/testing/bank-specs';
import { syntheticMeta } from '../engine/text-dump';
import { generateTransactions } from '../engine/testing/synthetic-statement';
import { analyzeCoverage, dedupeAcrossStatements } from '../coverage';
import { StatementParserRegistry, UnsupportedBankError } from '../parser.registry';
import type { ParsedStatement, StatementText, StatementTextLine } from '../statement.types';
import { verifyStatement } from '../verifier/verify-statement';

// Энэ файлын тестүүд том оролттой — секундээр хэмжигдэх хугацааны шаардлагыг тест бүр дотроо шалгана, vitest-ийн 5 с хязгаар саад болохгүй
vi.setConfig({ testTimeout: 60_000 });

const parsers = BANK_PARSERS.map((C) => new C());
const registry = new StatementParserRegistry(parsers);
const META = syntheticMeta({ fileName: 'fuzz.pdf', mimeType: 'application/pdf' });

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const line = (text: string, cells?: string[]): StatementTextLine => ({ text, cells: cells ?? [text] });
const textOf = (...pages: StatementTextLine[][]): StatementText => ({
  source: 'PDF_TEXT',
  pages: pages.map((lines, i) => ({ pageNo: i + 1, lines })),
  meta: META,
});

const ALPHABET = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '.', '-', '+', ':', '/', ' ', ' ', '  ', '\t', 'a', 'Z', 'Д', 'ө', 'ү', 'банк', 'Bank', 'Дебит', 'Огноо', '2026-03-01', '12:30', '1,234.00', 'MN64', '(', ')', '₮', '№', '\u0000', '​', '😀', '‮'];
function garbageLine(r: () => number): StatementTextLine {
  const n = Math.floor(r() * 30);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
  const cells = r() < 0.5 ? s.split('\t') : [s];
  return { text: cells.join(' '), cells };
}

/** parse() үр дүнгийн хэлбэр: гүйлгээ тус бүр эерэг дүнтэй, зөв огноотой, seq 1..N */
function expectWellFormed(p: ParsedStatement): void {
  expect(Array.isArray(p.transactions)).toBe(true);
  expect(Array.isArray(p.warnings)).toBe(true);
  p.transactions.forEach((t, i) => {
    expect(t.seq).toBe(i + 1);
    expect(t.txnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isFinite(t.amount)).toBe(true);
    expect(t.amount).toBeGreaterThan(0);
    expect(['INCOME', 'EXPENSE']).toContain(t.direction);
    expect(t.balanceAfter === null || Number.isFinite(t.balanceAfter)).toBe(true);
    expect(typeof t.description).toBe('string');
  });
}

describe('garbage and degenerate input', () => {
  it('random garbage text never throws; detect stays within 0..1 and parse is well formed (100 documents x 7 banks)', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed);
      const pages = Array.from({ length: 1 + Math.floor(r() * 3) }, () => Array.from({ length: Math.floor(r() * 40) }, () => garbageLine(r)));
      const text = textOf(...pages);
      for (const p of parsers) {
        const score = p.detect(text);
        expect(score, `seed ${seed} ${p.bank}`).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
        expectWellFormed(p.parse(text));
      }
    }
  });

  it('garbage mixed into a valid statement does not break the valid rows', () => {
    const spec = BANK_SPECS.GOLOMT;
    const txns = generateTransactions({ seed: 3, count: 20, startDate: '2026-02-01', withTime: false }, SPEC_OPENING);
    const { text, expected } = bankStatement(spec, txns, { header: { showClosing: true, footerSummary: true } });
    const r = rng(99);
    const page = text.pages[0];
    const noisy: StatementTextLine[] = [];
    for (const l of page.lines) {
      noisy.push(l);
      if (r() < 0.2) noisy.push(line('~~~ ### @@@ ??? ~~~'));
    }
    const parsed = spec.parser.parse({ ...text, pages: [{ ...page, lines: noisy }] });
    expect(parsed.transactions.map((t) => [t.txnDate, t.direction, t.amount, t.balanceAfter])).toEqual(
      expected.transactions.map((t) => [t.txnDate, t.direction, t.amount, t.balanceAfter]),
    );
  });

  it('zero pages, empty pages, blank lines and whitespace-only lines', () => {
    const cases: StatementText[] = [
      { source: 'TEXT', pages: [], meta: META },
      textOf([]),
      textOf([], [], []),
      textOf([line('')], [line('   '), line('\t\t')]),
      textOf([line('', [])]),
      textOf([{ text: '', cells: [] }, { text: 'x', cells: [] }]),
    ];
    for (const text of cases) {
      for (const p of parsers) {
        expect(p.detect(text)).toBe(0);
        const parsed = p.parse(text);
        expect(parsed.transactions).toEqual([]);
        expect(parsed.bank).toBe(p.bank);
      }
      expect(() => registry.detect(text)).toThrow(UnsupportedBankError);
    }
  });

  it('control characters, NUL, zero-width and RTL marks, emoji, lone surrogates', () => {
    const weird = ['\u0000\u0001\u0002', '​‌‍﻿', '‮2026-03-01‬', '😀😀😀', '\ud800', 'Хаан​банк', '\u0000'.repeat(1000)];
    const text = textOf(weird.map((w) => line(w)));
    for (const p of parsers) {
      expect(() => p.detect(text)).not.toThrow();
      expectWellFormed(p.parse(text));
    }
  });

  it('a header-only statement (no rows) parses to zero transactions with the header fields', () => {
    const spec = BANK_SPECS.TDB;
    const { text } = bankStatement(spec, []);
    const parsed = spec.parser.parse(text);
    expect(parsed.transactions).toEqual([]);
    expect(parsed.accountNo).toBe('5011223344');
  });

  it('a statement of only a table header and page footers', () => {
    const text = textOf([line('Огноо\tЦаг\tУтга\tДебит\tКредит\tҮлдэгдэл', ['Огноо', 'Цаг', 'Утга', 'Дебит', 'Кредит', 'Үлдэгдэл']), line('Хуудас 1/1')]);
    for (const p of parsers) expect(p.parse(text).transactions).toEqual([]);
  });

  it('registry: garbage is unsupported, never another error type', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = rng(seed * 31);
      const text = textOf(Array.from({ length: 30 }, () => garbageLine(r)));
      try {
        registry.detect(text);
      } catch (e) {
        expect(e).toBeInstanceOf(UnsupportedBankError);
      }
    }
  });
});

describe('mutated valid statements (structure-aware fuzz)', () => {
  it('random line drops, duplicates, shuffles, truncations and cell garbage never break the parser (300 mutations)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 101);
      const spec = BANK_SPECS[ALL_BANKS[seed % ALL_BANKS.length]];
      const txns = generateTransactions({ seed, count: 4 + Math.floor(r() * 25), startDate: '2026-02-20', withTime: spec.withTime }, SPEC_OPENING);
      const { text } = bankStatement(spec, txns, {
        rowsPerPage: [3, 6, 1000][seed % 3],
        wrapAt: seed % 4 === 0 ? 14 : null,
        newestFirst: seed % 5 === 0,
        subtotalRows: seed % 2 === 0,
        pageFooters: seed % 3 === 0,
      });
      const pages = text.pages.map((pg) => {
        let lines = pg.lines.map((l) => ({ text: l.text, cells: [...l.cells] }));
        const ops = 1 + Math.floor(r() * 6);
        for (let k = 0; k < ops && lines.length > 0; k++) {
          const at = Math.floor(r() * lines.length);
          const op = Math.floor(r() * 7);
          if (op === 0) lines.splice(at, 1);
          else if (op === 1) lines.splice(at, 0, { ...lines[at], cells: [...lines[at].cells] });
          else if (op === 2) {
            const to = Math.floor(r() * lines.length);
            [lines[at], lines[to]] = [lines[to], lines[at]];
          } else if (op === 3) {
            const cut = Math.floor(r() * (lines[at].text.length + 1));
            lines[at] = { text: lines[at].text.slice(0, cut), cells: [lines[at].text.slice(0, cut)] };
          } else if (op === 4) {
            const cells = lines[at].cells.map((c) => (r() < 0.3 ? garbageLine(r).text : c));
            lines[at] = { text: cells.join(' '), cells };
          } else if (op === 5) lines.splice(at, 0, garbageLine(r));
          else lines = lines.slice(0, at + 1);
        }
        return { ...pg, lines };
      });
      const mutated: StatementText = { ...text, pages };
      for (const p of [spec.parser, parsers[(seed * 3) % parsers.length]]) {
        expect(() => p.detect(mutated), `seed ${seed}`).not.toThrow();
        expectWellFormed(p.parse(mutated));
      }
      // Мутацитай ч гэсэн верификатор унахгүй
      const parsed = spec.parser.parse(mutated);
      expect(() => verifyStatement(parsed, {}, META)).not.toThrow();
    }
  });
});

describe('performance (20k rows < 3 s)', () => {
  const BIG = 20_000;
  const time = <T>(fn: () => T): { ms: number; value: T } => {
    const t = Date.now();
    const value = fn();
    return { ms: Date.now() - t, value };
  };
  const bigTxns = (withTime: boolean) => generateTransactions({ seed: 17, count: BIG, startDate: '2024-01-01', withTime, perDay: 25 }, 5_000_000);

  it('Khan-like layout (8 columns, positional): 20k rows', () => {
    const spec = BANK_SPECS.KHAN;
    const { text, expected } = bankStatement(spec, bigTxns(true), { rowsPerPage: 50 });
    const { ms, value } = time(() => spec.parser.parse(text));
    expect(value.transactions).toHaveLength(BIG);
    expect(value.transactions.at(-1)?.balanceAfter).toBe(expected.transactions.at(-1)?.balanceAfter);
    expect(ms).toBeLessThan(3000);
  });

  it('TDB-like layout with dropped empty cells, wrapped descriptions, subtotals and footers (alignment fallback): 20k rows', () => {
    const spec = BANK_SPECS.TDB;
    const { text } = bankStatement(spec, bigTxns(true), { wrapAt: 14, subtotalRows: true, pageFooters: true, rowsPerPage: 40 });
    const { ms, value } = time(() => spec.parser.parse(text));
    expect(value.transactions).toHaveLength(BIG);
    expect(ms).toBeLessThan(3000);
  });

  it('single text cell per line (token mode): 20k rows', () => {
    const spec = BANK_SPECS.MBANK;
    const { text } = bankStatement(spec, bigTxns(true), { textMode: 'single', amountStyle: 'space', rowsPerPage: 100 });
    const { ms, value } = time(() => spec.parser.parse(text));
    expect(value.transactions).toHaveLength(BIG);
    expect(ms).toBeLessThan(3000);
  });

  it('newest-first 20k rows are reversed correctly within the limit', () => {
    const spec = BANK_SPECS.XAC;
    const { text } = bankStatement(spec, bigTxns(false), { newestFirst: true });
    const { ms, value } = time(() => spec.parser.parse(text));
    expect(value.transactions).toHaveLength(BIG);
    expect(value.warnings.map((w) => w.code)).toContain('REVERSED_ORDER');
    expect(ms).toBeLessThan(3000);
  });

  it('detect + verify of 20k rows are fast too', () => {
    const spec = BANK_SPECS.GOLOMT;
    const { text } = bankStatement(spec, bigTxns(false), { header: { showClosing: true, showCount: true, footerSummary: true } });
    const detect = time(() => registry.detect(text));
    expect(detect.value.parser.bank).toBe('GOLOMT');
    expect(detect.ms).toBeLessThan(1000);
    const parsed = spec.parser.parse(text);
    const verify = time(() => verifyStatement(parsed, {}, META));
    expect(verify.value.verifierOk).toBe(true);
    expect(verify.ms).toBeLessThan(3000);
  });

  it('coverage and dedupe of large inputs', () => {
    const periods = Array.from({ length: 20_000 }, (_, i) => ({ from: '2024-01-01', to: '2024-01-31', account: String(i % 100) }));
    expect(time(() => analyzeCoverage(periods, { from: '2024-01-01', to: '2024-12-31' })).ms).toBeLessThan(3000);
    const rows = generateTransactions({ seed: 5, count: 20_000, startDate: '2024-01-01', withTime: true }, SPEC_OPENING).map((t) => ({
      txnDate: t.date,
      txnTime: t.time ?? null,
      amount: t.amount,
      direction: t.direction,
      balanceAfter: null,
      description: t.description,
    }));
    const d = time(() => dedupeAcrossStatements([rows, rows]));
    expect(d.value.dropped).toBe(20_000);
    expect(d.ms).toBeLessThan(3000);
  });
});

describe('adversarial long lines (no catastrophic backtracking)', () => {
  const N = 50_000;
  const evil: Array<[string, string]> = [
    ['plain letters', 'a'.repeat(N * 4)],
    ['digits', '1'.repeat(N)],
    ['digit groups', '1 '.repeat(N)],
    ['thousand groups', '1,000'.repeat(N / 4)],
    ['commas and dots', '.,'.repeat(N)],
    ['dates', '2026-03-10 '.repeat(N / 10)],
    ['times', '12:30 '.repeat(N / 5)],
    ['amount tokens', '1,234.56 '.repeat(N / 9)],
    ['minus signs', '-'.repeat(N)],
    ['label colons', 'Дансны дугаар: '.repeat(N / 15)],
    ['labels without values', 'Данс '.repeat(N / 5)],
    ['IBAN-like', 'MN12 3456 '.repeat(N / 10)],
    ['spaces', ' '.repeat(N)],
    ['tabs', '\t'.repeat(N)],
    ['brackets', '('.repeat(N)],
    ['header words', 'Огноо Дебит Кредит Үлдэгдэл '.repeat(N / 28)],
    ['cyrillic names', 'Бат-Эрдэнэ '.repeat(N / 11)],
    ['register-like', 'УБ'.repeat(N / 2)],
  ];

  it.each(evil)('%s as a plain line and as a table row: every bank parser answers within a second', (_name, payload) => {
    const spec = BANK_SPECS.KHAN;
    const { text } = bankStatement(spec, generateTransactions({ seed: 2, count: 5, startDate: '2026-03-01', withTime: true }, SPEC_OPENING));
    const page = text.pages[0];
    const adversarial: StatementText = {
      ...text,
      pages: [
        {
          ...page,
          lines: [
            line(payload),
            ...page.lines,
            line(payload),
            line(`2026-03-10 ${payload}`),
            { text: payload, cells: ['2026-03-10', payload, payload, payload] },
            { text: payload, cells: Array.from({ length: 2000 }, () => payload.slice(0, 20)) },
          ],
        },
      ],
    };
    const t = Date.now();
    for (const p of parsers) {
      p.detect(adversarial);
      expectWellFormed(p.parse(adversarial));
    }
    expect(Date.now() - t).toBeLessThan(7000); // 7 parser x (detect + parse)
  });

  it('a 5 MB single line is clipped, not scanned in full', () => {
    const text = textOf([line('x'.repeat(5_000_000))], [line('2026-03-01 ' + '9'.repeat(5_000_000))]);
    const t = Date.now();
    for (const p of parsers) expectWellFormed(p.parse(text));
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('100k lines of garbage', () => {
    const r = rng(7);
    const lines = Array.from({ length: 100_000 }, () => garbageLine(r));
    const t = Date.now();
    expectWellFormed(parsers[0].parse(textOf(lines)));
    // ~3 s alone; CI runs the services' suites in parallel and doubles it. A backtracking blow-up takes minutes.
    expect(Date.now() - t).toBeLessThan(15_000);
  });
});

describe('verifier on malformed results', () => {
  it('never throws and always returns a well formed result (random mutations)', () => {
    const spec = BANK_SPECS.KHAN;
    const base = spec.parser.parse(bankStatement(spec, generateTransactions({ seed: 4, count: 15, startDate: '2026-03-01', withTime: true }, SPEC_OPENING)).text);
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const p = structuredClone(base);
      for (const t of p.transactions) {
        if (r() < 0.1) t.balanceAfter = r() < 0.5 ? null : Math.round(r() * 1e7) / 100;
        if (r() < 0.05) t.amount = Math.round(r() * 1e6) / 100 + 0.01;
        if (r() < 0.05) t.txnDate = ['2026-03-01', '1999-01-01', '2100-12-31'][Math.floor(r() * 3)];
        if (r() < 0.05) t.txnTime = null;
        if (r() < 0.05) t.description = '';
      }
      if (r() < 0.3) p.transactions.reverse();
      if (r() < 0.3) p.transactions = p.transactions.slice(0, Math.floor(r() * p.transactions.length));
      if (r() < 0.3) p.declaredRowCount = Math.floor(r() * 30);
      if (r() < 0.3) p.openingBalance = null;
      if (r() < 0.3) p.closingBalance = Math.round(r() * 1e7) / 100;
      if (r() < 0.2) p.iban = ['', 'MN', 'garbage', 'MN640005123456789012', null][Math.floor(r() * 5)] as string | null;
      if (r() < 0.2) p.holderName = ['', ' ', 'x'.repeat(500), 'Дорж'][Math.floor(r() * 4)];
      const result = verifyStatement(p, { customer: { names: ['Дорж Бат', ''], registerNo: r() < 0.5 ? 'УБ90010203' : '??' } }, META);
      expect(typeof result.parserOk).toBe('boolean');
      expect(typeof result.verifierOk).toBe('boolean');
      expect(result.verifierOk).toBe(!result.issues.some((i) => i.severity === 'ERROR'));
      for (const i of result.issues) expect(i.message.length).toBeGreaterThan(0);
    }
  });
});

describe('every bank at once', () => {
  it('the same statement text is read consistently by the intended parser only', () => {
    for (const bank of ALL_BANKS) {
      const spec = BANK_SPECS[bank];
      const { text } = bankStatement(spec, generateTransactions({ seed: 8, count: 6, startDate: '2026-03-01', withTime: spec.withTime }, SPEC_OPENING));
      const winners = parsers.filter((p) => p.detect(text) >= 0.5).map((p) => p.bank);
      expect(winners).toEqual([bank]);
    }
  });
});
