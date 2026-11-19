import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type Env = Record<string, string | undefined>;
const normalized = (value: string | undefined): string | undefined => value?.trim().toLowerCase();

/** NODE_ENV=production. Том/жижиг үсэг, хоосон зайг үл хамаарна: алдаатай бичлэг production-ийн хамгаалалтыг тойрохгүй. */
export function isProduction(env: Env = process.env): boolean {
  return normalized(env.NODE_ENV) === 'production';
}

/** Тестийн процесс (vitest: NODE_ENV=test, VITEST=true). */
export function isTestRuntime(env: Env = process.env): boolean {
  return normalized(env.NODE_ENV) === 'test' || !!env.VITEST;
}

/**
 * Ачаалах `.env` файлууд (cwd-ээс харьцангуй): апп-ын + монорепогийн root.
 * Тестэд ХООСОН: ConfigModule AppModule import хийгдэх үед (setup файлын ДАРАА) ачаалж, root `.env`-ийн
 * INTERNAL_AUTH_SECRET / DATABASE_URL / TEST_DATABASE_URL-ийг буцааж оруулан тестийг dev DB руу чиглүүлдэг байсан (H7).
 */
export function resolveEnvFilePaths(env: Env = process.env): string[] {
  return isTestRuntime(env) ? [] : ['.env', '../../.env'];
}

/** Монорепогийн root `.env` + апп-ын `.env`. Аль хэдийн орчинд тавигдсан утгыг дарахгүй. Тестэд юу ч ачаалахгүй. */
export function loadEnvFiles(cwd: string = process.cwd(), env: Env = process.env): void {
  for (const p of resolveEnvFilePaths(env).map((file) => resolve(cwd, file))) {
    if (existsSync(p)) {
      try { process.loadEnvFile(p); } catch { /* буруу .env-ийг нэг л удаа ConfigModule мэдээлнэ */ }
    }
  }
}
/** AppModule бүрийн `ConfigModule.forRoot({ envFilePath })`. Модуль import хийгдэх үеийн орчноор тогтоно (тестэд []). */
export const envFilePaths = resolveEnvFilePaths();
/** Шаардлагатай env байхгүй (эсвэл хоосон/зөвхөн хоосон зай) бол эхлэхгүй (нууц үгийг default-оор орлуулахгүй). */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`Missing required env ${name}`);
  return v;
}
