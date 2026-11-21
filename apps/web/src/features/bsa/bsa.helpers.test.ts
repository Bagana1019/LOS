import { describe, expect, it } from 'vitest';
import { BankCode, BsaUploadBanks } from '@los/contracts';
import { bankOptions, banksField, categoryGroups, categoryName, directionSummary, directionsOf, formatConfidence, formatStepValue, type BsaCategory } from './bsa.helpers';

const cat = (code: string, direction: BsaCategory['direction'], name: string, isActive = true): BsaCategory => ({ code, direction, name, groupCode: 'A', isActive });
const CATEGORIES: BsaCategory[] = [
  cat('SALARY', 'INCOME', 'Хөдөлмөрийн орлого (цалин)'),
  cat('LOAN_PROCEEDS', 'INCOME', 'Зээл (авсан зээлийн олголт)'),
  cat('LOAN_PAYMENT', 'EXPENSE', 'Зээлийн төлбөр'),
  cat('OLD', 'EXPENSE', 'Хуучин идэвхгүй ангилал', false),
];

describe('bankOptions (F6-5)', () => {
  it('offers exactly the contract banks in contract order, labelled in Mongolian (never the raw code)', () => {
    const o = bankOptions();
    expect(o.map((b) => b.value)).toEqual([...BankCode]);
    for (const b of o) expect(b.label).not.toBe(b.value);
    expect(o.find((b) => b.value === 'KHAN')?.label).toBe('Хаан банк');
  });
});

describe('banksField (F6-5)', () => {
  it('repeats the chosen bank once per file, in the shape the upload endpoint validates', () => {
    const field = banksField(2, 'KHAN');
    expect(field).toBe('["KHAN","KHAN"]');
    expect(BsaUploadBanks.safeParse(JSON.parse(field as string)).success).toBe(true);
  });
  it('omits the field when no bank is chosen or there are no files (server auto-detects)', () => {
    expect(banksField(3, undefined)).toBeNull();
    expect(banksField(3, null)).toBeNull();
    expect(banksField(0, 'KHAN')).toBeNull();
  });
});

describe('directionsOf / directionSummary (F6-9, F6-11)', () => {
  const income = { direction: 'INCOME' as const };
  const expense = { direction: 'EXPENSE' as const };
  it('collects the distinct directions of the selected signals, income first', () => {
    expect(directionsOf([{ transactions: [expense] }, { transactions: [income, expense] }])).toEqual(['INCOME', 'EXPENSE']);
    expect(directionsOf([{ transactions: [expense] }])).toEqual(['EXPENSE']);
    expect(directionsOf([])).toEqual([]);
  });
  it('summarises one signal as income, expense, both, or unknown', () => {
    expect(directionSummary([income, income])).toBe('INCOME');
    expect(directionSummary([expense])).toBe('EXPENSE');
    expect(directionSummary([income, expense])).toBe('BOTH');
    expect(directionSummary([])).toBeNull();
  });
});

describe('categoryGroups (F6-9)', () => {
  const labels = (g: ReturnType<typeof categoryGroups>) => g.flatMap((x) => x.options.map((o) => o.label));
  it('shows only active categories of the selected direction, labelled by Mongolian name with the code as value', () => {
    const g = categoryGroups(CATEGORIES, ['INCOME']);
    expect(g).toHaveLength(1);
    expect(g[0]?.options).toEqual([
      { value: 'SALARY', label: 'Хөдөлмөрийн орлого (цалин)' },
      { value: 'LOAN_PROCEEDS', label: 'Зээл (авсан зээлийн олголт)' },
    ]);
  });
  it('a mixed selection yields an income group then an expense group; inactive categories never appear', () => {
    const g = categoryGroups(CATEGORIES, ['INCOME', 'EXPENSE']);
    expect(g.map((x) => x.label)).toEqual(['Орлогын ангилал', 'Зарлагын ангилал']);
    expect(labels(g)).toEqual(['Хөдөлмөрийн орлого (цалин)', 'Зээл (авсан зээлийн олголт)', 'Зээлийн төлбөр']);
  });
  it('without a known direction both groups are offered, and an empty direction group is omitted', () => {
    expect(categoryGroups(CATEGORIES, [])).toHaveLength(2);
    expect(categoryGroups([cat('LOAN_PAYMENT', 'EXPENSE', 'Зээлийн төлбөр')], ['INCOME'])).toEqual([]);
  });
});

describe('categoryName', () => {
  it('maps a code to its Mongolian name, and null for unknown or missing codes', () => {
    expect(categoryName('LOAN_PROCEEDS', CATEGORIES)).toBe('Зээл (авсан зээлийн олголт)');
    expect(categoryName('NOPE', CATEGORIES)).toBeNull();
    expect(categoryName(null, CATEGORIES)).toBeNull();
  });
});

describe('formatConfidence (F6-11)', () => {
  it('renders the 0..100 confidence as a percent and null as "no value"', () => {
    expect(formatConfidence(85)).toBe('85%');
    expect(formatConfidence(0)).toBe('0%');
    expect(formatConfidence(null)).toBeNull();
  });
});

describe('formatStepValue (F6-14)', () => {
  it('groups big amounts and keeps ratios readable', () => {
    expect(formatStepValue(2_800_000)).toBe('2,800,000');
    expect(formatStepValue(0.179)).toBe('0.179');
    expect(formatStepValue(0.123456)).toBe('0.1235');
    expect(formatStepValue(0)).toBe('0');
  });
});
