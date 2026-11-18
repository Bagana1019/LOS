import { createHash } from 'node:crypto';

// M9 — олон pod-той үед тогтмол давтамжтай ажлыг (sweeper tick) зөвхөн НЭГ pod гүйцэтгэнэ.
// Механизм: `pg_try_advisory_xact_lock` — интерактив транзакцын туршид түгжээ барина; commit/rollback эсвэл холболт тасрах (pod унах)
// мөчид Postgres өөрөө чөлөөлнө. Redis TTL түгжээнээс ялгаатай нь удаан tick-ийн дундуур хугацаа дуусч хоёр pod давхцахгүй,
// pgbouncer transaction mode-д ч ажиллана, sweeper-ууд аль хэдийн Postgres-оос хамааралтай тул шинэ хамаарал нэмэхгүй.
// Ажил (work) нь түгжээний транзакцын ГАДНА (бусад pool холболтоор) явна: түгжээ ганц холболт эзэлнэ, ажил idempotent байх ёстой.

export interface AdvisoryLockTx { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> }
/** Prisma client (сервис бүрийн PrismaService) бүтцээрээ тохирно. */
export interface AdvisoryLockClient {
  $transaction<R>(fn: (tx: AdvisoryLockTx) => Promise<R>, options?: { maxWait?: number; timeout?: number }): Promise<R>;
}
export type ExclusiveResult<T> = { ran: true; value: T } | { ran: false };
export interface ExclusiveOptions {
  /** Түгжээг барих дээд хугацаа (Prisma interactive tx timeout). Хэтэрвэл транзакц rollback → түгжээ чөлөөлөгдөнө; ажил үргэлжилнэ (idempotent). */
  holdMs?: number;
  /** Түгжээний холболт pool-оос авах хүлээлт */
  maxWaitMs?: number;
}

const DEFAULT_HOLD_MS = 15 * 60_000;
const DEFAULT_MAX_WAIT_MS = 10_000;

/** Нэрээс тогтвортой signed int8 түлхүүр (sha256-ийн эхний 8 байт) — бүх pod/хувилбарт ижил. */
export function advisoryLockKey(name: string): bigint {
  if (!name) throw new Error('advisory lock name is required');
  return createHash('sha256').update(name, 'utf8').digest().readBigInt64BE(0);
}

/**
 * `name` түгжээг авч чадвал `work`-ийг гүйцэтгэнэ (`{ ran: true, value }`); өөр pod барьж байвал хүлээхгүй, `{ ran: false }`.
 * `work`-ийн алдаа дамжина (түгжээ rollback-аар чөлөөлөгдөнө).
 */
export async function runExclusive<T>(db: AdvisoryLockClient, name: string, work: () => Promise<T>, opts: ExclusiveOptions = {}): Promise<ExclusiveResult<T>> {
  const key = advisoryLockKey(name).toString();
  let outcome: ExclusiveResult<T> = { ran: false };
  try {
    await db.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ locked: boolean }[]>('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', key);
      if (!rows[0]?.locked) return;
      outcome = { ran: true, value: await work() };
    }, { maxWait: opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS, timeout: opts.holdMs ?? DEFAULT_HOLD_MS });
  } catch (e) {
    // Ажил дууссаны дараа commit амжилтгүй (holdMs хэтэрсэн/холболт тасарсан) — үр дүн хүчинтэй, түгжээ аль хэдийн чөлөөлөгдсөн
    if (!outcome.ran) throw e;
  }
  return outcome;
}
