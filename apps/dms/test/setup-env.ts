import { useTestDatabaseUrl } from '@los/config/vitest/test-db.mjs';

useTestDatabaseUrl('dms');
process.env.NODE_ENV = 'test';
process.env.OUTBOX_RELAY = 'off';
delete process.env.INTERNAL_AUTH_SECRET;
