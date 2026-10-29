import type { DomainEvent } from '@los/contracts';

// Бодит Postgres дээрх contract тестийн АЮУЛГҮЙ БАЙДЛЫН хаалт (prisma.contract.test.ts). Цэвэр функц — DB-д хандахгүй.

/**
 * Тест бүрийн өмнө merchant POS-ийн хүснэгтүүдийг TRUNCATE хийдэг тул зөвхөн:
 *  - `DATABASE_URL` тавигдсан, БА
 *  - өгөгдлийн сангийн нэр тусдаа `test` үгийг агуулсан (`los_test`, `test-los`; `latest`, `contest` БИШ), ЭСВЭЛ хөгжүүлэгч ӨӨРӨӨ `LOS_DB_TEST_ALLOW_TRUNCATE=1` тавьсан үед ажиллана.
 * `pnpm test` нь энэ флагийг ТАВЬДАГГҮЙ; Module 0-ийн setup-env `TEST_DATABASE_URL`-аас л `DATABASE_URL` гаргана — хуваалцсан dev DB санамсаргүй устахгүй.
 */
export interface DbTestGuard {
  enabled: boolean;
  databaseName: string;
  /** Алгасах шалтгаан (DATABASE_URL тавигдсан атал зөвшөөрөгдөөгүй үед) */
  skipReason: string | null;
}

/** `test` нь `_` `-` `.`-аар тусгаарлагдсан тусдаа үг (төгсгөлд тоо зөвшөөрнө: `los_test2`). */
const TEST_DB_NAME = /(^|[_\-.])test\d*($|[_\-.])/i;

export function dbTestGuard(env: Record<string, string | undefined> = process.env): DbTestGuard {
  const url = env.DATABASE_URL;
  const databaseName = (() => {
    try {
      return url ? decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) : '';
    } catch {
      return '';
    }
  })();
  if (!url) return { enabled: false, databaseName, skipReason: null };
  const allowed = env.LOS_DB_TEST_ALLOW_TRUNCATE === '1' || TEST_DB_NAME.test(databaseName);
  return {
    enabled: allowed,
    databaseName,
    skipReason: allowed ? null : `refusing to TRUNCATE the merchant POS tables of database "${databaseName}". Use a dedicated test database (name with a separate "test" word, e.g. los_test, via TEST_DATABASE_URL) or, only if you are sure, set LOS_DB_TEST_ALLOW_TRUNCATE=1 yourself.`,
  };
}

/**
 * `origination.outbox` нь бусад модультой ХУВААЛЦСАН хүснэгт тул тест түүнийг TRUNCATE хийхгүй — зөвхөн өөрийн үүсгэсэн мөрүүдийг
 * (merchant POS-ийн event төрлүүд + тестийн `PRE_EXISTING` marker) устгаж, уншина.
 */
export const TEST_OUTBOX_TYPES = [
  'MerchantStatusChanged', 'PosLeaseDecided', 'PosLeaseAccepted', 'PosLeaseDelivered', 'PosLeaseSettled', 'PosLeaseCancelled', 'PRE_EXISTING',
] as const satisfies ReadonlyArray<DomainEvent['type'] | 'PRE_EXISTING'>;
