import { agingBucket } from '@los/calc';
import type { AgingBucket } from '@los/contracts';
import { F, col } from '../report-filters';
import { AGING_BUCKET } from '../report-labels';
import { AGING_DPD_RANGES, HAS_OUTSTANDING, LOAN_ID_COLUMNS, LOAN_TAIL_COLUMNS, OUT_INTEREST, OUT_PRINCIPAL, REPAYING_STATUSES, and, dayText, installmentsCte, loansCte, selectionOf, sql, type Sql } from '../report-sql';
import { toNumber } from '../report-values';
import { sqlReport } from '../sql-report';

// FR-13.3 #2 Хугацаа хэтэрсэн: зээл тутамд хамгийн эртний хэтэрсэн мөрөөс DPD (asOf − due_date), хэтэрсэн мөрийн тоо/дүн, ангилал.
// `status` шүүлт = DPD ангилал (AgingBucket). Ангиллын нэр нь packages/calc `agingBucket`-аар (нэг эх сурвалж).
export const overdueLoans = sqlReport({
  key: 'overdue-loans',
  title: 'Хугацаа хэтэрсэн зээл',
  description: 'Эргэн төлөлт нь хугацаа хэтэрсэн зээлүүд: хамгийн эртний хэтэрсэн мөрөөс тооцсон хоног (DPD), хэтэрсэн дүн, ангилал.',
  columns: [
    col('contractNo', 'Гэрээний дугаар', 'string', { width: 18 }),
    col('appNo', 'Хүсэлтийн дугаар', 'string', { width: 16 }),
    col('customerName', 'Зээлдэгч', 'string', { width: 24 }),
    col('registerNo', 'Регистр', 'string', { width: 14, sortable: false }),
    col('oldestDueDate', 'Хамгийн эртний хэтэрсэн огноо', 'date', { width: 18 }),
    col('dpd', 'Хэтэрсэн хоног', 'number', { width: 12 }),
    col('bucket', 'Ангилал', 'status', { width: 14, options: AGING_BUCKET }),
    col('overdueInstallments', 'Хэтэрсэн мөр', 'number', { width: 10 }),
    col('overduePrincipal', 'Хэтэрсэн үндсэн', 'money', { width: 16 }),
    col('overdueInterest', 'Хэтэрсэн хүү', 'money', { width: 16 }),
    col('overdueTotal', 'Хэтэрсэн нийт', 'money', { width: 16 }),
    col('outstandingPrincipal', 'Нийт үндсэн үлдэгдэл', 'money', { width: 18 }),
    col('currency', 'Валют', 'string', { width: 8 }),
    col('branchId', 'Салбар', 'string', { width: 12 }),
    col('officerId', 'ЗЭЗ', 'string', { width: 14 }),
  ],
  filters: [F.select('status', 'Ангилал (DPD)', AGING_BUCKET.filter((o) => o.value !== 'CURRENT')), F.asOf, F.branch, F.officer, F.product, F.currency, F.search],
  defaultSort: { sortBy: 'dpd', sortDir: 'desc' },
  totalKeys: ['overdueInstallments', 'overduePrincipal', 'overdueInterest', 'overdueTotal', 'outstandingPrincipal'],
  sortAlias: { bucket: 'dpd' },
  build(input) {
    const f = input.filters;
    const range = f.status ? AGING_DPD_RANGES[f.status as AgingBucket] : null;
    const bucketConds: Sql[] = [];
    if (range) {
      bucketConds.push(sql`t."dpd" >= ${range.min}`);
      if (range.max !== null) bucketConds.push(sql`t."dpd" <= ${range.max}`);
    }
    const base = sql`
      WITH ${loansCte(selectionOf(input, REPAYING_STATUSES))}, ${installmentsCte({ asOf: f.asOf })},
      od AS (
        SELECT i.application_id, MIN(i.due_date) AS oldest_due, COUNT(*)::int AS cnt,
          SUM(${OUT_PRINCIPAL}) AS od_principal, SUM(${OUT_INTEREST}) AS od_interest
        FROM inst i WHERE i.due_date < ${f.asOf}::date AND ${HAS_OUTSTANDING}
        GROUP BY i.application_id
      ),
      bal AS (SELECT i.application_id, SUM(${OUT_PRINCIPAL}) AS out_principal FROM inst i GROUP BY i.application_id)
      SELECT * FROM (
        SELECT l.id AS "_id", ${LOAN_ID_COLUMNS},
          ${dayText('od.oldest_due')} AS "oldestDueDate", (${f.asOf}::date - od.oldest_due) AS "dpd", od.cnt AS "overdueInstallments",
          od.od_principal AS "overduePrincipal", od.od_interest AS "overdueInterest", (od.od_principal + od.od_interest) AS "overdueTotal",
          bal.out_principal AS "outstandingPrincipal", ${LOAN_TAIL_COLUMNS}
        FROM od JOIN loans l ON l.id = od.application_id JOIN bal ON bal.application_id = od.application_id
      ) t
      WHERE ${and(bucketConds)}`;
    return { base, derive: { bucket: (raw) => agingBucket(toNumber(raw.dpd) ?? 0) } };
  },
});
