import { describe, expect, it } from 'vitest';
import { dbTestGuard, TEST_OUTBOX_TYPES } from './db-test-guard';

describe('dbTestGuard (prisma.contract.test.ts safety gate)', () => {
  const url = (db: string) => `postgresql://los@localhost:5432/${db}`;

  it('is disabled without DATABASE_URL (the plain `test` run never touches a database)', () => {
    expect(dbTestGuard({})).toEqual({ enabled: false, databaseName: '', skipReason: null });
  });

  it('allows a database whose name has a separate "test" word (any case)', () => {
    for (const db of ['los_test', 'TEST_los', 'los_utf8_test', 'pos_Test_1', 'los-test', 'test', 'los_test2']) {
      expect(dbTestGuard({ DATABASE_URL: url(db) })).toMatchObject({ enabled: true, databaseName: db, skipReason: null });
    }
  });

  it('refuses a shared/dev database unless the developer set LOS_DB_TEST_ALLOW_TRUNCATE=1 explicitly', () => {
    for (const db of ['los', 'postgres', 'origination_dev', 'latest', 'contest_prod', 'attestation', 'pos_review_verify_1']) {
      const g = dbTestGuard({ DATABASE_URL: url(db) });
      expect(g.enabled).toBe(false);
      expect(g.skipReason).toContain(`"${db}"`);
      expect(g.skipReason).toContain('LOS_DB_TEST_ALLOW_TRUNCATE=1');
    }
    expect(dbTestGuard({ DATABASE_URL: url('los'), LOS_DB_TEST_ALLOW_TRUNCATE: '1' }).enabled).toBe(true);
  });

  it('accepts only the exact flag value "1"', () => {
    for (const v of ['true', 'yes', '0', '', ' 1']) expect(dbTestGuard({ DATABASE_URL: url('los'), LOS_DB_TEST_ALLOW_TRUNCATE: v }).enabled).toBe(false);
  });

  it('is disabled (not throwing) for an unparsable URL', () => {
    expect(dbTestGuard({ DATABASE_URL: 'not a url' }).enabled).toBe(false);
  });

  it('only ever cleans merchant POS outbox rows, never other modules\' event types', () => {
    expect(TEST_OUTBOX_TYPES).toContain('PosLeaseDecided');
    expect(TEST_OUTBOX_TYPES).toContain('MerchantStatusChanged');
    expect(TEST_OUTBOX_TYPES.filter((t) => !/^(Pos|Merchant)/.test(t))).toEqual(['PRE_EXISTING']);
  });
});
