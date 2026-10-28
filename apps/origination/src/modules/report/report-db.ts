import { Prisma } from '.prisma/client-origination';
import type { PrismaService } from '../../prisma.service';

// Хэт удаан тайлангийн query нэг холболтыг удаан барьж, нийтлэг Prisma pool-ыг (бусад модуль хуваалцдаг) дүүргэхээс сэргийлнэ.
/** Жагсаалт, dashboard-ын query. NFR-1 (≤ 2с)-ээс хол, гэхдээ pool-ыг барихгүй. */
export const REPORT_STATEMENT_TIMEOUT_MS = 30_000;
/** Excel экспорт: бүх мөрийг нэг дор бодох тул урт. */
export const EXPORT_STATEMENT_TIMEOUT_MS = 120_000;

/** `SET LOCAL statement_timeout` — зөвхөн тухайн гүйлгээнд. (SET нь параметр ($n) авдаггүй тул бүхэл тоог шалгаад шууд бичнэ.) */
export function statementTimeout(ms: number): Prisma.Sql {
  if (!Number.isInteger(ms) || ms < 1) throw new Error(`Буруу statement_timeout: ${ms}`);
  return Prisma.sql`SET LOCAL statement_timeout = ${Prisma.raw(String(ms))}`;
}

/** Postgres-ийн 57014 (query_canceled: statement timeout) алдаа мөн эсэх. Prisma үүнийг P2010 болгож боодог. */
export function isStatementTimeout(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; meta?: { code?: unknown; message?: unknown }; message?: unknown };
  return err.meta?.code === '57014' || /\b57014\b|statement timeout/i.test(`${err.meta?.message ?? ''} ${err.message ?? ''}`);
}

/** Нэг raw query-г statement_timeout-той гүйлгээнд ажиллуулна. */
export async function queryWithTimeout<T = unknown>(prisma: PrismaService, query: Prisma.Sql, timeoutMs: number = REPORT_STATEMENT_TIMEOUT_MS): Promise<T> {
  const [, rows] = await prisma.$transaction([prisma.$executeRaw(statementTimeout(timeoutMs)), prisma.$queryRaw<T>(query)]);
  return rows as T;
}
