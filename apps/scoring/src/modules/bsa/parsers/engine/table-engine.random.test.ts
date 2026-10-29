// Seed-тэй санамсаргүй layout-ууд (SYNTHETIC): олон хослолыг нэг дор шалгана. Алдаа гарвал seed + layout-ыг мессежид хэвлэнэ.
import { describe, expect, it } from 'vitest';
import type { BankProfile } from './bank-profile';
import { parseTableStatement } from './table-engine';
import {
  DEFAULT_SYN_HEADER,
  generateTransactions,
  renderStatement,
  type SynColumn,
  type SynLayout,
} from './testing/synthetic-statement';

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

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)];
const chance = (r: () => number, p: number): boolean => r() < p;

const PROFILE: BankProfile = {
  bank: 'TDB',
  parserId: 'test-random-v1',
  verified: false,
  nameKeywords: ['Тест банк'],
  dateOrder: 'DMY',
  hasTime: true,
  acceptsImages: true,
};

function randomLayout(r: () => number): { layout: Partial<SynLayout>; label: string } {
  const money = pick(r, ['dc', 'cd', 'ie', 'ei', 'signed', 'typed', 'typedBeforeAmount'] as const);
  const balance = chance(r, 0.85);
  const time = pick(r, ['column', 'inDate', 'none'] as const);
  const cols: SynColumn[] = [];
  if (chance(r, 0.3)) cols.push('seq');
  cols.push('date');
  if (chance(r, 0.2)) cols.push('valueDate');
  if (time === 'column') cols.push('time');
  if (chance(r, 0.3)) cols.push('branch');
  cols.push('description');
  if (balance && chance(r, 0.25)) cols.push('prevBalance'); // мөр бүрийн "Эхний үлдэгдэл" (ignoreAmount)
  const block: SynColumn[] = {
    dc: ['debit', 'credit'],
    cd: ['credit', 'debit'],
    ie: ['income', 'expense'],
    ei: ['expense', 'income'],
    signed: ['amount'],
    typed: ['amount', 'type'],
    typedBeforeAmount: ['type', 'amount'],
  }[money] as SynColumn[];
  cols.push(...block);
  if (balance) cols.push('balance');
  const trailing = pick(r, [[], [], ['counterparty'], ['counterpartyAccount'], ['counterpartyAccount', 'counterpartyName']] as SynColumn[][]);
  cols.push(...trailing);
  const textMode = pick(r, ['cells', 'cells', 'cells', 'spaced'] as const);
  const amountStyle = pick(r, ['comma', 'space', 'plain'] as const);
  const layout: Partial<SynLayout> = {
    labels: pick(r, ['mn', 'en'] as const),
    columns: cols,
    dateFormat: pick(r, ['iso', 'dmy-dot', 'dmy-slash', 'mn-long'] as const),
    timeInDateCell: time === 'inDate',
    amountStyle,
    decimals: pick(r, [0, 2] as const),
    // Үлдэгдэл, тэмдэг байхгүй бол хоосон талыг '-'/'0.00'-ээр тэмдэглээгүй цэвэр хоосон нүд нь чиглэлийг тодорхойлох боломжгүй
    emptyAmount: balance || money === 'signed' || money.startsWith('typed') ? pick(r, ['0.00', '-', ''] as const) : pick(r, ['0.00', '-'] as const),
    plusSign: chance(r, 0.5),
    typeStyle: pick(r, ['word', 'drcr'] as const),
    // Урвуу дебит/кредитийг зөвхөн үлдэгдлийн өөрчлөлтөөр илрүүлнэ
    debitIsIncome: balance && (money === 'dc' || money === 'cd') && chance(r, 0.3),
    dropEmptyCells: chance(r, 0.5),
    newestFirst: chance(r, 0.4),
    rowsPerPage: pick(r, [3, 5, 8, 1000] as const),
    repeatHeader: chance(r, 0.8),
    pageFooters: chance(r, 0.5),
    pageTitleLines: chance(r, 0.5) ? ['Тест банк - Дансны хуулга'] : [],
    subtotalRows: chance(r, 0.5),
    wrapAt: pick(r, [null, null, 12, 20] as const),
    textMode,
    header: {
      ...DEFAULT_SYN_HEADER,
      placement: pick(r, ['inline', 'nextCell', 'nextLine'] as const),
      iban: chance(r, 0.3) ? 'MN580050099123456789' : undefined,
      showClosing: chance(r, 0.5),
      showCount: chance(r, 0.5),
      footerSummary: chance(r, 0.5),
      showOpening: balance,
    },
  };
  return { layout, label: JSON.stringify(layout) };
}

const strip = <T extends { sourcePage?: number; sourceLine?: number }>(t: T): Omit<T, 'sourcePage' | 'sourceLine'> => {
  const { sourcePage: _p, sourceLine: _l, ...rest } = t;
  return rest;
};

describe('table engine — random layouts (seeded, synthetic)', () => {
  it('parses 300 random layouts exactly', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const { layout, label } = randomLayout(r);
      const withTime = layout.timeInDateCell === true || (layout.columns ?? []).includes('time');
      const count = 5 + Math.floor(r() * 25);
      const txns = generateTransactions({ seed: seed * 7919, count, startDate: '2026-01-28', withTime, perDay: 3 }, 3_000_000);
      const { text, expected } = renderStatement(txns, 3_000_000, layout);
      const parsed = parseTableStatement(text, { ...PROFILE, spaceThousands: layout.amountStyle === 'space' });
      try {
        expect(parsed.transactions.map(strip)).toEqual(expected.transactions);
        expect(parsed.warnings.map((w) => w.code)).not.toContain('UNPARSED_ROW');
        expect(parsed.accountNo).toBe(expected.accountNo);
        expect(parsed.holderName).toBe(expected.holderName);
        expect(parsed.openingBalance).toBe(expected.openingBalance);
        expect(parsed.closingBalance).toBe(expected.closingBalance);
        expect(parsed.declaredRowCount).toBe(expected.declaredRowCount);
      } catch (e) {
        failures.push(`seed ${seed} (gen ${seed * 7919}, count ${count}): ${label}\n${(e as Error).message.split('\n').slice(0, 25).join('\n')}`);
        if (failures.length >= 3) break;
      }
    }
    expect(failures.join('\n\n')).toBe('');
  });
});
