import { F, col } from '../report-filters';
import { PAYMENT_PROVIDER } from '../report-labels';
import { LOAN_ID_COLUMNS, LOAN_TAIL_COLUMNS, and, loansCte, selectionOf, sql, ubDateOf, type Sql } from '../report-sql';
import { addDays } from '@los/calc';
import { ubDayStartUtc } from '../report-dates';
import { sqlReport } from '../sql-report';

// FR-13.3 #6 Зээл хүү төлөлт: paid_at нь dateFrom..dateTo (UB өдөр)-д байгаа төлбөрүүдийг зээл тутамд нэгтгэнэ.
// Хүү/үндсэн = payment_allocation-ийн Σ; unallocated = ЭТХ-д хуваарилагдаагүй илүү төлөлт; totalPaid = Σ payment.amount (= хүү + үндсэн + unallocated).
export const interestPayments = sqlReport({
  key: 'interest-payments',
  title: 'Зээл хүү төлөлт',
  description: 'Сонгосон хугацаанд хүлээн авсан төлбөрүүд зээл тутамд: төлсөн хүү, үндсэн зээл, хуваарилагдаагүй дүн. Төлбөрийн хэлбэрээр шүүнэ.',
  columns: [
    col('contractNo', 'Гэрээний дугаар', 'string', { width: 18 }),
    col('appNo', 'Хүсэлтийн дугаар', 'string', { width: 16 }),
    col('customerName', 'Зээлдэгч', 'string', { width: 24 }),
    col('registerNo', 'Регистр', 'string', { width: 14, sortable: false }),
    col('providers', 'Төлбөрийн хэлбэр', 'string', { width: 20 }),
    col('paymentCount', 'Төлбөрийн тоо', 'number', { width: 10 }),
    col('lastPaidDate', 'Сүүлийн төлөлт', 'date', { width: 14 }),
    col('interestPaid', 'Төлсөн хүү', 'money', { width: 16 }),
    col('principalPaid', 'Төлсөн үндсэн', 'money', { width: 16 }),
    col('unallocated', 'Хуваарилагдаагүй', 'money', { width: 16 }),
    col('totalPaid', 'Нийт төлсөн', 'money', { width: 16 }),
    col('currency', 'Валют', 'string', { width: 8 }),
    col('branchId', 'Салбар', 'string', { width: 12 }),
    col('officerId', 'ЗЭЗ', 'string', { width: 14 }),
  ],
  filters: [F.dateFrom('Төлсөн (эхлэх)'), F.dateTo('Төлсөн (дуусах)'), F.select('provider', 'Төлбөрийн хэлбэр', PAYMENT_PROVIDER), F.branch, F.officer, F.product, F.currency, F.search],
  defaultSort: { sortBy: 'lastPaidDate', sortDir: 'desc' },
  totalKeys: ['paymentCount', 'interestPaid', 'principalPaid', 'unallocated', 'totalPaid'],
  build(input) {
    const f = input.filters;
    const conds: Sql[] = [];
    if (f.dateFrom) conds.push(sql`p.paid_at >= ${ubDayStartUtc(f.dateFrom)}::timestamp`);
    if (f.dateTo) conds.push(sql`p.paid_at < ${ubDayStartUtc(addDays(f.dateTo, 1))}::timestamp`);
    if (f.provider) conds.push(sql`p.provider = ${f.provider}`);
    const base = sql`
      WITH ${loansCte(selectionOf(input, null))},
      pay AS (
        SELECT p.id, p.application_id, p.provider, p.amount, p.unallocated_amount, p.paid_at,
          COALESCE(SUM(a.interest_paid), 0) AS interest_paid, COALESCE(SUM(a.principal_paid), 0) AS principal_paid
        FROM origination.payment p
        JOIN loans l ON l.id = p.application_id
        LEFT JOIN origination.payment_allocation a ON a.payment_id = p.id
        WHERE ${and(conds)}
        GROUP BY p.id
      ),
      grp AS (
        SELECT application_id, COUNT(*)::int AS cnt, MAX(paid_at) AS last_paid, SUM(amount) AS total, SUM(unallocated_amount) AS unalloc,
          SUM(interest_paid) AS interest_paid, SUM(principal_paid) AS principal_paid, string_agg(DISTINCT provider, ', ' ORDER BY provider) AS providers
        FROM pay GROUP BY application_id
      )
      SELECT l.id AS "_id", ${LOAN_ID_COLUMNS}, grp.providers AS "providers", grp.cnt AS "paymentCount",
        ${ubDateOf('grp.last_paid')} AS "lastPaidDate", grp.interest_paid AS "interestPaid", grp.principal_paid AS "principalPaid",
        grp.unalloc AS "unallocated", grp.total AS "totalPaid", ${LOAN_TAIL_COLUMNS}
      FROM grp JOIN loans l ON l.id = grp.application_id`;
    return { base };
  },
});
