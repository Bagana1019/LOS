// Synthetic fixture-үүд (apps/scoring/test-fixtures/bsa/parsers/**): .txt dump → registry → parser → verifier, хүлээгдэх JSON-той яг тулгана.
// UPDATE_FIXTURES=1 үед файлуудыг тодорхойлолтоос дахин үүсгэнэ. БҮХ ӨГӨГДӨЛ ЗОХИОМОЛ.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANK_PARSERS } from '../banks';
import { SYNTHETIC_BANNER } from '../banks/testing/bank-specs';
import { statementTextFromDump } from '../engine/text-dump';
import { StatementParserRegistry } from '../parser.registry';
import { verifyStatement } from '../verifier/verify-statement';
import { buildFixture, FIXTURE_DIR, FIXTURES } from './fixtures-spec';

const ROOT = path.resolve(__dirname, '../../../../../test-fixtures/bsa/parsers');
const registry = new StatementParserRegistry(BANK_PARSERS.map((C) => new C()));
const UPDATE = process.env.UPDATE_FIXTURES === '1';
const jsonText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const strip = <T extends { sourcePage?: number; sourceLine?: number }>(t: T): Omit<T, 'sourcePage' | 'sourceLine'> => {
  const { sourcePage: _p, sourceLine: _l, ...rest } = t;
  return rest;
};

const README = `# SYNTHETIC parser fixtures

Every file in this folder is **synthetic**: made-up names, accounts, register numbers and amounts produced by
\`src/modules/bsa/parsers/tests/fixtures-spec.ts\`. No real bank statement, person or account is represented.
The per-bank layouts are **assumptions** (TODO(samples): samples/ is empty), not copies of real statements.

- \`<bank>/<name>.txt\` — text dump (pages split by form feed, lines by newline, cells by TAB)
- \`<bank>/<name>.expected.json\` — the exact result the generator knows to be true

Regenerate: \`UPDATE_FIXTURES=1 npx vitest run src/modules/bsa/parsers/tests/fixtures.test.ts\`
`;

if (UPDATE) {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(path.join(ROOT, 'README.md'), README);
  for (const def of FIXTURES) {
    const dir = path.join(ROOT, FIXTURE_DIR[def.bank]);
    mkdirSync(dir, { recursive: true });
    const built = buildFixture(def);
    writeFileSync(path.join(dir, `${def.name}.txt`), built.dump);
    writeFileSync(path.join(dir, `${def.name}.expected.json`), jsonText(built.expected));
  }
}

describe('synthetic fixtures', () => {
  it('the fixture folder contains exactly the files the definitions generate (no stale or missing files)', () => {
    const onDisk: string[] = [];
    for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
      if (dir.isDirectory()) for (const f of readdirSync(path.join(ROOT, dir.name))) onDisk.push(`${dir.name}/${f}`);
    }
    const expectedFiles = FIXTURES.flatMap((d) => [`${FIXTURE_DIR[d.bank]}/${d.name}.txt`, `${FIXTURE_DIR[d.bank]}/${d.name}.expected.json`]);
    expect(onDisk.sort()).toEqual(expectedFiles.sort());
    expect(existsSync(path.join(ROOT, 'README.md'))).toBe(true);
    expect(readFileSync(path.join(ROOT, 'README.md'), 'utf8')).toContain('synthetic');
  });

  for (const def of FIXTURES) {
    const base = path.join(ROOT, FIXTURE_DIR[def.bank], def.name);
    describe(`${def.bank} / ${def.name}`, () => {
      const dump = readFileSync(`${base}.txt`, 'utf8');
      const expected = JSON.parse(readFileSync(`${base}.expected.json`, 'utf8')) as ReturnType<typeof buildFixture>['expected'];

      it('is marked synthetic and equals what the definition generates (generator is the source of truth)', () => {
        expect(dump.startsWith(SYNTHETIC_BANNER)).toBe(true);
        expect(expected._synthetic).toBe(true);
        expect(expected._note).toContain('SYNTHETIC');
        const built = buildFixture(def);
        expect(dump).toBe(built.dump);
        expect(expected).toEqual(JSON.parse(jsonText(built.expected)));
      });

      it('the bank is recognised from the dump and the transactions and header match the expected JSON exactly', () => {
        const text = statementTextFromDump(dump, { source: 'PDF_TEXT', meta: { fileName: `${def.name}.pdf`, mimeType: 'application/pdf' } });
        expect(registry.detect(text).parser.bank).toBe(def.bank);
        const parsed = registry.parse(text);
        expect(parsed.bank).toBe(def.bank);
        expect(parsed.parserVerified).toBe(false);
        expect(parsed.transactions.map(strip)).toEqual(expected.transactions);
        for (const key of ['accountNo', 'iban', 'holderName', 'currency', 'periodFrom', 'periodTo', 'openingBalance', 'closingBalance', 'declaredRowCount'] as const) {
          expect(parsed[key], key).toBe(expected[key]);
        }
        expect(parsed.holderRegisterNo ?? null).toBe(expected.holderRegisterNo);
        expect(parsed.warnings.map((w) => w.code)).not.toContain('UNPARSED_ROW');
      });

      it('the verifier accepts it (only the unverified-parser warning remains)', () => {
        const text = statementTextFromDump(dump, { source: 'PDF_TEXT', meta: { mimeType: 'application/pdf' } });
        const parsed = registry.parse(text);
        const result = verifyStatement(parsed, { policy: registry.policyFor(def.bank) }, text.meta);
        expect(result.verifierOk).toBe(true);
        expect(result.issues.map((i) => i.code)).toEqual(['UNVERIFIED_PARSER']);
      });
    });
  }
});
