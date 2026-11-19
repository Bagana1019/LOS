import 'reflect-metadata';
import { useTestDatabaseUrl } from '@los/config/vitest/test-db.mjs';

useTestDatabaseUrl('dms');
process.env.NODE_ENV = 'test';
process.env.OUTBOX_RELAY = 'off';
process.env.INTERNAL_AUTH_SECRET = ''; // '' = guard off, and the key stays defined so a late-loaded .env cannot refill it (H7)
process.env.STORAGE_DRIVER = 'memory';
process.env.FILE_MAX_BYTES = '1048576';
process.env.DMS_RETENTION_SWEEP_SECONDS = '0'; // M10: тестэд timer-гүй; tick-ийг шууд дуудна
