import { useTestDatabaseUrl } from '@los/config/vitest/test-db.mjs';

useTestDatabaseUrl('origination');
process.env.NODE_ENV = 'test';
process.env.OUTBOX_RELAY = 'off';
process.env.INTERNAL_AUTH_SECRET = ''; // '' = guard off, and the key stays defined so a late-loaded .env cannot refill it (H7)
