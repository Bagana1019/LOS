// Тест процесс бүрийн орчин. TEST_DATABASE_URL-аас gateway-ийн DATABASE_URL (schema=iam) гаргана.
import { useTestDatabaseUrl } from '@los/config/vitest/test-db.mjs';

useTestDatabaseUrl('iam');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.INTERNAL_AUTH_SECRET = 'internal-secret-for-tests';
