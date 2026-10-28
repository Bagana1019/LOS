// Gateway-ийн e2e тест бодит Postgres-тэй (TEST_DATABASE_URL, `iam` schema). Тохируулаагүй бол тестүүд алгасагдана (CI-д service container).
// Тест бүрийн өмнө `iam` schema-г шинээр үүсгэж migrate + seed хийнэ. Алдаатай DB устгахаас сэргийлж нэр нь `test`-ээр төгссөн DB-д л ажиллана.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const TEST_SEED_PASSWORD = 'Test-Passw0rd!2026';

export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const db = new URL(url).pathname.replace(/^\//, '');
  if (!/test$/i.test(db)) throw new Error(`Refusing to reset database "${db}": TEST_DATABASE_URL must point to a database whose name ends with "test"`);

  const cwd = resolve(__dirname, '..');
  const script = resolve(cwd, '../../scripts/prisma.mjs');
  const env = { ...process.env, GATEWAY_DATABASE_URL: url, NODE_ENV: 'test', SEED_PASSWORD: TEST_SEED_PASSWORD };
  const run = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [script, 'gateway', ...args], { cwd, env, input, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`prisma ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  };
  run(['db', 'execute', '--stdin'], 'DROP SCHEMA IF EXISTS "iam" CASCADE;');
  run(['migrate', 'deploy']);
  run(['seed']);
}
