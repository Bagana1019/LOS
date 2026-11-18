// H7: DB-backed tests may only ever target a database whose name ends with "test" (packages/config/vitest/test-db.mjs).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertTestDatabaseUrl, databaseNameOf, hasTestDatabase, prepareTestDb, useTestDatabaseUrl } from '@los/config/vitest/test-db.mjs';

const TEST_URL = 'postgresql://los:hunter2@127.0.0.1:5434/los_cfg_test';
const DEV_URL = 'postgresql://los:hunter2@localhost:5434/los';

const messageOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  throw new Error('expected a throw');
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('databaseNameOf', () => {
  it.each([
    [TEST_URL, 'los_cfg_test'],
    ['postgresql://u:p@h:5432/los_test?schema=origination', 'los_test'],
    ['postgresql://h/los', 'los'],
  ])('extracts the database name from %s', (url, expected) => {
    expect(databaseNameOf(url)).toBe(expected);
  });

  it.each([[''], ['not a url'], [undefined], ['postgresql://h:5432']])('returns an empty name for %j', (url) => {
    expect(databaseNameOf(url as string)).toBe('');
  });
});

describe('assertTestDatabaseUrl', () => {
  it.each([[TEST_URL], ['postgresql://h/los_test'], ['postgresql://h/LOS_TEST'], ['postgresql://h/test'], ['postgresql://h/los_kyc_test?schema=kyc']])('accepts %s', (url) => {
    expect(() => assertTestDatabaseUrl(url)).not.toThrow();
  });

  it.each([
    ['the dev database', DEV_URL],
    ['a name that merely contains "test"', 'postgresql://h/los_test_backup'],
    ['a name starting with "test"', 'postgresql://h/testing'],
    ['a url without a database name', 'postgresql://h:5432'],
    ['an empty string', ''],
    ['garbage', 'not a url'],
    ['a trailing slash after the name', 'postgresql://h/los_test/'],
    ['a word that merely ends in "test" (latest)', 'postgresql://h/latest'],
    ['a word that merely ends in "test" (contest)', 'postgresql://h/los_contest'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow(/Refusing/);
  });

  it('names the variable and the database but never leaks credentials', () => {
    const msg = messageOf(() => assertTestDatabaseUrl(DEV_URL, 'DATABASE_URL'));
    expect(msg).toContain('DATABASE_URL');
    expect(msg).toContain('"los"');
    expect(msg).toContain('ends with "test"');
    expect(msg).not.toContain('hunter2');
  });
});

describe('useTestDatabaseUrl', () => {
  it('derives the service DATABASE_URL (with ?schema=) from TEST_DATABASE_URL', () => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: TEST_URL };
    useTestDatabaseUrl('valuation', env);
    const u = new URL(env.DATABASE_URL as string);
    expect(u.pathname).toBe('/los_cfg_test');
    expect(u.searchParams.get('schema')).toBe('valuation');
    expect(env.TEST_DATABASE_URL).toBe(TEST_URL);
  });

  it('replaces an existing schema parameter and keeps the other ones', () => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: `${TEST_URL}?schema=public&connection_limit=3` };
    useTestDatabaseUrl('kyc', env);
    const u = new URL(env.DATABASE_URL as string);
    expect(u.searchParams.get('schema')).toBe('kyc');
    expect(u.searchParams.get('connection_limit')).toBe('3');
  });

  it('refuses a TEST_DATABASE_URL that does not end with "test" and leaves DATABASE_URL alone', () => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: DEV_URL, DATABASE_URL: 'sentinel' };
    expect(() => useTestDatabaseUrl('valuation', env)).toThrow(/Refusing/);
    expect(env.DATABASE_URL).toBe('sentinel');
  });

  it.each([['unset', undefined], ['empty', ''], ['whitespace only', '   ']])('with TEST_DATABASE_URL %s, pins it to "" so a late-loaded .env cannot switch DB mode on', (_label, value) => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: value, DATABASE_URL: 'untouched' };
    useTestDatabaseUrl('valuation', env);
    expect(env.TEST_DATABASE_URL).toBe('');
    expect('TEST_DATABASE_URL' in env).toBe(true); // a key that exists is never overwritten by @nestjs/config
    expect(env.DATABASE_URL).toBe('untouched');
  });
});

describe('hasTestDatabase', () => {
  it.each([['unset', undefined], ['empty', ''], ['whitespace only', '  ']])('is false when TEST_DATABASE_URL is %s', (_label, value) => {
    expect(hasTestDatabase({ TEST_DATABASE_URL: value, DATABASE_URL: DEV_URL })).toBe(false);
  });

  it('is true when TEST_DATABASE_URL and DATABASE_URL both point at a test database', () => {
    expect(hasTestDatabase({ TEST_DATABASE_URL: TEST_URL, DATABASE_URL: `${TEST_URL}?schema=valuation` })).toBe(true);
  });

  it('is true when DATABASE_URL is not set at all', () => {
    expect(hasTestDatabase({ TEST_DATABASE_URL: TEST_URL })).toBe(true);
  });

  it('throws when DATABASE_URL points at the dev database while TEST_DATABASE_URL is set (the H7 failure)', () => {
    const msg = messageOf(() => hasTestDatabase({ TEST_DATABASE_URL: TEST_URL, DATABASE_URL: DEV_URL }));
    expect(msg).toMatch(/Refusing/);
    expect(msg).toContain('DATABASE_URL');
    expect(msg).not.toContain('hunter2');
  });

  it('throws when TEST_DATABASE_URL itself is not a test database', () => {
    expect(() => hasTestDatabase({ TEST_DATABASE_URL: DEV_URL })).toThrow(/Refusing/);
  });

  it('reads process.env by default', () => {
    vi.stubEnv('TEST_DATABASE_URL', TEST_URL);
    vi.stubEnv('DATABASE_URL', DEV_URL);
    expect(() => hasTestDatabase()).toThrow(/Refusing/);
  });
});

describe('prepareTestDb (global setup: drops and recreates the schema)', () => {
  it('does nothing when TEST_DATABASE_URL is not set', () => {
    vi.stubEnv('TEST_DATABASE_URL', '');
    expect(prepareTestDb({ service: 'valuation', cwd: '/nonexistent' })).toBe(false);
  });

  it.each([[DEV_URL], ['postgresql://h/los_test_backup'], ['postgresql://h:5432']])('refuses %s before spawning anything', (url) => {
    vi.stubEnv('TEST_DATABASE_URL', url);
    // cwd does not exist: reaching spawnSync would raise a different error than the guard's.
    expect(() => prepareTestDb({ service: 'valuation', cwd: '/nonexistent' })).toThrow(/Refusing/);
  });
});
