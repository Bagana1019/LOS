import { addDays } from '@los/calc';
import { F, col } from '../report-filters';
import { REPAYING_STATUS } from '../report-labels';
import { HAS_OUTSTANDING, LOAN_ID_COLUMNS, LOAN_TAIL_COLUMNS, OUT_TOTAL, REPAYING_STATUSES, dayText, installmentsCte, loansCte, selectionOf, sql } from '../report-sql';
import { sqlReport } from '../sql-report';

// FR-13.3 #1 Эргэн төлөлт хийгдэх: [dateFrom ?? asOf, dateTo ?? asOf+30] хугацаанд төлөх ёстой, үлдэгдэлтэй ЭТХ-ийн мөр бүр.
export const upcomingRepayments = sqlReport({
  key: 'upcoming-repayments',
  title: 'Эргэн төлөлт хийгдэх',
  description: 'Сонгосон хугацаанд (анхдагч: өнөөдрөөс 30 хоног) төлөх ёстой, үлдэгдэлтэй эргэн төлөлтийн хуваарийн мөрүүд.',
  columns: [
    col('contractNo', 'Гэрээний дугаар', 'string', { width: 18 }),
    col('appNo', 'Хүсэлтийн дугаар', 'string', { width: 16 }),
    col('customerName', 'Зээлдэгч', 'string', { width: 24 }),
    col('registerNo', 'Регистр', 'string', { width: 14, sortable: false }),
    col('phone', 'Утас', 'string', { width: 12 }),
    col('seq', '№', 'number', { width: 6 }),
    col('dueDate', 'Төлөх огноо', 'date', { width: 14 }),
    col('daysUntilDue', 'Үлдсэн хоног', 'number', { width: 12 }),
    col('interest', 'Хүү', 'money', { width: 16 }),
    col('principal', 'Үндсэн зээл', 'money', { width: 16 }),
    col('total', 'Нийт төлбөр', 'money', { width: 16 }),
    col('paidAmount', 'Төлсөн', 'money', { width: 16 }),
    col('outstanding', 'Үлдэгдэл', 'money', { width: 16 }),
    col('currency', 'Валют', 'string', { width: 8 }),
    col('branchId', 'Салбар', 'string', { width: 12 }),
    col('officerId', 'ЗЭЗ', 'string', { width: 14 }),
  ],
  filters: [F.dateFrom('Төлөх огноо (эхлэх)'), F.dateTo('Төлөх огноо (дуусах)'), F.asOf, F.select('status', 'Зээлийн төлөв', REPAYING_STATUS), F.branch, F.officer, F.product, F.currency, F.search],
  defaultSort: { sortBy: 'dueDate', sortDir: 'asc' },
  totalKeys: ['interest', 'principal', 'total', 'paidAmount', 'outstanding'],
  build(input) {
    const f = input.filters;
    const from = f.dateFrom ?? f.asOf;
    const to = f.dateTo ?? addDays(f.asOf, 30);
    const statuses = f.status ? [f.status] : REPAYING_STATUSES;
    const base = sql`
      WITH ${loansCte(selectionOf(input, statuses))}, ${installmentsCte({ asOf: f.asOf, dueFrom: from, dueTo: to })}
      SELECT i.id AS "_id", ${LOAN_ID_COLUMNS}, l.phone AS "phone",
        i.seq AS "seq", ${dayText('i.due_date')} AS "dueDate", (i.due_date - ${f.asOf}::date) AS "daysUntilDue",
        i.interest AS "interest", i.principal AS "principal", (i.interest + i.principal) AS "total",
        (LEAST(i.paid_interest, i.interest) + LEAST(i.paid_principal, i.principal)) AS "paidAmount",
        ${OUT_TOTAL} AS "outstanding", ${LOAN_TAIL_COLUMNS}
      FROM inst i JOIN loans l ON l.id = i.application_id
      WHERE ${HAS_OUTSTANDING}`;
    return { base };
  },
});
