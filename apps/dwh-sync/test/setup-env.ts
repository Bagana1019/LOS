import { assertTestDatabaseUrl } from '@los/config/vitest/test-db.mjs';

process.env.NODE_ENV = 'test';
// DWH integration tests run only against a database whose name ends in "test" (never the dev/prod DWH).
if (process.env.DWH_TEST_DATABASE_URL) assertTestDatabaseUrl(process.env.DWH_TEST_DATABASE_URL, 'DWH_TEST_DATABASE_URL');
