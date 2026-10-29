import type { ReportColumn, ReportRow } from '@los/contracts';
import type { PrismaService } from '../../prisma.service';
import { Prisma } from '.prisma/client-origination';
import { yieldToEventLoop } from './concurrency';
import { REPORT_STATEMENT_TIMEOUT_MS, statementTimeout } from './report-db';
import { col } from './report-filters';
import { ident, sql, type Sql } from './report-sql';
import type { ReportDefinition, ReportInput, ReportRunResult } from './report-types';
import { convertValue, maskedRegister, round, toNumber, type Raw } from './report-values';

export { col };

/** Мөр хөрвүүлэлт (регистр тайлах…) синхрон тул том хариуг хэсэгчлэн хийж, event loop-д амс өгнө. */
const CONVERT_YIELD_EVERY = 1000;

/** SQL-ээр бүтсэн тайлангийн нэг гүйцэтгэлийн тодорхойлолт. */
export interface SqlReportSpec {
  columns: ReportColumn[];
  /** SELECT … — гаралтын багана бүр `columns[].key`-тэй ижил нэртэй, мөн `_id` (тогтвортой эрэмбийн түлхүүр), `currency`. `_`-ээр эхэлсэн нь туслах. */
  base: Sql;
  /** JS-д тооцох баганууд (регистр нуулт, ангилал…). */
  derive?: Record<string, (raw: Raw) => ReportRow[string]>;
}

export interface SqlReportDef {
  key: ReportDefinition['key'];
  title: string;
  description: string;
  columns: ReportColumn[];
  filters: ReportDefinition['filters'];
  defaultSort: ReportDefinition['defaultSort'];
  totalKeys: string[];
  /** эрэмбэлэх түлхүүр → SQL баганы нэр (анхдагч нь түлхүүр өөрөө). Зөвхөн `sortable` багана. */
  sortAlias?: Record<string, string>;
  build(input: ReportInput): { base: Sql; derive?: SqlReportSpec['derive'] };
}

/** Эрэмбэлэх боломжтой баганы whitelist: түлхүүр → SQL баганы нэр. */
export function sortAliases(columns: ReportColumn[], overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns) if (c.sortable) out[c.key] = overrides[c.key] ?? c.key;
  return out;
}

/**
 * Нэг хуудас + нийт тоо + нийлбэрийг ИЖИЛ нэг SQL-ээр авна: `base` нэг л удаа (MATERIALIZED) бодогдож, нэгтгэл ба хуудас хоёулаа түүнээс гарна (NFR-1).
 * ORDER BY-д зөвхөн whitelist-ийн баганыг `ident()`-ээр ашиглана; чиглэл нь 'ASC'|'DESC' тогтмол.
 * Хуудас хоосон (хүрээнээс гадуур) бол нэгтгэлийн нэг мөр л үлдэх тул `_id IS NULL`-ээр таньна.
 * `input.maxRows` (экспорт): нийт тоо түүнээс их бол `pg` хоосон болно — мөр DB-ээс гарахгүй, JS-д задлагдахгүй (татгалзах нь хямд).
 * JIT-ийг энэ гүйлгээнд унтраана: том нэгтгэлийн төлөвлөгөөнд JIT-ийн эмхэтгэл 1–3 секунд нэмдэг (хэмжилт: report.perf тест).
 * `statement_timeout`-той: хэт удаан query pool-ын холболтыг удаан барихгүй.
 */
export async function executeSqlReport(prisma: PrismaService, spec: SqlReportSpec, aliases: Record<string, string>, totalKeys: string[], input: ReportInput): Promise<ReportRunResult> {
  const alias = aliases[input.sortBy];
  if (!alias) throw new Error(`Эрэмбэлэх боломжгүй багана: ${input.sortBy}`); // ReportService өмнө нь 400-аар няцаасан байх ёстой
  const dir = input.sortDir === 'desc' ? Prisma.raw('DESC') : Prisma.raw('ASC');
  const offset = (input.page - 1) * input.pageSize;

  const capped = input.maxRows === undefined ? Prisma.empty : sql`WHERE (SELECT "_total" FROM agg) <= ${input.maxRows}`;
  const sums = totalKeys.map((k) => sql`COALESCE(SUM(q.${ident(aliases[k] ?? k)}), 0) AS ${ident(`_sum_${k}`)}`);
  const statement = sql`
    WITH q AS MATERIALIZED (${spec.base}),
    agg AS (SELECT COUNT(*)::int AS "_total", COUNT(DISTINCT q."currency")::int AS "_currencies"${sums.length ? sql`, ${Prisma.join(sums)}` : Prisma.empty} FROM q),
    pg AS (SELECT * FROM q ${capped} ORDER BY q.${ident(alias)} ${dir} NULLS LAST, q."_id" ASC LIMIT ${input.pageSize} OFFSET ${offset})
    SELECT agg.*, pg.* FROM agg LEFT JOIN pg ON true
    ORDER BY pg.${ident(alias)} ${dir} NULLS LAST, pg."_id" ASC`;
  const [, , raws] = await prisma.$transaction([
    prisma.$executeRaw(sql`SET LOCAL jit = off`),
    prisma.$executeRaw(statementTimeout(input.statementTimeoutMs ?? REPORT_STATEMENT_TIMEOUT_MS)),
    prisma.$queryRaw<Raw[]>(statement),
  ]);

  const agg = raws[0] ?? {};
  const total = toNumber(agg._total) ?? 0;
  const mixedCurrency = (toNumber(agg._currencies) ?? 0) > 1;
  const rows: ReportRow[] = [];
  for (const raw of raws) {
    if (raw._id == null) continue;
    rows.push(toRow(spec, raw));
    if (rows.length % CONVERT_YIELD_EVERY === 0) await yieldToEventLoop();
  }
  const result: ReportRunResult = { rows, total };
  if (mixedCurrency) result.mixedCurrency = true;
  else if (totalKeys.length) result.totals = Object.fromEntries(totalKeys.map((k) => [k, round(toNumber(agg[`_sum_${k}`]) ?? 0, 2)]));
  return result;
}

function toRow(spec: SqlReportSpec, raw: Raw): ReportRow {
  const out: ReportRow = {};
  for (const c of spec.columns) {
    const derive = spec.derive?.[c.key];
    out[c.key] = derive ? derive(raw) : c.key === 'registerNo' ? maskedRegister(raw._registerEnc) : convertValue(c.type, raw[c.key]);
  }
  return out;
}

/** SQL тайлангаас `ReportDefinition` (registry-д нэг мөр нэмэхэд хангалттай) үүсгэнэ. */
export function sqlReport(def: SqlReportDef): ReportDefinition {
  const aliases = sortAliases(def.columns, def.sortAlias);
  return {
    key: def.key, title: def.title, description: def.description, columns: def.columns, filters: def.filters, defaultSort: def.defaultSort, totalKeys: def.totalKeys,
    dataSource: () => 'origination',
    run(deps, input) {
      const built = def.build(input);
      return executeSqlReport(deps.prisma, { columns: def.columns, base: built.base, derive: built.derive }, aliases, def.totalKeys, input);
    },
  };
}
