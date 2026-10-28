import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Монорепогийн root `.env` + апп-ын `.env`. Аль хэдийн орчинд тавигдсан утгыг дарахгүй. */
export function loadEnvFiles(cwd: string = process.cwd()): void {
  for (const p of [resolve(cwd, '.env'), resolve(cwd, '../../.env')]) {
    if (existsSync(p)) {
      try { process.loadEnvFile(p); } catch { /* буруу .env-ийг нэг л удаа ConfigModule мэдээлнэ */ }
    }
  }
}
export const envFilePaths = ['.env', '../../.env'];
/** Шаардлагатай env байхгүй бол эхлэхгүй (нууц үгийг default-оор орлуулахгүй). */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}
