import { useTestDatabaseUrl } from '@los/config/vitest/test-db.mjs';

useTestDatabaseUrl('origination');
process.env.NODE_ENV = 'test';
process.env.OUTBOX_RELAY = 'off';
process.env.INTERNAL_AUTH_SECRET = ''; // '' = guard off, and the key stays defined so a late-loaded .env cannot refill it (H7)
process.env.AUDIT_SEAL_INTERVAL_MS = '0'; // audit seal: background sealer off (suites purge audit_log); seal tests drive sealAuditLog directly
