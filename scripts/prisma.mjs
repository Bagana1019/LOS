#!/usr/bin/env node
// Сервис тутмын Prisma/seed ажиллуулагч: `node ../../scripts/prisma.mjs <service> <generate|migrate ...|seed|...>` (cwd = apps/<service>).
//
// Яагаад хэрэгтэй вэ: бүх сервис нэг Postgres-ийн өөр schema-д ажилладаг. Prisma `_prisma_migrations` хүснэгтийг холболтын
// `?schema=` дотор үүсгэдэг тул үүнийг зааж өгөхгүй бол бүх сервис `public._prisma_migrations`-ийг хуваалцаж drift алдаа гарна.
// Тиймээс энд DATABASE_URL-д `schema=<service-ийн schema>`-г автоматаар нэмнэ. Root `.env`-г мөн уншина.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [service, ...args] = process.argv.slice(2);
if (!service || args.length === 0) {
  console.error('usage: prisma.mjs <service> <prisma args... | seed>');
  process.exit(2);
}
const SCHEMA_OF = { gateway: 'iam' };
const schema = SCHEMA_OF[service] ?? service;
const cwd = process.cwd();

for (const p of [resolve(cwd, '../../.env'), resolve(cwd, '.env')]) {
  if (existsSync(p)) process.loadEnvFile(p); // орчинд аль хэдийн тавигдсан утгыг дарахгүй
}
const base = process.env[`${service.toUpperCase()}_DATABASE_URL`] ?? process.env.DATABASE_URL ?? 'postgresql://los:los@localhost:5432/los';
const url = new URL(base);
url.searchParams.set('schema', schema);
const env = { ...process.env, DATABASE_URL: url.toString() };

const require = createRequire(resolve(cwd, 'package.json'));
const isSeed = args[0] === 'seed';
const bin = isSeed ? require.resolve('tsx/cli') : require.resolve('prisma/build/index.js');
const argv = isSeed ? [bin, 'prisma/seed.ts', ...args.slice(1)] : [bin, ...args, ...(args.includes('--schema') ? [] : ['--schema', 'prisma/schema.prisma'].filter(() => !['--help', '-h', '--version', '-v'].some((f) => args.includes(f))))];
const r = spawnSync(process.execPath, argv, { cwd, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
