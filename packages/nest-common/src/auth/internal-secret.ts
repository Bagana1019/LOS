import { isProduction } from '../config';

/** Production-д INTERNAL_AUTH_SECRET-ийн хамгийн бага урт (богино нууц brute-force-д өртөнө). */
export const MIN_INTERNAL_AUTH_SECRET_LENGTH = 16;

/**
 * CLAUDE.md §3.2.9: сервисүүд gateway-ийн `X-User-Id`/`X-Roles` толгойд итгэдэг. `INTERNAL_AUTH_SECRET` байхгүй бол
 * (ContextAuthGuard `X-Internal-Token`-ийг шалгахгүй) сервисийн порт руу хүрч чадах хэн ч эдгээр толгойг хуурамчаар илгээж болно.
 * Тиймээс NODE_ENV=production үед нууц тохируулаагүй/хоосон/богино бол сервис ЭХЭЛЖ БОЛОХГҮЙ (хүсэлт бүрт биш, bootstrap-д нэг удаа).
 * Production бус орчин хэвээр: нууц заавал биш.
 */
export function assertInternalAuthSecret(env: Record<string, string | undefined> = process.env): void {
  if (!isProduction(env)) return;
  const secret = env.INTERNAL_AUTH_SECRET?.trim() ?? '';
  if (secret.length === 0) {
    throw new Error('INTERNAL_AUTH_SECRET must be set in production: without it any caller that can reach this service could forge X-User-Id / X-Roles. Refusing to start');
  }
  if (secret.length < MIN_INTERNAL_AUTH_SECRET_LENGTH) {
    throw new Error(`INTERNAL_AUTH_SECRET must be at least ${MIN_INTERNAL_AUTH_SECRET_LENGTH} characters in production. Refusing to start`);
  }
  if (isPlaceholderSecret(secret)) {
    throw new Error('INTERNAL_AUTH_SECRET is a public placeholder (e.g. the .env.example value) and must be replaced in production. Refusing to start');
  }
}

/** `.env.example`-ийн `dev-internal-secret-change-me` шиг нийтэд мэдэгдсэн загвар утга (уртын шалгалтыг давдаг). */
export function isPlaceholderSecret(secret: string): boolean {
  return /change[-_ ]?me/i.test(secret);
}
