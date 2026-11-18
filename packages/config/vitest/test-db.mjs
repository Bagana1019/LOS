// Сервисийн e2e тестийн DB бэлтгэл (vitest globalSetup-аас): schema-г шинээр үүсгэж migrate + seed хийнэ.
// TEST_DATABASE_URL байхгүй бол юу ч хийхгүй (тестүүд `describe.skipIf`-ээр алгасагдана; CI-д Postgres service).
// Алдаатай DB устгахаас сэргийлж нэр нь `test`-ээр төгссөн DB-д л ажиллана (H7): энэ шалгалт DB руу холбогдох/reset хийхээс ӨМНӨ.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const TEST_SEED_PASSWORD = 'Test-Passw0rd!2026';

/** Холболтын URL-ийн өгөгдлийн сангийн нэр. Задлах боломжгүй бол ''. Хэзээ ч throw хийхгүй. */
export function databaseNameOf(url) {
  try { return new URL(url).pathname.replace(/^\//, ''); } catch { return ''; }
}

/** DB-ийн нэр `test`-ээр төгсөөгүй бол throw. Мессеж нууц үг/хостыг агуулахгүй (зөвхөн DB-ийн нэр). */
export function assertTestDatabaseUrl(url, label = 'TEST_DATABASE_URL') {
  const db = databaseNameOf(url);
  if (!/(^|_)test$/i.test(db)) throw new Error(`Refusing to use database "${db}" (${label}): ${label} must point to a database whose name ends with "test"`);
}

/**
 * Энэ тест процесс бодит DB-тэй ажиллах уу. TEST_DATABASE_URL хоосон бол false.
 * Тохируулсан бол TEST_DATABASE_URL БА DATABASE_URL хоёулаа `test` DB байх ёстой, эс бөгөөс throw
 * (setup-ын дараа DATABASE_URL нь dev DB руу солигдсон бол тест юу ч устгахаас өмнө зогсооно).
 */
export function hasTestDatabase(env = process.env) {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) return false;
  assertTestDatabaseUrl(url, 'TEST_DATABASE_URL');
  if (env.DATABASE_URL?.trim()) assertTestDatabaseUrl(env.DATABASE_URL, 'DATABASE_URL');
  return true;
}

/** @param {{ service: string; schema?: string; cwd: string; seed?: boolean }} o  cwd = apps/<service> */
export function prepareTestDb({ service, schema = service, cwd, seed = true }) {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) return false;
  assertTestDatabaseUrl(url);

  const script = resolve(cwd, '../../scripts/prisma.mjs');
  const env = { ...process.env, [`${service.toUpperCase()}_DATABASE_URL`]: url, NODE_ENV: 'test', SEED_PASSWORD: TEST_SEED_PASSWORD };
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [script, service, ...args], { cwd, env, input, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`prisma ${service} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  };
  run(['db', 'execute', '--stdin'], `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
  run(['migrate', 'deploy']);
  if (seed) run(['seed']);
  return true;
}

/**
 * Тест процессийн орчин: TEST_DATABASE_URL-аас сервисийн DATABASE_URL (`?schema=`) гаргана.
 * TEST_DATABASE_URL хоосон бол `''` болгож НЭГ удаа тогтооно: орчинд байгаа түлхүүрийг @nestjs/config дарахгүй тул
 * хожим ачаалагдсан `.env` DB горимыг (HAS_DB) өөрөө асааж чадахгүй.
 */
export function useTestDatabaseUrl(schema, env = process.env) {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) {
    env.TEST_DATABASE_URL = '';
    return;
  }
  assertTestDatabaseUrl(url);
  const u = new URL(url);
  u.searchParams.set('schema', schema);
  env.DATABASE_URL = u.toString();
}
