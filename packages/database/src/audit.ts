// NFR-4, FR-13.5: төлөв, батлах, засвар бүр — хэн, хэзээ, өмнөх/шинэ. Сервисийн `audit_log` хүснэгтэд бизнес транзакцтай хамт бичнэ.
/** Prisma interactive transaction (`prisma.$transaction(async (tx) => ...)`) — сервис бүрийн `audit_log` загвартай (OutboxTx-тэй адил `any`: Prisma-ийн Json төрөлтэй тааруулна). */
export interface AuditTx {
  auditLog: { create(args: { data: any }): Promise<unknown> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export interface AuditData {
  orgId: string; entity: string; entityId: string; action: string; actorId: string | null;
  beforeJson: unknown; afterJson: unknown; applicationId: string | null; correlationId: string | null;
}
export type AuditInput = Omit<AuditData, 'beforeJson' | 'afterJson' | 'applicationId' | 'correlationId'> & Partial<Pick<AuditData, 'beforeJson' | 'afterJson' | 'applicationId' | 'correlationId'>>;

/** Аудитад хэзээ ч орох ёсгүй талбарууд (CLAUDE.md §6.5). */
const SECRET_KEYS = /(password|secret|token|register_?no(?!_hash)|account_?no|photo)/i;
export function sanitizeForAudit(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== 'object' || depth > 5) return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => sanitizeForAudit(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : sanitizeForAudit(x, depth + 1)]));
}

export async function recordAudit(tx: AuditTx, e: AuditInput): Promise<void> {
  await tx.auditLog.create({ data: { ...e, beforeJson: sanitizeForAudit(e.beforeJson ?? null), afterJson: sanitizeForAudit(e.afterJson ?? null), applicationId: e.applicationId ?? null, correlationId: e.correlationId ?? null } });
}

/** Prisma client (interactive transaction-тэй). Тестийн helper тул төрлийг сул байлгав. */
export interface AuditPurgeDb {
  $transaction<R>(fn: (tx: any) => Promise<R>, opts?: { timeout?: number; maxWait?: number }): Promise<R>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** Олон хүснэгтийн TRUNCATE ачаалалтай дискэн дээр Prisma-гийн 5 с-ийн interactive tx хязгаараас удаан байж болно. */
const PURGE_TX = { timeout: 120_000, maxWait: 30_000 };

/**
 * M10 · ЗӨВХӨН ТЕСТ: `audit_log` append-only trigger-ийг энэ транзакцид л алгасаж цэвэрлэгээ хийнэ.
 * `SET LOCAL session_replication_role = replica` нь superuser эрх шаарддаг (production app role superuser биш тул энэ нь
 * production-ий хамгаалалтыг сулруулахгүй) ба транзакц дуусахад буцна. NODE_ENV !== 'test' бол татгалзана.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function purgeAuditLogForTests<R>(db: AuditPurgeDb, fn: (tx: any) => Promise<R>): Promise<R> {
  if (process.env.NODE_ENV !== 'test') throw new Error('purgeAuditLogForTests is test-only (NODE_ENV must be "test"): audit_log is append-only');
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    return fn(tx);
  }, PURGE_TX);
}

/** Өөрчлөгдсөн талбарыг л үлдээнэ (том JSON-г audit-д давхар хадгалахгүйн тулд). */
export function auditDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) { b[k] = before?.[k]; a[k] = after?.[k]; }
  }
  return { before: b, after: a };
}
