import { describe, expect, it } from 'vitest';
import { agingBucket } from '@los/calc';
import { AgingBucket } from '@los/contracts';
import { blindIndex } from '@los/database';
import { Prisma } from '.prisma/client-origination';
import { AGING_DPD_RANGES, and, escapeLike, ident, installmentsCte, loanConditions, searchCondition, selectionOf, sql, type LoanSelection } from './report-sql';
import type { ReportInput } from './report-types';

const baseSel: LoanSelection = { orgId: 'org-1', branchId: null, officerId: null, productId: null, currency: null, statuses: null, search: null };

describe('report-sql', () => {
  it('AGING_DPD_RANGES нь packages/calc agingBucket-тай бүх DPD (0..400)-д таарна', () => {
    for (let dpd = 0; dpd <= 400; dpd++) {
      const hit = AgingBucket.filter((b) => dpd >= AGING_DPD_RANGES[b].min && (AGING_DPD_RANGES[b].max === null || dpd <= (AGING_DPD_RANGES[b].max as number)));
      expect(hit, `dpd=${dpd}`).toEqual([agingBucket(dpd)]);
    }
  });

  it('ident: зөвхөн хүчинтэй нэр; инъекцийг няцаана', () => {
    expect(ident('outstandingPrincipal').text).toBe('"outstandingPrincipal"');
    expect(ident('_id').text).toBe('"_id"');
    for (const bad of ['', 'a b', 'a;b', 'a"b', '1abc', 'a-b', 'x; DROP TABLE t', 'a.b', "a'b"]) expect(() => ident(bad), bad).toThrow();
  });

  it('escapeLike: \\ % _', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('abc')).toBe('abc');
  });

  it('and: хоосон бол TRUE, үгүй бол AND-ээр', () => {
    expect(and([]).text).toBe('TRUE');
    const c = and([sql`a = ${1}`, sql`b = ${2}`]);
    expect(c.text).toBe('a = $1 AND b = $2');
    expect(c.values).toEqual([1, 2]);
  });

  it('loanConditions: бүх утга параметр, текстэд хэрэглэгчийн утга орохгүй', () => {
    const evil = "x'; DROP TABLE origination.loan_application; --";
    const c = Prisma.join(loanConditions({ orgId: 'org-1', branchId: evil, officerId: evil, productId: evil, currency: 'MNT', statuses: ['ACTIVE', 'MIGRATED'], search: evil }), ' AND ');
    expect(c.text).not.toContain('DROP');
    expect(c.text).not.toContain('org-1');
    expect(c.values).toContain(evil);
    expect(c.values).toContain('org-1');
    expect(c.values).toEqual(expect.arrayContaining(['ACTIVE', 'MIGRATED', 'MNT', `%${escapeLike(evil)}%`, blindIndex(evil)]));
  });

  it('loanConditions: сонгосон шүүлт л нөхцөл нэмнэ', () => {
    expect(loanConditions(baseSel)).toHaveLength(1);
    expect(loanConditions({ ...baseSel, branchId: 'b', officerId: 'o' })).toHaveLength(3);
    expect(loanConditions({ ...baseSel, statuses: [] })).toHaveLength(1); // хоосон жагсаалт = төлвөөр хязгаарлахгүй
  });

  it('searchCondition: LIKE-д escape хийсэн, регистр нь blind index-ээр яг таарна', () => {
    const c = searchCondition('50%');
    expect(c.values).toContain('%50\\%%');
    expect(c.values).toContain(blindIndex('50%'));
    expect(c.text).toContain('register_no_hash');
    expect(c.text).not.toContain('50%');
  });

  it('selectionOf: currency/search унтраах', () => {
    const input = { scope: { orgId: 'o', branchId: null, officerId: null }, filters: { asOf: '2026-10-28', dateFrom: null, dateTo: null, branchId: 'b', officerId: 'u', productId: 'p', currency: 'USD', status: null, provider: null, assetType: null, search: 's' }, sortBy: 'x', sortDir: 'asc', page: 1, pageSize: 10 } as ReportInput;
    expect(selectionOf(input, ['ACTIVE'])).toEqual({ orgId: 'o', branchId: 'b', officerId: 'u', productId: 'p', currency: 'USD', statuses: ['ACTIVE'], search: 's' });
    expect(selectionOf(input, null, { currency: false, search: false })).toMatchObject({ currency: null, search: null, statuses: null });
  });

  it('installmentsCte: төлбөрийн хязгаар = asOf+1 өдрийн UB эхлэл; due шүүлт сонголттой', () => {
    const plain = installmentsCte({ asOf: '2026-10-28' });
    expect(plain.values).toEqual(['2026-10-28T16:00:00.000']);
    expect(plain.text).toContain('payment_allocation');
    expect(plain.text).not.toContain('r.due_date >=');
    const ranged = installmentsCte({ asOf: '2026-12-31', dueFrom: '2026-12-01', dueTo: '2026-12-31' });
    expect(ranged.values).toEqual(['2026-12-31T16:00:00.000', '2026-12-01', '2026-12-31']);
    expect(ranged.text).toContain('r.due_date >=');
    expect(ranged.text).toContain('r.due_date <=');
  });
});
