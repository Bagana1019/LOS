import { decryptedField, maskAccountNo, maskRegisterNo } from '@los/database';
import type { ReportRow } from '@los/contracts';
import type { DepositAccountBalance, DepositCustomerRef } from '../../../integrations/core-deposit/core-deposit.port';
import { F, col } from '../report-filters';
import { CURRENCY, DEPOSIT_STATUS, REPAYING_STATUS } from '../report-labels';
import { REPAYING_STATUSES, loanConditions, and, selectionOf, sql } from '../report-sql';
import { fullName, round, toNumber, type Raw } from '../report-values';
import type { ReportDefinition, ReportRunResult } from '../report-types';

// FR-13.3 #9 Депозит дансны үлдэгдэл: ACTIVE/MIGRATED зээлийн үндсэн/хамтран зээлдэгчдийн Core-ийн депозит данс.
// Өгөгдөл Core-оос (CoreDepositPort) — mock горимд регистрээс deterministic тоо (`dataSource: 'core-mock'`); real = NotImplemented.
// `currency` шүүлт нь ДАНСНЫ валют (зээлийнх биш). Эрэмбэ/хуудаслалт/нийлбэр санах ойд.
const columns = [
  col('customerName', 'Харилцагч', 'string', { width: 24 }),
  col('registerNo', 'Регистр', 'string', { width: 14, sortable: false }),
  col('accountNo', 'Дансны дугаар', 'string', { width: 16, sortable: false }),
  col('currency', 'Валют', 'string', { width: 8 }),
  col('balance', 'Үлдэгдэл', 'money', { width: 18 }),
  col('availableBalance', 'Боломжит үлдэгдэл', 'money', { width: 18 }),
  col('accountStatus', 'Дансны төлөв', 'status', { width: 14, options: DEPOSIT_STATUS }),
  col('loanCount', 'Зээлийн тоо', 'number', { width: 10 }),
  col('contractNos', 'Гэрээний дугаарууд', 'string', { width: 30 }),
];
const SORTABLE = new Set(columns.filter((c) => c.sortable).map((c) => c.key));

interface Holder { customerId: string; registerNo: string; name: string | null; loanCount: number; contractNos: string | null }

export const depositBalances: ReportDefinition = {
  key: 'deposit-balances',
  title: 'Депозит дансны үлдэгдэл',
  description: 'Зээлдэгчдийн Core-ийн депозит дансны үлдэгдэл. Өгөгдөл Core-оос (одоогоор mock) ирнэ.',
  columns,
  filters: [F.asOf, F.select('status', 'Зээлийн төлөв', REPAYING_STATUS), F.branch, F.officer, F.product, { ...F.currency, label: 'Дансны валют', options: CURRENCY }, F.search],
  defaultSort: { sortBy: 'balance', sortDir: 'desc' },
  totalKeys: ['balance', 'availableBalance'],
  dataSource: (deps) => (deps.deposit.mode === 'real' ? 'core' : 'core-mock'),

  async run(deps, input): Promise<ReportRunResult> {
    const f = input.filters;
    const statuses = f.status ? [f.status] : REPAYING_STATUSES;
    const sel = selectionOf(input, statuses, { currency: false });
    const raws = await deps.prisma.$queryRaw<Raw[]>(sql`
      SELECT c.id AS "customerId", c.register_no_encrypted AS "registerEnc", c.first_name AS "firstName", c.last_name AS "lastName",
        COUNT(DISTINCT la.id)::int AS "loanCount", string_agg(DISTINCT la.contract_no, ', ' ORDER BY la.contract_no) AS "contractNos"
      FROM origination.loan_application la
      JOIN origination.loan_application_borrower b ON b.application_id = la.id AND b.role IN ('PRIMARY', 'CO_BORROWER')
      JOIN origination.customer c ON c.id = b.customer_id
      WHERE ${and(loanConditions(sel))}
      GROUP BY c.id`);

    const holders = new Map<string, Holder>();
    for (const r of raws) {
      let registerNo: string;
      try { registerNo = decryptedField(String(r.registerEnc)); } catch { continue; } // тайлах боломжгүй регистртэй харилцагчийг алгасна (Core-оос асууж болохгүй)
      holders.set(String(r.customerId), { customerId: String(r.customerId), registerNo, name: fullName(r.lastName, r.firstName), loanCount: toNumber(r.loanCount) ?? 0, contractNos: r.contractNos == null ? null : String(r.contractNos) });
    }
    const customers: DepositCustomerRef[] = [...holders.values()].map((h) => ({ customerId: h.customerId, registerNo: h.registerNo }));
    const balances: DepositAccountBalance[] = customers.length ? await deps.deposit.listBalances({ asOf: f.asOf, customers }) : [];

    const entries = balances
      .filter((b) => holders.has(b.customerId) && (!f.currency || b.currency === f.currency))
      .map((b) => ({ b, h: holders.get(b.customerId) as Holder }));

    const key = SORTABLE.has(input.sortBy) ? input.sortBy : 'balance';
    const sortValue = (e: (typeof entries)[number]): string | number | null => {
      switch (key) {
        case 'customerName': return e.h.name;
        case 'currency': return e.b.currency;
        case 'balance': return e.b.balance;
        case 'availableBalance': return e.b.availableBalance;
        case 'accountStatus': return e.b.status;
        case 'loanCount': return e.h.loanCount;
        default: return null;
      }
    };
    const sign = input.sortDir === 'desc' ? -1 : 1;
    entries.sort((x, y) => {
      const a = sortValue(x); const bv = sortValue(y);
      if (a === null || bv === null) { if (a === bv) return stableTie(x, y); return a === null ? 1 : -1; } // NULL үргэлж төгсгөлд
      const c = typeof a === 'number' && typeof bv === 'number' ? a - bv : String(a) < String(bv) ? -1 : String(a) > String(bv) ? 1 : 0;
      return c !== 0 ? sign * c : stableTie(x, y);
    });

    const total = entries.length;
    if (input.maxRows !== undefined && total > input.maxRows) return { rows: [], total }; // экспортын хязгаар: мөр бүтээхгүй
    const page = entries.slice((input.page - 1) * input.pageSize, input.page * input.pageSize);
    const rows: ReportRow[] = page.map(({ b, h }) => ({
      customerName: h.name,
      registerNo: maskRegisterNo(h.registerNo),
      accountNo: maskAccountNo(b.accountNo),
      currency: b.currency,
      balance: round(b.balance, 2),
      availableBalance: round(b.availableBalance, 2),
      accountStatus: b.status,
      loanCount: h.loanCount,
      contractNos: h.contractNos,
    }));

    const result: ReportRunResult = { rows, total };
    if (new Set(entries.map((e) => e.b.currency)).size > 1) result.mixedCurrency = true;
    else result.totals = { balance: round(entries.reduce((s, e) => s + e.b.balance, 0), 2), availableBalance: round(entries.reduce((s, e) => s + e.b.availableBalance, 0), 2) };
    return result;
  },
};

/** Эрэмбийн утга тэнцүү үед тогтвортой дараалал: харилцагч, дансны дугаар. */
function stableTie(x: { b: DepositAccountBalance }, y: { b: DepositAccountBalance }): number {
  const a = `${x.b.customerId}:${x.b.accountNo}`; const b = `${y.b.customerId}:${y.b.accountNo}`;
  return a < b ? -1 : a > b ? 1 : 0;
}
