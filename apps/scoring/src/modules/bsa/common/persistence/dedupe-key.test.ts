import { describe, expect, it } from 'vitest';
import { accountKeyOf, buildDedupeKeys, type DedupeRow } from './dedupe-key';
import { TestPiiCipher } from './testing/test-pii-cipher';

const cipher = new TestPiiCipher();
const hash = (s: string) => cipher.hash(s);
const row = (o: Partial<DedupeRow> = {}): DedupeRow => ({ txnDate: '2026-03-10', txnTime: '09:15', direction: 'INCOME', amount: 100, balanceAfter: 1000, description: 'Synthetic payment', ...o });
const keys = (rows: DedupeRow[], account = 'MN00 0000 0001') => buildDedupeKeys(accountKeyOf(account, hash), rows, hash);

describe('buildDedupeKeys', () => {
  it('gives the same key to the same transaction found in two overlapping statements', () => {
    const fileA = [row({ description: 'one' }), row({ description: 'two', amount: 5 }), row({ description: 'three', amount: 7 })];
    const fileB = [row({ description: 'two', amount: 5 }), row({ description: 'three', amount: 7 }), row({ description: 'four', amount: 9 })];
    const a = keys(fileA);
    const b = keys(fileB);
    expect(b.slice(0, 2)).toEqual(a.slice(1, 3));
    expect(new Set([...a, ...b]).size).toBe(4);
  });

  it('keeps genuinely identical rows of one file apart (n-th occurrence) yet still matches them in an overlapping file', () => {
    const same = row({ balanceAfter: null, description: 'Coffee' });
    const a = keys([same, same, same]);
    expect(new Set(a).size).toBe(3);
    expect(keys([same, same])).toEqual(a.slice(0, 2));
  });

  it('differs when the account, date, time, direction, amount or balance differ', () => {
    const base = keys([row()])[0];
    for (const o of [{ txnDate: '2026-03-11' }, { txnTime: '09:16' }, { direction: 'EXPENSE' as const }, { amount: 100.01 }, { balanceAfter: 1000.01 }, { balanceAfter: null }]) {
      expect(keys([row(o)])[0]).not.toBe(base);
    }
    expect(keys([row()], 'MN00 0000 0002')[0]).not.toBe(base);
  });

  it('uses the description only when the statement has no balance column (balanced rows are fully identified without it)', () => {
    const noBalance = (description: string) => row({ balanceAfter: null, description });
    expect(keys([noBalance('Coffee')])[0]).not.toBe(keys([noBalance('Tea')])[0]);
    expect(keys([noBalance('  COFFEE   shop ')])[0]).toBe(keys([noBalance('coffee shop')])[0]);
  });

  it('matches the same row read from a PDF and from an OCR image even when OCR garbles the description', () => {
    const pdf = keys([row({ description: 'Salary 2026-03 #100' })]);
    const ocr = keys([row({ description: 'Sa1ary 2O26-O3 #1OO' })]);
    expect(ocr).toEqual(pdf);
  });

  it('ignores cosmetic differences: HH:mm vs HH:mm:ss, float noise, account formatting', () => {
    const base = keys([row()])[0];
    expect(keys([row({ txnTime: '09:15:00' })])[0]).toBe(base);
    expect(keys([row({ amount: 100.00000000000001 })])[0]).toBe(base);
    expect(keys([row()], 'mn00 0000 0001')[0]).toBe(base);
    expect(keys([row()], ' MN000000 00 01 ')[0]).toBe(base);
  });

  it('never contains the description or account in clear and is deterministic', () => {
    const [k] = keys([row({ description: 'Тест Овог 99001234' })], '9900123456');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(keys([row({ description: 'Тест Овог 99001234' })], '9900123456')[0]).toBe(k);
    expect(accountKeyOf(' 9900 123456 ', hash)).toBe(accountKeyOf('9900123456', hash));
  });

  it('returns nothing for no rows', () => {
    expect(keys([])).toEqual([]);
  });
});
