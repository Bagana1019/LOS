import { Prisma } from '.prisma/client-origination';
import { F, col } from '../report-filters';
import { DISBURSEMENT_STATUS, REPAYMENT_TYPE } from '../report-labels';
import { DISBURSED_STATUSES, LOAN_ID_COLUMNS, LOAN_TAIL_COLUMNS, and, dayText, loansCte, selectionOf, sql, type Sql } from '../report-sql';
import { sqlReport } from '../sql-report';

// FR-13.3 #5 Олгосон зээл: disbursement_request (APPROVED | SENT_TO_CORE), disburse_date нь dateFrom..dateTo-д.
// Огноо шүүлт өгөөгүй бол бүх олголт; disburse_date хоосон мөр зөвхөн огноо шүүлтгүй үед орно.
export const disbursedLoans = sqlReport({
  key: 'disbursed-loans',
  title: 'Олгосон зээл',
  description: 'Зээл олгох хүсэлт зөвшөөрөгдсөн (Core-д илгээсэн) зээлүүд: олгосон дүн, хүү, хугацаа, бүтээгдэхүүн, Core-ийн зээлийн дугаар.',
  columns: [
    col('contractNo', 'Гэрээний дугаар', 'string', { width: 18 }),
    col('appNo', 'Хүсэлтийн дугаар', 'string', { width: 16 }),
    col('customerName', 'Зээлдэгч', 'string', { width: 24 }),
    col('registerNo', 'Регистр', 'string', { width: 14, sortable: false }),
    col('productName', 'Бүтээгдэхүүн', 'string', { width: 22 }),
    col('disburseDate', 'Олгосон огноо', 'date', { width: 14 }),
    col('approvedAmount', 'Батлагдсан дүн', 'money', { width: 16 }),
    col('disburseAmount', 'Олгосон дүн', 'money', { width: 16 }),
    col('interestRate', 'Хүү (жилээр)', 'percent', { width: 12 }),
    col('termMonths', 'Хугацаа (сар)', 'number', { width: 10 }),
    col('repaymentType', 'Эргэн төлөлтийн хэлбэр', 'status', { width: 18, options: REPAYMENT_TYPE }),
    col('coreLoanId', 'Core зээлийн дугаар', 'string', { width: 18 }),
    col('status', 'Олголтын төлөв', 'status', { width: 16, options: DISBURSEMENT_STATUS }),
    col('currency', 'Валют', 'string', { width: 8 }),
    col('branchId', 'Салбар', 'string', { width: 12 }),
    col('officerId', 'ЗЭЗ', 'string', { width: 14 }),
  ],
  filters: [F.dateFrom('Олгосон (эхлэх)'), F.dateTo('Олгосон (дуусах)'), F.select('status', 'Олголтын төлөв', DISBURSEMENT_STATUS), F.branch, F.officer, F.product, F.currency, F.search],
  defaultSort: { sortBy: 'disburseDate', sortDir: 'desc' },
  totalKeys: ['approvedAmount', 'disburseAmount'],
  build(input) {
    const f = input.filters;
    const conds: Sql[] = [f.status ? sql`d.status = ${f.status}` : sql`d.status IN (${Prisma.join([...DISBURSED_STATUSES])})`];
    if (f.dateFrom) conds.push(sql`d.disburse_date >= ${f.dateFrom}::date`);
    if (f.dateTo) conds.push(sql`d.disburse_date <= ${f.dateTo}::date`);
    const base = sql`
      WITH ${loansCte(selectionOf(input, null))}
      SELECT d.id AS "_id", ${LOAN_ID_COLUMNS}, l.product_name AS "productName", ${dayText('d.disburse_date')} AS "disburseDate",
        d.approved_amount AS "approvedAmount", d.disburse_amount AS "disburseAmount", (d.interest_rate / 100) AS "interestRate",
        d.term_months AS "termMonths", d.repayment_type AS "repaymentType", d.core_loan_id AS "coreLoanId", d.status AS "status", ${LOAN_TAIL_COLUMNS}
      FROM origination.disbursement_request d JOIN loans l ON l.id = d.application_id
      WHERE ${and(conds)}`;
    return { base };
  },
});
