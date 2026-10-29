import type { Tx } from '../prisma.service';

/**
 * Transaction-scoped advisory lock. Serialises writers of one logical key where no unique constraint can do it
 * (base-price versions, a NULL product_id in haircut_rule, one projection row per collateral). Released at commit/rollback.
 * `$executeRaw`: pg_advisory_xact_lock returns void, which `$queryRaw` cannot deserialize.
 */
export async function advisoryLock(tx: Tx, ...parts: string[]): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${parts.join('|')}, 0))`;
}
