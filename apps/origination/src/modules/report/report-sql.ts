// Тайлангийн хуваалцдаг SQL хэсгүүд. Бүх утга нь параметр ($n) — string-ээр холихгүй (SQL injection-гүй).
// Зөвхөн `Prisma.raw` нь манай тогтмол (whitelist) нэр/илэрхийлэлд. Схем: `origination.`.
import { addDays } from '@los/calc';
import { blindIndex } from '@los/database';
import type { AgingBucket } from '@los/contracts';
import { Prisma } from '.prisma/client-origination';
import { ubDayStartUtc } from './report-dates';
import type { ReportInput } from './report-types';

export type Sql = Prisma.Sql;
export const sql = Prisma.sql;

/** Одоо эргэн төлөгдөж буй зээл. */
export const REPAYING_STATUSES = ['ACTIVE', 'MIGRATED'] as const;
/** Олгогдсон гэж тооцох олголтын хүсэлтийн төлөв. */
export const DISBURSED_STATUSES = ['APPROVED', 'SENT_TO_CORE'] as const;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Баганы нэр (whitelist-ээс) → "name". Дүрэмд нийцэхгүй бол алдаа — гаднаас ирсэн утгыг энд хэзээ ч өгөхгүй. */
export function ident(name: string): Sql {
  if (!IDENT.test(name)) throw new Error(`Буруу SQL тодотгол: ${name}`);
  return Prisma.raw(`"${name}"`);
}

/** LIKE/ILIKE-н тусгай тэмдэгт (\ % _)-ийг escape хийнэ. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Нөхцөлүүдийг AND-ээр холбоно (хоосон бол TRUE). */
export const and = (conds: Sql[]): Sql => (conds.length ? Prisma.join(conds, ' AND ') : sql`TRUE`);

// ── DPD ангилал: packages/calc `agingBucket`-тэй зөрөхгүй (report-sql.test.ts шалгана) ──
export const AGING_DPD_RANGES: Record<AgingBucket, { min: number; max: number | null }> = {
  CURRENT: { min: 0, max: 0 },
  DPD_1_30: { min: 1, max: 30 },
  DPD_31_60: { min: 31, max: 60 },
  DPD_61_90: { min: 61, max: 90 },
  DPD_90_PLUS: { min: 91, max: null },
};

// ── Зээлийн сонголт ──
export interface LoanSelection {
  orgId: string;
  branchId: string | null;
  officerId: string | null;
  productId: string | null;
  currency: string | null;
  /** null → төлөвөөр хязгаарлахгүй */
  statuses: readonly string[] | null;
  search: string | null;
}

export function selectionOf(input: ReportInput, statuses: readonly string[] | null, o: { currency?: boolean; search?: boolean } = {}): LoanSelection {
  const f = input.filters;
  return {
    orgId: input.scope.orgId, branchId: f.branchId, officerId: f.officerId, productId: f.productId,
    currency: o.currency === false ? null : f.currency, statuses, search: o.search === false ? null : f.search,
  };
}

/** `la` (loan_application) ба `c` (харилцагч) нэрээр ажиллах хайлтын нөхцөл: гэрээ/хүсэлтийн дугаар, нэр (ILIKE), регистр (blind index, яг таарах). */
export function searchCondition(search: string): Sql {
  const like = `%${escapeLike(search)}%`;
  return sql`(la.contract_no ILIKE ${like} OR la.app_no ILIKE ${like}
    OR concat_ws(' ', c.last_name, c.first_name) ILIKE ${like} OR concat_ws(' ', c.first_name, c.last_name) ILIKE ${like}
    OR c.register_no_hash = ${blindIndex(search)})`;
}

/** `la` дээрх хүрээ/шүүлтийн нөхцөл (NFR-3: branch/officer нь хүрээгээр аль хэдийн нийлсэн). */
export function loanConditions(sel: LoanSelection): Sql[] {
  const conds: Sql[] = [sql`la.org_id = ${sel.orgId}`];
  if (sel.branchId) conds.push(sql`la.branch_id = ${sel.branchId}`);
  if (sel.officerId) conds.push(sql`la.officer_id = ${sel.officerId}`);
  if (sel.productId) conds.push(sql`la.product_id = ${sel.productId}`);
  if (sel.currency) conds.push(sql`la.currency = ${sel.currency}`);
  if (sel.statuses?.length) conds.push(sql`la.status IN (${Prisma.join([...sel.statuses])})`);
  if (sel.search) conds.push(searchCondition(sel.search));
  return conds;
}

/** Үндсэн зээлдэгч (PRIMARY, is_primary эхэндээ) — `c` нэрээр. */
const PRIMARY_CUSTOMER = sql`
  LEFT JOIN LATERAL (
    SELECT b.customer_id FROM origination.loan_application_borrower b
    WHERE b.application_id = la.id AND b.role = 'PRIMARY' ORDER BY b.is_primary DESC, b.created_at ASC LIMIT 1
  ) pb ON true
  LEFT JOIN origination.customer c ON c.id = pb.customer_id`;

/**
 * `loans` CTE: хүрээ/шүүлтэд таарсан хүсэлтүүд + үндсэн зээлдэгч + бүтээгдэхүүний нэр. Бусад CTE/SELECT үүнийг `l` нэрээр ашиглана.
 * Гаралтын баганууд: id, app_no, contract_no, currency, status, branch_id, officer_id, product_id, amount, term_months, interest_rate,
 * disbursed_at, created_at, updated_at, product_name, customer_id, first_name, last_name, phone, register_no_encrypted.
 */
