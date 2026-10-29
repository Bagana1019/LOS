// Postgres-тэй тестийн нийтлэг helper (aml.e2e.test.ts, prisma-aml.repository.int.test.ts). Production код үүнийг импортлохгүй.

/** Тестэд TRUNCATE хийдэг хүснэгтүүд (kyc schema). */
export const KYC_TEST_TABLES = ['kyc.aml_hit', 'kyc.aml_check', 'kyc.blacklist_projection', 'kyc.processed_events', 'kyc.outbox'] as const;

/** DATABASE_URL-ийн өгөгдлийн сангийн нэр. Задлах боломжгүй бол null. */
export function databaseNameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return name || null;
  } catch {
    return null;
  }
}

/** Нэрэнд 'test' агуулаагүй өгөгдлийн санг TRUNCATE хийхээс татгалзана (dev / shared DB-г санамсаргүй арчихаас сэргийлнэ). */
export function assertTestDatabase(url: string | undefined = process.env.DATABASE_URL): void {
  const name = databaseNameOf(url);
  if (!name || !/test/i.test(name)) {
    throw new Error(
      `Refusing to TRUNCATE kyc tables: the database name in DATABASE_URL (${name ? `"${name}"` : 'unparseable'}) must contain "test". `
      + 'Point DATABASE_URL at a throwaway database, e.g. postgresql://user@host:5432/los_kyc_test.',
    );
  }
}

/** Тестийн өмнө хүснэгтүүдийг цэвэрлэнэ; guard-ийг ЗААВАЛ эхэлж шалгана. */
export async function truncateKycTables(db: { $executeRawUnsafe(query: string): Promise<unknown> }, url: string | undefined = process.env.DATABASE_URL): Promise<void> {
  assertTestDatabase(url);
  await db.$executeRawUnsafe(`TRUNCATE ${KYC_TEST_TABLES.join(', ')} CASCADE`);
}
