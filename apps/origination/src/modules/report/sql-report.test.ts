import { describe, expect, it, vi } from 'vitest';
import type { ReportColumn } from '@los/contracts';
import type { PrismaService } from '../../prisma.service';
import { col } from './report-filters';
import { sql } from './report-sql';
import { executeSqlReport, sortAliases, sqlReport } from './sql-report';
import type { ReportInput } from './report-types';

const columns: ReportColumn[] = [col('name', 'Нэр', 'string'), col('amount', 'Дүн', 'money'), col('registerNo', 'Регистр', 'string', { sortable: false }), col('currency', 'Валют', 'string')];
const input = (o: Partial<ReportInput> = {}): ReportInput => ({
  scope: { orgId: 'o', branchId: null, officerId: null },
  filters: { asOf: '2026-10-28', dateFrom: null, dateTo: null, branchId: null, officerId: null, productId: null, currency: null, status: null, provider: null, assetType: null, search: null },
  sortBy: 'amount', sortDir: 'desc', page: 3, pageSize: 20, ...o,
});

function fakePrisma(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const prisma = {
    $executeRaw: (q: { text: string; values: unknown[] }) => { calls.push({ text: q.text, values: q.values }); return { kind: 'exec' }; },
    $queryRaw: (q: { text: string; values: unknown[] }) => { calls.push({ text: q.text, values: q.values }); return { kind: 'query' }; },
    $transaction: vi.fn(async () => [0, 0, rows]),
  };
  return { prisma: prisma as unknown as PrismaService, calls, tx: prisma.$transaction };
}

describe('sql-report', () => {
  it('sortAliases: зөвхөн sortable багана; override', () => {
    expect(sortAliases(columns)).toEqual({ name: 'name', amount: 'amount', currency: 'currency' });
    expect(sortAliases(columns, { amount: 'amt' }).amount).toBe('amt');
  });

  it('executeSqlReport: whitelist-д байхгүй эрэмбэ → SQL-д хүрэхгүйгээр алдаа', async () => {
    const { prisma, calls } = fakePrisma([]);
    for (const sortBy of ['registerNo', 'nope', 'amount; DROP TABLE x', '']) {
      await expect(executeSqlReport(prisma, { columns, base: sql`SELECT 1` }, sortAliases(columns), [], input({ sortBy })), sortBy).rejects.toThrow('Эрэмбэлэх боломжгүй');
    }
    expect(calls).toHaveLength(0);
  });

  it('executeSqlReport: нэг SQL (MATERIALIZED), JIT унтраасан, хуудас/offset параметр', async () => {
    const { prisma, calls, tx } = fakePrisma([{ _total: 45, _currencies: 1, _sum_amount: '1500.255', _id: 'a', name: 'А', amount: '100.005', currency: 'MNT', _registerEnc: null }]);
    const res = await executeSqlReport(prisma, { columns, base: sql`SELECT ${'x'}::text AS "_id"` }, sortAliases(columns), ['amount'], input());
    expect(tx).toHaveBeenCalledTimes(1);
    const [setJit, setTimeout, main] = calls;
    expect(setJit.text).toMatch(/SET LOCAL jit = off/);
    expect(setTimeout.text).toBe('SET LOCAL statement_timeout = 30000');
    expect(main.text).toContain('WITH q AS MATERIALIZED (');
    expect(main.text).toContain('ORDER BY q."amount" DESC NULLS LAST, q."_id" ASC LIMIT $2 OFFSET $3');
    expect(main.values).toEqual(['x', 20, 40]);
    expect(res.total).toBe(45);
    expect(res.totals).toEqual({ amount: 1500.26 });
    expect(res.mixedCurrency).toBeUndefined();
    expect(res.rows).toEqual([{ name: 'А', amount: 100.01, registerNo: null, currency: 'MNT' }]);
  });

  it('хуудас хоосон (_id null) → мөргүй, нийт тоо хэвээр; олон валют → totals байхгүй', async () => {
    const { prisma } = fakePrisma([{ _total: 7, _currencies: 2, _sum_amount: 10, _id: null, name: null }]);
    const res = await executeSqlReport(prisma, { columns, base: sql`SELECT 1` }, sortAliases(columns), ['amount'], input());
    expect(res).toEqual({ rows: [], total: 7, mixedCurrency: true });
  });

  it('maxRows (экспортын хамгаалалт): нийт тоо хэтэрвэл pg хоосон болох нөхцөл SQL-д орно; тохируулаагүй бол орохгүй', async () => {
    const plain = fakePrisma([]);
    await executeSqlReport(plain.prisma, { columns, base: sql`SELECT 1` }, sortAliases(columns), [], input());
    expect(plain.calls.at(-1)!.text).not.toContain('(SELECT "_total" FROM agg) <=');

    const capped = fakePrisma([{ _total: 9, _currencies: 1, _id: null }]);
    const res = await executeSqlReport(capped.prisma, { columns, base: sql`SELECT ${'x'}::text AS "_id"` }, sortAliases(columns), [], input({ page: 1, pageSize: 6, maxRows: 5 }));
    const main = capped.calls.at(-1)!;
    expect(main.text).toContain('pg AS (SELECT * FROM q WHERE (SELECT "_total" FROM agg) <= $2 ORDER BY');
    expect(main.values).toEqual(['x', 5, 6, 0]); // base, maxRows, LIMIT, OFFSET
    expect(res).toEqual({ rows: [], total: 9 });
  });

  it('statement_timeout: анхдагч 30с, input.statementTimeoutMs-ээр дарж болно; буруу утга няцаагдана', async () => {
    const { prisma, calls } = fakePrisma([]);
    await executeSqlReport(prisma, { columns, base: sql`SELECT 1` }, sortAliases(columns), [], input({ statementTimeoutMs: 120_000 }));
    expect(calls[1].text).toBe('SET LOCAL statement_timeout = 120000');
    await expect(executeSqlReport(prisma, { columns, base: sql`SELECT 1` }, sortAliases(columns), [], input({ statementTimeoutMs: 0 }))).rejects.toThrow('statement_timeout');
  });

  it('том хариуг хөрвүүлэхдээ 1000 мөр тутамд event loop-д амс өгнө', async () => {
    const raws = Array.from({ length: 2500 }, (_, i) => ({ _total: 2500, _currencies: 1, _id: `id-${i}`, name: `Н${i}`, amount: i, currency: 'MNT', _registerEnc: null }));
    const { prisma } = fakePrisma(raws);
    const spy = vi.spyOn(globalThis, 'setImmediate');
    try {
      const res = await executeSqlReport(prisma, { columns, base: sql`SELECT 1` }, sortAliases(columns), [], input({ page: 1, pageSize: 5000 }));
      expect(res.rows).toHaveLength(2500);
      expect(res.rows[2499]).toMatchObject({ name: 'Н2499', amount: 2499 });
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2); // 1000, 2000-р мөрийн дараа
    } finally {
      spy.mockRestore();
    }
  });

  it('sqlReport: ReportDefinition үүсгэнэ (dataSource origination)', () => {
    const def = sqlReport({ key: 'closed-loans', title: 'T', description: 'D', columns, filters: [], defaultSort: { sortBy: 'amount', sortDir: 'desc' }, totalKeys: ['amount'], build: () => ({ base: sql`SELECT 1` }) });
    expect(def.dataSource({ deposit: { mode: 'mock' } as never })).toBe('origination');
    expect(def.totalKeys).toEqual(['amount']);
  });
});
