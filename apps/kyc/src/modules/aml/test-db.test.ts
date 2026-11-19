import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertTestDatabase, databaseNameOf, KYC_TEST_TABLES, truncateKycTables } from './test-db';

const fakeDb = () => {
  const raw = vi.fn(async (_sql: string) => 0);
  const tx = { $executeRawUnsafe: raw };
  return { raw, db: { ...tx, $transaction: async <R>(fn: (t: typeof tx) => Promise<R>) => fn(tx) } };
};

describe('test database guard', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('extracts the database name from a connection url', () => {
    expect(databaseNameOf('postgresql://los@localhost:5544/los_kyc_test')).toBe('los_kyc_test');
    expect(databaseNameOf('postgresql://u:p@host:5432/prod_db?schema=kyc&sslmode=require')).toBe('prod_db');
    expect(databaseNameOf('postgresql://u@host/')).toBeNull();
    expect(databaseNameOf('not a url')).toBeNull();
    expect(databaseNameOf(undefined)).toBeNull();
  });

  it('accepts databases whose name contains "test"', () => {
    expect(() => assertTestDatabase('postgresql://los@localhost:5544/los_kyc_test')).not.toThrow();
    expect(() => assertTestDatabase('postgresql://los@localhost:5544/TEST')).not.toThrow();
    expect(() => assertTestDatabase('postgresql://los@localhost:5544/test_kyc?schema=kyc')).not.toThrow();
  });

  it('refuses any other database, with a clear message', () => {
    expect(() => assertTestDatabase('postgresql://los@localhost:5432/los')).toThrow(/Refusing to TRUNCATE.*"los".*must contain "test"/);
    expect(() => assertTestDatabase('postgresql://los@localhost:5432/')).toThrow(/unparseable/);
    expect(() => assertTestDatabase('garbage')).toThrow(/Refusing to TRUNCATE/);
    expect(() => assertTestDatabase('')).toThrow(/Refusing to TRUNCATE/);
  });

  it('reads DATABASE_URL from the environment by default', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://los@localhost:5432/los');
    expect(() => assertTestDatabase()).toThrow(/Refusing to TRUNCATE/);
    vi.stubEnv('DATABASE_URL', 'postgresql://los@localhost:5432/los_kyc_test');
    expect(() => assertTestDatabase()).not.toThrow();
    vi.stubEnv('DATABASE_URL', '');
    expect(() => assertTestDatabase()).toThrow(/Refusing to TRUNCATE/);
    vi.unstubAllEnvs();
  });

  it('does not touch the database when the guard fails', async () => {
    const { db, raw } = fakeDb();
    await expect(truncateKycTables(db, 'postgresql://los@localhost:5432/los_prod')).rejects.toThrow(/Refusing to TRUNCATE/);
    expect(raw).not.toHaveBeenCalled();
  });

  it('truncates every kyc test table in one statement on a test database', async () => {
    const { db, raw } = fakeDb();
    await truncateKycTables(db, 'postgresql://los@localhost:5544/los_kyc_test');
    // M10: audit_log append-only — TRUNCATE нь тестийн purge транзакц дотор (trigger алгасна)
    expect(raw).toHaveBeenCalledTimes(2);
    expect((raw.mock.calls[0] as unknown as [string])[0]).toBe('SET LOCAL session_replication_role = replica');
    const sql = (raw.mock.calls[1] as unknown as [string])[0];
    for (const table of KYC_TEST_TABLES) expect(sql).toContain(table);
    expect(sql.startsWith('TRUNCATE ')).toBe(true);
  });
});