export function loansCte(sel: LoanSelection): Sql {
  return sql`loans AS (
    SELECT la.id, la.app_no, la.contract_no, la.currency, la.status, la.branch_id, la.officer_id, la.product_id, la.amount,
      la.term_months, la.interest_rate, la.disbursed_at, la.created_at, la.updated_at,
      pr.name AS product_name, c.id AS customer_id, c.first_name, c.last_name, c.phone, c.register_no_encrypted
    FROM origination.loan_application la
    LEFT JOIN origination.product pr ON pr.id = la.product_id
    ${PRIMARY_CUSTOMER}
    WHERE ${and(loanConditions(sel))}
  )`;
}

/**
 * `cur` (одоогийн ЭТХ: isStale=false-ийн хамгийн сүүлийн generatedAt) ба `inst` (ЭТХ-ийн мөр бүр + төлсөн хүү/үндсэн) CTE.
 * Төлсөн дүн = `payment_allocation`-ийн Σ, зөвхөн asOf өдрийн төгсгөл хүртэл хийгдсэн төлбөрөөр (түүхэн asOf зөв байхын тулд).
 * Олголтын мөр (үндсэн+хүү = 0) орохгүй. Allocation-ыг зөвхөн хүрээн доторх зээлийн төлбөрөөр нэгтгэж (payment.application_id ∈ loans), мөртэй нь hash join-оор холбоно (мөр бүрээр эрэмбэлж бүлэглэхгүй).
 * `loans` CTE урьдчилан тодорхойлогдсон байх ёстой.
 */
export function installmentsCte(o: { asOf: string; dueFrom?: string | null; dueTo?: string | null }): Sql {
  const paidBefore = ubDayStartUtc(addDays(o.asOf, 1));
  return sql`cur AS (
    SELECT DISTINCT ON (s.application_id) s.id, s.application_id
    FROM origination.repayment_schedule s JOIN loans l ON l.id = s.application_id
    WHERE s.is_stale = false
    ORDER BY s.application_id, s.generated_at DESC, s.created_at DESC
  ),
  inst AS (
    SELECT r.id, cur.application_id, r.seq, r.due_date, r.principal, r.interest,
      COALESCE(pa.paid_interest, 0) AS paid_interest, COALESCE(pa.paid_principal, 0) AS paid_principal
    FROM cur
    JOIN origination.repayment_schedule_row r ON r.schedule_id = cur.id
    LEFT JOIN (
      SELECT a.schedule_row_id, SUM(a.interest_paid) AS paid_interest, SUM(a.principal_paid) AS paid_principal
      FROM origination.payment_allocation a
      JOIN origination.payment pm ON pm.id = a.payment_id AND pm.paid_at < ${paidBefore}::timestamp
        AND pm.application_id IN (SELECT id FROM loans)
      GROUP BY a.schedule_row_id
    ) pa ON pa.schedule_row_id = r.id
    WHERE r.principal + r.interest > 0
      ${o.dueFrom ? sql`AND r.due_date >= ${o.dueFrom}::date` : Prisma.empty}
      ${o.dueTo ? sql`AND r.due_date <= ${o.dueTo}::date` : Prisma.empty}
  )`;
}

// `inst i` дээрх илэрхийллүүд (тогтмол текст). packages/calc outstandingOf-той ижил: хүү+үндсэн, тус бүр 0-ээс доошгүй.
export const OUT_PRINCIPAL = Prisma.raw('GREATEST(i.principal - i.paid_principal, 0)');
export const OUT_INTEREST = Prisma.raw('GREATEST(i.interest - i.paid_interest, 0)');
export const OUT_TOTAL = Prisma.raw('(GREATEST(i.principal - i.paid_principal, 0) + GREATEST(i.interest - i.paid_interest, 0))');
export const HAS_OUTSTANDING = Prisma.raw('(i.principal > i.paid_principal OR i.interest > i.paid_interest)');

// `loans l` дээрх нийтлэг гаралтын баганууд. 'Систем' = ЗЭЗ байхгүй (BR-12).
const CUSTOMER_NAME_SQL = "NULLIF(btrim(concat_ws(' ', l.last_name, l.first_name)), '')";
export const CUSTOMER_NAME = Prisma.raw(CUSTOMER_NAME_SQL);
export const LOAN_ID_COLUMNS = Prisma.raw(`l.contract_no AS "contractNo", l.app_no AS "appNo", ${CUSTOMER_NAME_SQL} AS "customerName", l.register_no_encrypted AS "_registerEnc"`);
export const LOAN_TAIL_COLUMNS = Prisma.raw(`l.currency AS "currency", l.branch_id AS "branchId", COALESCE(l.officer_id, 'Систем') AS "officerId"`);

/** UB өдөр рүү хөрвүүлсэн timestamp (UTC+8) → 'YYYY-MM-DD'. */
export const ubDateOf = (expr: string): Sql => Prisma.raw(`to_char((${expr}) + interval '8 hours', 'YYYY-MM-DD')`);
export const dayText = (expr: string): Sql => Prisma.raw(`to_char(${expr}, 'YYYY-MM-DD')`);

/** Олголтын хүсэлт: зээл бүрт хамгийн сүүлийн APPROVED/SENT_TO_CORE (олгосон дүн). `loans` CTE хэрэгтэй. */
export const disbursementCte = sql`disb AS (
  SELECT DISTINCT ON (d.application_id) d.application_id, d.disburse_amount
  FROM origination.disbursement_request d JOIN loans l ON l.id = d.application_id
  WHERE d.status IN ('APPROVED', 'SENT_TO_CORE')
  ORDER BY d.application_id, d.disburse_date DESC NULLS LAST, d.created_at DESC
)`;
