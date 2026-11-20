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
  await insertAuditRow(tx, { ...e, beforeJson: sanitizeForAudit(e.beforeJson ?? null), afterJson: sanitizeForAudit(e.afterJson ?? null), applicationId: e.applicationId ?? null, correlationId: e.correlationId ?? null });
}

/**
 * `audit_log`-ийн мөр (сервисийн бүх баганын нэгдэл: gateway `ip`/`userAgent`, `orgId` nullable; `id`/`at` өгөөгүй бол DB/Prisma үүсгэнэ).
 * `txId` энд БАЙХГҮЙ: түүнийг DB trigger хүчээр тавина (audit seal, docs/DECISIONS.md 2026-11-19 · audit seal).
 */
export interface AuditRowData {
  id?: string; at?: Date; orgId?: string | null; entity: string; entityId: string; action: string; actorId?: string | null;
  beforeJson?: unknown; afterJson?: unknown; applicationId?: string | null; correlationId?: string | null; ip?: string | null; userAgent?: string | null;
}
/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma-гийн Json төрөлтэй тааруулна (AuditTx-тэй адил) */
type AuditCreateDb<R> = { auditLog: { create(args: { data: any }): R } };
type AuditCreateManyDb<R> = { auditLog: { createMany(args: { data: any[]; skipDuplicates?: boolean }): R } };
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * `audit_log` руу бичих ЦОРЫН ГАНЦ зам (guard: audit-writers.guard.test.ts). Өгөгдлийг хувиргахгүй дамжуулна (ариутгал нь дуудагчийн
 * `recordAudit` / gateway `AuditService.toRow`-д). Клиентийн өөрийн promise-ийг буцаана — PrismaPromise хэвээр тул
 * `prisma.$transaction([...])` массив транзакцид ч ашиглана (транзакцын хамрах хүрээ өөрчлөгдөхгүй).
 */
export function insertAuditRow<R>(db: AuditCreateDb<R>, data: AuditRowData): R {
  return db.auditLog.create({ data });
}
/** Олон мөр нэг INSERT-ээр (`createMany`); `skipDuplicates` = id давхцлыг алгасна (gateway fallback drain idempotent). */
export function insertAuditRows<R>(db: AuditCreateManyDb<R>, data: AuditRowData[], opts: { skipDuplicates?: boolean } = {}): R {
  return db.auditLog.createMany(opts.skipDuplicates === undefined ? { data } : { data, skipDuplicates: opts.skipDuplicates });
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

/**
 * ЗӨВХӨН ТЕСТ: нэг sealer pass `<schema>.audit_log`-ийн одоо байгаа БҮХ мөрийг хамрах хүртэл хүлээнэ.
 * Sealer зөвхөн кластер даяарх xid horizon (`pg_snapshot_xmin`)-оос доош мөрийг seal хийдэг. CI-д нэг Postgres-ийг хуваалцдаг бусад багцын
 * нээлттэй бичих транзакц horizon-г түр хойш татаж, "commit хийсэн мөр шууд seal-д орно" гэсэн тест санамсаргүй унана (алдагдахгүй, хоцорно).
 * Тестүүд тэр таамаглалын оронд энд хүлээнэ. Тестийн өөрийн нээлттэй транзакц барьсан үед хэзээ ч дуусахгүй тул тэр тестэд хэрэглэхгүй.
 * NODE_ENV !== 'test' бол татгалзана.
 */
export async function waitUntilAuditRowsSealable(
  db: { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> },
  schema: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  if (process.env.NODE_ENV !== 'test') throw new Error('waitUntilAuditRowsSealable is test-only (NODE_ENV must be "test")');
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name: ${schema}`);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT COALESCE((SELECT l.tx_id FROM "${schema}"."audit_log" l ORDER BY l.tx_id DESC LIMIT 1) < pg_snapshot_xmin(pg_current_snapshot()), true) AS ok`,
    );
    if (rows[0]?.ok) return;
    if (Date.now() > deadline) throw new Error(`audit_log rows of "${schema}" are still above the xid horizon after ${timeoutMs} ms: a write transaction is open somewhere in the cluster`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 50));
  }
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
