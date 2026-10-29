// Сервисийн e2e тестийн DB бэлтгэл (vitest globalSetup-аас): schema-г шинээр үүсгэж migrate + seed хийнэ.
// TEST_DATABASE_URL байхгүй бол юу ч хийхгүй (тестүүд `describe.skipIf`-ээр алгасагдана; CI-д Postgres service).
// Алдаатай DB устгахаас сэргийлж нэр нь `test`-ээр төгссөн DB-д л ажиллана.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const TEST_SEED_PASSWORD = 'Test-Passw0rd!2026';

/** @param {{ service: string; schema?: string; cwd: string; seed?: boolean }} o  cwd = apps/<service> */
export function prepareTestDb({ service, schema = service, cwd, seed = true }) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return false;
  const db = new URL(url).pathname.replace(/^\//, '');
  if (!/test$/i.test(db)) throw new Error(`Refusing to reset database "${db}": TEST_DATABASE_URL must point to a database whose name ends with "test"`);

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

/** Тест процессийн орчин: TEST_DATABASE_URL-аас сервисийн DATABASE_URL (`?schema=`) гаргана. */
export function useTestDatabaseUrl(schema) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const u = new URL(url);
  u.searchParams.set('schema', schema);
  process.env.DATABASE_URL = u.toString();
}
