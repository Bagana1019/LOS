import { describe, expect, it } from 'vitest';
import { CONTRACT_NUMBER_TOKENS, ContractNumberTemplateBody } from '@los/contracts';
import { formatContractNo } from './approval.rules';

// F9-21 · BR-11: загварын хэсгүүдийн жагсаалт (@los/contracts) нь дугаар үүсгэгч `formatContractNo`-той яг нийцэх ёстой.
// Нэг тал нь нөгөөгөөсөө салбал `{...}` дугаарт шууд орно ("LN-{YYYY}-7") эсвэл зөв загвар хадгалагдахгүй.
const PARTS = { prefix: 'LN', branch: '100', yymmdd: '261121', seq: 7 };
const accepts = (pattern: string, seqScope: 'DAY' | 'BRANCH' | 'GLOBAL' = 'GLOBAL') => ContractNumberTemplateBody.safeParse({ pattern, prefix: 'LN', seqScope }).success;

describe('contract number tokens: schema <-> formatContractNo (F9-21)', () => {
  it.each(CONTRACT_NUMBER_TOKENS.map((x) => x.token.replace(':n', ':3')))('the advertised token %s is fully replaced by the generator (no braces left in the number)', (sample) => {
    const out = formatContractNo(sample, PARTS);
    expect(out).not.toMatch(/[{}]/);
    expect(out.length).toBeGreaterThan(0);
  });

  it('every pattern the schema accepts renders to a brace-free number', () => {
    const accepted: Array<[string, 'DAY' | 'BRANCH' | 'GLOBAL']> = [
      ['{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', 'DAY'], // seed default
      ['{PREFIX}-{BRANCH}-{SEQ:4}', 'BRANCH'],
      ['{PREFIX}-{SEQ:4}', 'GLOBAL'],
      ['{SEQ}', 'GLOBAL'],
      ['{SEQ:10}', 'GLOBAL'],
    ];
    for (const [pattern, scope] of accepted) {
      expect(accepts(pattern, scope), pattern).toBe(true);
      expect(formatContractNo(pattern, PARTS), pattern).not.toMatch(/[{}]/);
    }
  });

  it('the original symptom: the generator would put {YYYY} into the number, and the schema now rejects that pattern', () => {
    expect(formatContractNo('{PREFIX}-{YYYY}-{SEQ}', PARTS)).toBe('LN-{YYYY}-7');
    expect(accepts('{PREFIX}-{YYYY}-{SEQ}')).toBe(false);
  });

  it('a template stored before the rule existed still reads and generates (the generator never validates; only saving does)', () => {
    expect(() => formatContractNo('{PREFIX}-{YYYY}-{SEQ}', PARTS)).not.toThrow();
    expect(() => formatContractNo('{PREFIX}/{SEQ}{SEQ}', PARTS)).not.toThrow();
  });

  it('the width bound is the real limit: {SEQ:10} renders, a width past the bound would throw RangeError at approval time', () => {
    expect(formatContractNo('{SEQ:10}', PARTS)).toBe('0000000007');
    expect(accepts('{SEQ:11}')).toBe(false);
    expect(() => formatContractNo('{SEQ:99999999999}', PARTS)).toThrow(RangeError);
    expect(accepts('{SEQ:99999999999}')).toBe(false);
  });
});
