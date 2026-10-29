// Бодит жишээ файлын hook. /home/claude/LOS/samples/<khan|golomt|tdb|xac|capitron|state|m-bank>/* — одоогоор ХООСОН (README.md л байна).
// Файл ирмэгц: зэрэгцээ .txt dump (жишээ нь a.pdf + a.txt) байвал StatementTextService-гүйгээр parse → банк таних → verifierOk=true гэж шалгана.
// Бүгд тэнцвэл banks/<bank>.parser.ts-ийн profile.verified-ийг true болгоно (README.md). Dump байхгүй файл → todo (dump үүсгэх).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BANK_PARSERS } from '../banks';
import { statementTextFromDump, statementTextToDump } from '../engine/text-dump';
import { StatementParserRegistry } from '../parser.registry';
import { verifyStatement } from '../verifier/verify-statement';
import { BANK_SPECS, bankStatement, specTransactions } from '../banks/testing/bank-specs';
import { discoverSamples, SAMPLE_DIRS } from './samples-hook';

const registry = new StatementParserRegistry(BANK_PARSERS.map((C) => new C()));
/** Репогийн суурь: apps/scoring/src/modules/bsa/parsers/tests → 7 түвшин дээш */
const SAMPLES_ROOT = process.env.LOS_SAMPLES_DIR ?? path.resolve(__dirname, '../../../../../../../samples');

describe('real bank samples (samples/)', () => {
  const samples = discoverSamples(SAMPLES_ROOT);

  if (samples.length === 0) {
    it.skip('samples/ is empty — TODO(samples): add real statements (and .txt dumps) per bank to verify the parsers', () => undefined);
  }

  for (const sample of samples) {
    if (sample.dump === null) {
      it.todo(`${sample.name}: create a sibling .txt dump (pages split by form feed, lines by newline, cells by TAB) to run the parser on it`);
      continue;
    }
    const dump = sample.dump;
    it(`${sample.name}: bank is recognised and the verifier accepts the statement`, () => {
      const text = statementTextFromDump(dump, { source: 'PDF_TEXT', meta: { fileName: path.basename(sample.name), mimeType: sample.mimeType } });
      const detected = registry.detect(text);
      expect(detected.parser.bank).toBe(sample.bank);
      const parsed = registry.parse(text);
      const result = verifyStatement(parsed, { policy: registry.policyFor(sample.bank) }, text.meta);
      // Хувийн мэдээлэл алдахгүйн тулд зөвхөн кодыг харуулна
      const errors = result.issues.filter((i) => i.severity === 'ERROR').map((i) => i.code);
      expect(errors, 'verifier errors').toEqual([]);
      expect(result.verifierOk).toBe(true);
      expect(parsed.transactions.length).toBeGreaterThan(0);
    });
  }
});

describe('samples hook itself (SYNTHETIC samples in a temporary folder)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bsa-samples-hook-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds nothing in an empty or missing samples folder', () => {
    expect(discoverSamples(path.join(root, 'does-not-exist'))).toEqual([]);
    for (const dir of Object.keys(SAMPLE_DIRS)) mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, 'khan', 'README.md'), '# placeholder');
    writeFileSync(path.join(root, 'khan', '.gitkeep'), '');
    expect(discoverSamples(root)).toEqual([]);
  });

  it('pairs an original with its sibling dump, lists originals without a dump, and treats a lone dump as a sample', () => {
    const spec = BANK_SPECS.TDB;
    const { text } = bankStatement(spec, specTransactions(spec));
    const dump = statementTextToDump(text);
    writeFileSync(path.join(root, 'tdb', 'a.pdf'), 'x');
    writeFileSync(path.join(root, 'tdb', 'a.txt'), dump);
    writeFileSync(path.join(root, 'tdb', 'b.pdf'), 'x');
    writeFileSync(path.join(root, 'tdb', 'c.pdf'), 'x');
    writeFileSync(path.join(root, 'tdb', 'c.pdf.txt'), dump);
    writeFileSync(path.join(root, 'tdb', 'lone.txt'), dump);
    writeFileSync(path.join(root, 'm-bank', 'p.png'), 'x');
    const found = discoverSamples(root);
    const by = Object.fromEntries(found.map((s) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(['m-bank/p.png', 'tdb/a.pdf', 'tdb/b.pdf', 'tdb/c.pdf', 'tdb/lone.txt']);
    expect(by['tdb/a.pdf']).toMatchObject({ bank: 'TDB', mimeType: 'application/pdf', dump });
    expect(by['tdb/b.pdf'].dump).toBeNull();
    expect(by['tdb/c.pdf'].dump).toBe(dump);
    expect(by['tdb/lone.txt']).toMatchObject({ mimeType: 'text/plain', dump });
    expect(by['m-bank/p.png']).toMatchObject({ bank: 'MBANK', mimeType: 'image/png', dump: null });
  });

  it('a discovered synthetic dump goes through the same path as a real sample (parse, detect, verify)', () => {
    const spec = BANK_SPECS.TDB;
    const sample = discoverSamples(root).find((s) => s.name === 'tdb/a.pdf');
    expect(sample?.dump).toBeTruthy();
    const text = statementTextFromDump(sample?.dump ?? '', { source: 'PDF_TEXT', meta: { mimeType: 'application/pdf' } });
    expect(registry.detect(text).parser.bank).toBe(spec.bank);
    const parsed = registry.parse(text);
    expect(verifyStatement(parsed, {}, text.meta).verifierOk).toBe(true);
  });

  it('every samples/ folder maps to one of the seven mandatory banks', () => {
    expect(Object.values(SAMPLE_DIRS).sort()).toEqual(['CAPITRON', 'GOLOMT', 'KHAN', 'MBANK', 'STATE', 'TDB', 'XAC']);
  });
});
