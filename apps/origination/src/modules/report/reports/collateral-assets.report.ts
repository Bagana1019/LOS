import { addDays } from '@los/calc';
import { F, col } from '../report-filters';
import { APPLICATION_STATUS, ASSET_TYPE, COLLATERAL_KIND, COLLATERAL_STATUS, ENCUMBRANCE_STATUS } from '../report-labels';
import { LOAN_ID_COLUMNS, LOAN_TAIL_COLUMNS, and, dayText, loansCte, selectionOf, sql, ubDateOf, type Sql } from '../report-sql';
import { sqlReport } from '../sql-report';
import { describeAsset } from '../asset-description';

/** Барьцааны мониторингийн анхааруулга: даатгал/дахин үнэлгээ дуусахаас өмнөх хоног (FR-6.9). */
export const COLLATERAL_WARNING_DAYS = 30;

// FR-13.3 #7 Барьцаа хөрөнгө: Collateral бүр. status = мониторинг (RELEASED > EXPIRED > EXPIRING (30 хоногт дуусах) > OK).
// LTV = хүсэлтийн дүн ÷ Σ чөлөөлөөгүй барьцааны үнэлгээ (хүсэлт тутамд; хөрөнгө бүрт давтагдана).
export const collateralAssets = sqlReport({
  key: 'collateral-assets',
  title: 'Барьцаа хөрөнгө',
  description: 'Барьцаа хөрөнгийн жагсаалт: өмчлөгч, зах зээлийн үнэ, барьцааны үнэлгээ, LTV, ЭБ-ийн бүртгэл, даатгал ба дахин үнэлгээний хугацаа (30 хоногт дуусахыг анхааруулна).',
  columns: [
    col('contractNo', 'Гэрээний дугаар', 'string', { width: 18 }),
    col('appNo', 'Хүсэлтийн дугаар', 'string', { width: 16 }),
    col('applicationStatus', 'Хүсэлтийн төлөв', 'status', { width: 16, options: APPLICATION_STATUS }),
    col('customerName', 'Зээлдэгч', 'string', { width: 24 }),
    col('registerNo', 'Регистр', 'string', { width: 14, sortable: false }),
    col('ownerName', 'Өмчлөгч', 'string', { width: 24 }),
    col('kind', 'Барьцааны төрөл', 'status', { width: 14, options: COLLATERAL_KIND }),
    col('assetType', 'Хөрөнгийн төрөл', 'status', { width: 16, options: ASSET_TYPE }),
    col('description', 'Тодорхойлолт', 'string', { width: 30, sortable: false }),
    col('marketValue', 'Зах зээлийн үнэ', 'money', { width: 16 }),
    col('haircutRate', 'Haircut', 'percent', { width: 10 }),
    col('collateralValue', 'Барьцааны үнэлгээ', 'money', { width: 16 }),
    col('ltv', 'LTV', 'percent', { width: 10 }),
    col('encumbranceStatus', 'Ачаалал', 'status', { width: 14, options: ENCUMBRANCE_STATUS }),
    col('registryNo', 'ЭБ-ийн дугаар', 'string', { width: 16 }),
    col('registryDate', 'ЭБ-ийн огноо', 'date', { width: 14 }),
    col('insuranceExpiresAt', 'Даатгал дуусах', 'date', { width: 14 }),
    col('nextRevaluationAt', 'Дахин үнэлгээ', 'date', { width: 14 }),
    col('status', 'Төлөв', 'status', { width: 18, options: COLLATERAL_STATUS }),
    col('releasedDate', 'Чөлөөлсөн огноо', 'date', { width: 14 }),
    col('currency', 'Валют', 'string', { width: 8 }),
    col('branchId', 'Салбар', 'string', { width: 12 }),
    col('officerId', 'ЗЭЗ', 'string', { width: 14 }),
  ],
  filters: [F.asOf, F.select('status', 'Барьцааны төлөв', COLLATERAL_STATUS), F.select('assetType', 'Хөрөнгийн төрөл', ASSET_TYPE), F.branch, F.officer, F.product, F.currency, F.search],
  defaultSort: { sortBy: 'insuranceExpiresAt', sortDir: 'asc' },
  totalKeys: ['marketValue', 'collateralValue'],
  build(input) {
    const f = input.filters;
    const inner: Sql[] = [];
    if (f.assetType) inner.push(sql`c.asset_type = ${f.assetType}`);
    const outer: Sql[] = [];
    if (f.status) outer.push(sql`t."status" = ${f.status}`);
    const soon = addDays(f.asOf, COLLATERAL_WARNING_DAYS);
    const base = sql`
      WITH ${loansCte(selectionOf(input, null))},
      csum AS (
        SELECT c.application_id, SUM(c.collateral_value) AS total
        FROM origination.collateral c JOIN loans l ON l.id = c.application_id WHERE c.released_at IS NULL GROUP BY c.application_id
      )
      SELECT * FROM (
        SELECT c.id AS "_id", ${LOAN_ID_COLUMNS}, l.status AS "applicationStatus",
          NULLIF(btrim(concat_ws(' ', oc.last_name, oc.first_name)), '') AS "ownerName",
          c.kind AS "kind", c.asset_type AS "assetType", c.description_json AS "_descriptionJson",
          c.market_value AS "marketValue", c.haircut_rate AS "haircutRate", c.collateral_value AS "collateralValue",
          CASE WHEN csum.total > 0 THEN ROUND(l.amount / csum.total, 6) END AS "ltv",
          c.encumbrance_status AS "encumbranceStatus", c.registry_no AS "registryNo", ${dayText('c.registry_date')} AS "registryDate",
          ${dayText('c.insurance_expires_at')} AS "insuranceExpiresAt", ${dayText('c.next_revaluation_at')} AS "nextRevaluationAt",
          CASE
            WHEN c.released_at IS NOT NULL THEN 'RELEASED'
            WHEN c.insurance_expires_at < ${f.asOf}::date OR c.next_revaluation_at < ${f.asOf}::date THEN 'EXPIRED'
            WHEN c.insurance_expires_at <= ${soon}::date OR c.next_revaluation_at <= ${soon}::date THEN 'EXPIRING'
            ELSE 'OK'
          END AS "status",
          ${ubDateOf('c.released_at')} AS "releasedDate", ${LOAN_TAIL_COLUMNS}
        FROM origination.collateral c
        JOIN loans l ON l.id = c.application_id
        LEFT JOIN origination.customer oc ON oc.id = c.owner_customer_id
        LEFT JOIN csum ON csum.application_id = c.application_id
        WHERE ${and(inner)}
      ) t
      WHERE ${and(outer)}`;
    return { base, derive: { description: (raw) => describeAsset(String(raw.assetType ?? ''), raw._descriptionJson) } };
  },
});
