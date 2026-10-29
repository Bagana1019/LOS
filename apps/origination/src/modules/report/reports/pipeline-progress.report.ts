import { StepKey } from '@los/contracts';
import { Prisma } from '.prisma/client-origination';
import { F, col } from '../report-filters';
import { APPLICATION_STATUS, STEP_KEY, STEP_STATUS } from '../report-labels';
import { LOAN_ID_COLUMNS, LOAN_TAIL_COLUMNS, and, loansCte, selectionOf, sql, ubDateOf, type Sql } from '../report-sql';
import { ubDayStartUtc } from '../report-dates';
import { addDays } from '@los/calc';
import { toNumber } from '../report-values';
import { sqlReport } from '../sql-report';

/** Явцын хяналтын анхдагч хамрах төлөв: DRAFT…ACTIVE (CLOSED, MIGRATED нь явцаас гарсан тул `status` шүүлтээр л). */
export const PIPELINE_STATUSES = ['DRAFT', 'SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'RETURNED', 'DISBURSING', 'ACTIVE'] as const;

// FR-13.3 #8 Явцын хяналт: хүсэлт бүр төлвөөр; одоогийн алхам = StepKey дарааллаар хамгийн эхний PENDING/STALE;
// daysInStatus = asOf − updatedAt (UB өдөр, 0-ээс доошгүй); бүрдэлт = COMPLETED алхамын тоо / 12. dateFrom/dateTo нь хүсэлт үүссэн өдөрт.
export const pipelineProgress = sqlReport({
  key: 'pipeline-progress',
  title: 'Явцын хяналт',
  description: 'Зээлийн хүсэлт бүрийн одоогийн төлөв, хүлээгдэж буй алхам, төлөвт хэдэн хоног болсон, алхамын бүрдэлт (X/12).',
  columns: [
    col('appNo', 'Хүсэлтийн дугаар', 'string', { width: 16 }),
    col('contractNo', 'Гэрээний дугаар', 'string', { width: 18 }),
    col('customerName', 'Зээлдэгч', 'string', { width: 24 }),
    col('registerNo', 'Регистр', 'string', { width: 14, sortable: false }),
    col('productName', 'Бүтээгдэхүүн', 'string', { width: 22 }),
    col('amount', 'Хүссэн дүн', 'money', { width: 16 }),
    col('status', 'Төлөв', 'status', { width: 16, options: APPLICATION_STATUS }),
    col('currentStep', 'Одоогийн алхам', 'status', { width: 20, options: STEP_KEY }),
    col('currentStepStatus', 'Алхмын төлөв', 'status', { width: 14, options: STEP_STATUS }),
    col('daysInStatus', 'Төлөвт (хоног)', 'number', { width: 10 }),
    col('progress', 'Бүрдэлт', 'string', { width: 10 }),
    col('createdDate', 'Үүссэн огноо', 'date', { width: 14 }),
    col('currency', 'Валют', 'string', { width: 8 }),
    col('branchId', 'Салбар', 'string', { width: 12 }),
    col('officerId', 'ЗЭЗ', 'string', { width: 14 }),
  ],
  filters: [F.dateFrom('Үүссэн (эхлэх)'), F.dateTo('Үүссэн (дуусах)'), F.asOf, F.select('status', 'Хүсэлтийн төлөв', APPLICATION_STATUS), F.branch, F.officer, F.product, F.currency, F.search],
  defaultSort: { sortBy: 'daysInStatus', sortDir: 'desc' },
  totalKeys: ['amount'],
  sortAlias: { progress: 'completedSteps' },
  build(input) {
    const f = input.filters;
    const statuses = f.status ? [f.status] : PIPELINE_STATUSES;
    const outer: Sql[] = [];
    if (f.dateFrom) outer.push(sql`t."_createdAt" >= ${ubDayStartUtc(f.dateFrom)}::timestamp`);
    if (f.dateTo) outer.push(sql`t."_createdAt" < ${ubDayStartUtc(addDays(f.dateTo, 1))}::timestamp`);
    const base = sql`
      WITH ${loansCte(selectionOf(input, statuses))},
      cur_step AS (
        SELECT DISTINCT ON (s.application_id) s.application_id, s.step_key, s.status
        FROM origination.loan_application_step s JOIN loans l ON l.id = s.application_id
        WHERE s.status IN ('PENDING', 'STALE')
        ORDER BY s.application_id, array_position(ARRAY[${Prisma.join([...StepKey])}]::text[], s.step_key), s.step_key
      ),
      done AS (
        SELECT s.application_id, COUNT(*)::int AS n
        FROM origination.loan_application_step s JOIN loans l ON l.id = s.application_id
        WHERE s.status = 'COMPLETED' GROUP BY s.application_id
      )
      SELECT * FROM (
        SELECT l.id AS "_id", l.created_at AS "_createdAt", ${LOAN_ID_COLUMNS}, l.product_name AS "productName", l.amount AS "amount", l.status AS "status",
          cs.step_key AS "currentStep", cs.status AS "currentStepStatus",
          GREATEST(0, ${input.filters.asOf}::date - ((l.updated_at + interval '8 hours')::date)) AS "daysInStatus",
          COALESCE(done.n, 0) AS "completedSteps", ${ubDateOf('l.created_at')} AS "createdDate", ${LOAN_TAIL_COLUMNS}
        FROM loans l
        LEFT JOIN cur_step cs ON cs.application_id = l.id
        LEFT JOIN done ON done.application_id = l.id
      ) t
      WHERE ${and(outer)}`;
    return { base, derive: { progress: (raw) => `${toNumber(raw.completedSteps) ?? 0}/${StepKey.length}` } };
  },
});
