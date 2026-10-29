import { F, col } from '../report-filters';
import { LOAN_ID_COLUMNS, LOAN_TAIL_COLUMNS, and, disbursementCte, loansCte, selectionOf, sql, ubDateOf, type Sql } from '../report-sql';
import { sqlReport } from '../sql-report';

// FR-13.3 #4 Хаагдсан зээл: status = CLOSED. Хаагдсан огнооны багана байхгүй тул closedDate = сүүлийн төлбөрийн өдөр (UB);
// төлбөр байхгүй бол updatedAt (UB). dateFrom/dateTo нь closedDate-д (DECISIONS.md).
export const closedLoans = sqlReport({
  key: 'closed-loans',
  title: 'Хаагдсан зээл',
  description: 'Бүрэн төлөгдөж хаагдсан зээлүүд: олгосон дүн, нийт төлсөн хүү ба үндсэн. Хаагдсан огноо = сүүлийн төлбөрийн өдөр (байхгүй бол сүүлд өөрчилсөн өдөр).',
  columns: [
    col('contractNo', 'Гэрээний дугаар', 'string', { width: 18 }),
    col('appNo', 'Хүсэлтийн дугаар', 'string', { width: 16 }),
    col('customerName', 'Зээлдэгч', 'string', { width: 24 }),
    col('registerNo', 'Регистр', 'string', { width: 14, sortable: false }),
    col('productName', 'Бүтээгдэхүүн', 'string', { width: 22 }),
    col('disbursedAmount', 'Олгосон дүн', 'money', { width: 16 }),
    col('termMonths', 'Хугацаа (сар)', 'number', { width: 10 }),
    col('interestRate', 'Хүү (жилээр)', 'percent', { width: 12 }),
    col('disbursedDate', 'Олгосон огноо', 'date', { width: 14 }),
    col('closedDate', 'Хаагдсан огноо', 'date', { width: 14 }),
    col('paymentCount', 'Төлбөрийн тоо', 'number', { width: 10 }),
    col('interestPaid', 'Төлсөн хүү', 'money', { width: 16 }),
    col('principalPaid', 'Төлсөн үндсэн', 'money', { width: 16 }),
    col('totalPaid', 'Нийт төлсөн', 'money', { width: 16 }),
    col('currency', 'Валют', 'string', { width: 8 }),
    col('branchId', 'Салбар', 'string', { width: 12 }),
    col('officerId', 'ЗЭЗ', 'string', { width: 14 }),
  ],
  filters: [F.dateFrom('Хаагдсан (эхлэх)'), F.dateTo('Хаагдсан (дуусах)'), F.branch, F.officer, F.product, F.currency, F.search],
  defaultSort: { sortBy: 'closedDate', sortDir: 'desc' },
  totalKeys: ['disbursedAmount', 'paymentCount', 'interestPaid', 'principalPaid', 'totalPaid'],
  build(input) {
    const f = input.filters;
    const dateConds: Sql[] = [];
    if (f.dateFrom) dateConds.push(sql`t."closedDate" >= ${f.dateFrom}`);
    if (f.dateTo) dateConds.push(sql`t."closedDate" <= ${f.dateTo}`);
    const base = sql`
      WITH ${loansCte(selectionOf(input, ['CLOSED']))}, ${disbursementCte},
      pay AS (
        SELECT p.application_id, COUNT(*)::int AS cnt, SUM(p.amount) AS total, MAX(p.paid_at) AS last_paid
        FROM origination.payment p JOIN loans l ON l.id = p.application_id GROUP BY p.application_id
      ),
      al AS (
        SELECT p.application_id, SUM(a.interest_paid) AS interest_paid, SUM(a.principal_paid) AS principal_paid
        FROM origination.payment p JOIN loans l ON l.id = p.application_id JOIN origination.payment_allocation a ON a.payment_id = p.id
        GROUP BY p.application_id
      )
      SELECT * FROM (
        SELECT l.id AS "_id", ${LOAN_ID_COLUMNS}, l.product_name AS "productName",
          COALESCE(disb.disburse_amount, l.amount, 0) AS "disbursedAmount", l.term_months AS "termMonths", (l.interest_rate / 100) AS "interestRate",
          ${ubDateOf('l.disbursed_at')} AS "disbursedDate", ${ubDateOf('COALESCE(pay.last_paid, l.updated_at)')} AS "closedDate",
          COALESCE(pay.cnt, 0) AS "paymentCount", COALESCE(al.interest_paid, 0) AS "interestPaid", COALESCE(al.principal_paid, 0) AS "principalPaid",
          COALESCE(pay.total, 0) AS "totalPaid", ${LOAN_TAIL_COLUMNS}
        FROM loans l
        LEFT JOIN pay ON pay.application_id = l.id
        LEFT JOIN al ON al.application_id = l.id
        LEFT JOIN disb ON disb.application_id = l.id
      ) t
      WHERE ${and(dateConds)}`;
    return { base };
  },
});
