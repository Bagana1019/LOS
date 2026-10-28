// Тест процесс бүрийн орчин. TEST_DATABASE_URL-аас gateway-ийн DATABASE_URL (schema=iam) гаргана.
const url = process.env.TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  u.searchParams.set('schema', 'iam');
  process.env.DATABASE_URL = u.toString();
}
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.INTERNAL_AUTH_SECRET = 'internal-secret-for-tests';
