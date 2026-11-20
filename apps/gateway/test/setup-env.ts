// Тест процесс бүрийн орчин. TEST_DATABASE_URL-аас gateway-ийн DATABASE_URL (schema=iam) гаргана.
import { useTestDatabaseUrl } from '@los/config/vitest/test-db.mjs';

useTestDatabaseUrl('iam');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.LOGIN_IP_RATE_LIMIT = '1000';
// M9: Redis-д тест процесс бүр өөрийн түлхүүрийн орон зай (тоолуур файл/ажиллуулалт хооронд холилдохгүй)
process.env.RATE_LIMIT_KEY_PREFIX = `test:gw:${process.pid}:${Date.now()}:`;
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.INTERNAL_AUTH_SECRET = 'internal-secret-for-tests';
process.env.AUDIT_SEAL_INTERVAL_MS = '0'; // audit seal: background sealer off (suites purge audit_log); seal tests drive sealAuditLog directly
