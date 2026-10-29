import 'reflect-metadata';
import { useTestDatabaseUrl } from '@los/config/vitest/test-db.mjs';

useTestDatabaseUrl('dms');
process.env.NODE_ENV = 'test';
process.env.OUTBOX_RELAY = 'off';
delete process.env.INTERNAL_AUTH_SECRET;
process.env.STORAGE_DRIVER = 'memory';
process.env.FILE_MAX_BYTES = '1048576';
