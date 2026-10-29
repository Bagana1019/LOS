import { F, col } from '../report-filters';
import { REPAYING_STATUS } from '../report-labels';
import { LOAN_ID_COLUMNS, LOAN_TAIL_COLUMNS, OUT_PRINCIPAL, OUT_INTEREST, OUT_TOTAL, HAS_OUTSTANDING, REPAYING_STATUSES, dayText, disbursementCte, installmentsCte, loansCte, selectionOf, sql } from '../report-sql';
import { sqlReport } from '../sql-report';

// FR-13.3 #3 Зээлийн үлдэгдлийн дэлгэрэнгүй: ACTIVE/MIGRATED зээл тутамд олгосон дүн, төлсөн үндсэн, үлдэгдэл үндсэн,
// үлдэгдэл хүү (хугацаа болсон: due_date <= asOf), дараагийн төлөлт (due_date >= asOf-ийн хамгийн эртний үлдэгдэлтэй мөр).
// ЭТХ-гүй (эсвэл бүгд stale) зээлийн үлдэгдэл үндсэн = зээлийн дүн (DECISIONS: төлөлтийг ЭТХ-гүйгээр хуваарилах боломжгүй).
export const outstandingBalance = sqlReport({
  key: 'outstanding-balance',
  title: 'Зээлийн үлдэгдлийн дэлгэрэнгүй',
  description: 'Идэвхтэй болон эхний үлдэгдэлтэй зээл тус бүрийн олгосон дүн, төлсөн үндсэн, үндсэн ба хүүгийн үлдэгдэл, дараагийн төлөлт.',
  columns: [
    col('contractNo', 'Гэрээний дугаар', 'string', { width: 18 }),
    col('appNo', 'Хүсэлтийн дугаар', 'string', { width: 16 }),
    col('customerName', 'Зээлдэгч', 'string', { width: 24 }),
    col('registerNo', 'Регистр', 'string', { width: 14, sortable: false }),
    col('productName', 'Бүтээгдэхүүн', 'string', { width: 22 }),
    col('status', 'Төлөв', 'status', { width: 16, options: REPAYING_STATUS }),
    col('disbursedAmount', 'Олгосон дүн', 'money', { width: 16 }),
    col('paidPrincipal', 'Төлсөн үндсэн', 'money', { width: 16 }),
    col('outstandingPrincipal', 'Үндсэн үлдэгдэл', 'money', { width: 16 }),
    col('outstandingInterest', 'Хүүгийн үлдэгдэл (хугацаа болсон)', 'money', { width: 18 }),
    col('nextDueDate', 'Дараагийн төлөх огноо', 'date', { width: 14 }),
    col('nextDueAmount', 'Дараагийн төлөх дүн', 'money', { width: 16 }),
    col('currency', 'Валют', 'string', { width: 8 }),
    col('branchId', 'Салбар', 'string', { width: 12 }),
    col('officerId', 'ЗЭЗ', 'string', { width: 14 }),
  ],
  filters: [F.asOf, F.select('status', 'Зээлийн төлөв', REPAYING_STATUS), F.branch, F.officer, F.product, F.currency, F.search],
  defaultSort: { sortBy: 'outstandingPrincipal', sortDir: 'desc' },
  totalKeys: ['disbursedAmount', 'paidPrincipal', 'outstandingPrincipal', 'outstandingInterest'],
  build(input) {
    const f = input.filters;
    const statuses = f.status ? [f.status] : REPAYING_STATUSES;
    const base = sql`
      WITH ${loansCte(selectionOf(input, statuses))}, ${installmentsCte({ asOf: f.asOf })},
      ${disbursementCte},
      agg AS (
        SELECT i.application_id,
          SUM(LEAST(i.paid_principal, i.principal)) AS paid_principal,
          SUM(${OUT_PRINCIPAL}) AS out_principal,
          COALESCE(SUM(${OUT_INTEREST}) FILTER (WHERE i.due_date <= ${f.asOf}::date), 0) AS out_interest
        FROM inst i GROUP BY i.application_id
      ),
      nxt AS (
        SELECT DISTINCT ON (i.application_id) i.application_id, i.due_date, ${OUT_TOTAL} AS amount
        FROM inst i WHERE i.due_date >= ${f.asOf}::date AND ${HAS_OUTSTANDING}
        ORDER BY i.application_id, i.due_date, i.seq
      )
      SELECT l.id AS "_id", ${LOAN_ID_COLUMNS}, l.product_name AS "productName", l.status AS "status",
        COALESCE(disb.disburse_amount, l.amount, 0) AS "disbursedAmount",
        COALESCE(agg.paid_principal, 0) AS "paidPrincipal",
        COALESCE(agg.out_principal, l.amount, 0) AS "outstandingPrincipal",
        COALESCE(agg.out_interest, 0) AS "outstandingInterest",
        ${dayText('nxt.due_date')} AS "nextDueDate", nxt.amount AS "nextDueAmount", ${LOAN_TAIL_COLUMNS}
      FROM loans l
      LEFT JOIN agg ON agg.application_id = l.id
      LEFT JOIN nxt ON nxt.application_id = l.id
      LEFT JOIN disb ON disb.application_id = l.id`;
    return { base };
  },
});
