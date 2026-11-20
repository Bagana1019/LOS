import { auditKeyringFromEnv, MIN_AUDIT_HMAC_KEY_LENGTH } from '@los/database';
import { isProduction } from '../config';
import { isPlaceholderSecret } from './internal-secret';

/**
 * Audit seal (NFR-4, docs/DECISIONS.md 2026-11-19 · audit seal): `audit_log` эзэмшигч сервис (gateway, origination, kyc) production-д
 * `AUDIT_HMAC_KEY`-гүй/хоосон/богино (<32)/нийтийн загвар утгатай эсвэл `INTERNAL_AUTH_SECRET`-тэй ижил бол ЭХЛЭХГҮЙ (bootstrap-д нэг удаа,
 * `assertInternalAuthSecret`-ийн загвар). `AUDIT_HMAC_PREVIOUS_KEYS`-ийн түлхүүр бүр ижил дүрэмтэй. Мессежид түлхүүр хэзээ ч орохгүй.
 * Production бус орчинд заавал биш (түлхүүргүй бол sealer унтарна).
 */
export function assertAuditHmacKey(env: Record<string, string | undefined> = process.env): void {
  if (!isProduction(env)) return;
  const keyring = auditKeyringFromEnv(env); // формат буруу бол throw
  if (!keyring) {
    throw new Error('AUDIT_HMAC_KEY must be set in production: without it audit_log rows are never sealed and tampering goes undetected. Refusing to start');
  }
  const internal = env.INTERNAL_AUTH_SECRET?.trim() ?? '';
  for (const [id, key] of keyring.keys) {
    const value = key.toString('utf8');
    const name = id === keyring.currentKeyId ? 'AUDIT_HMAC_KEY' : `AUDIT_HMAC_PREVIOUS_KEYS[${id}]`;
    if (value.length < MIN_AUDIT_HMAC_KEY_LENGTH) throw new Error(`${name} must be at least ${MIN_AUDIT_HMAC_KEY_LENGTH} characters in production. Refusing to start`);
    if (isPlaceholderSecret(value)) throw new Error(`${name} is a public placeholder (e.g. the .env.example value) and must be replaced in production. Refusing to start`);
    if (internal && value === internal) throw new Error(`${name} must not reuse INTERNAL_AUTH_SECRET. Refusing to start`);
  }
}

export const DEFAULT_AUDIT_SEAL_INTERVAL_MS = 60_000;
/** setInterval-ийн дээд хязгаар (2^31-1 мс). */
export const MAX_AUDIT_SEAL_INTERVAL_MS = 2_147_483_647;
export interface AuditSealSchedule { intervalMs: number; disabledBy: string | null; invalid: string | null }

/**
 * `AUDIT_SEAL_INTERVAL_MS` (хоосон = 60с; бүхэл ≥ 0) ба `AUDIT_SEAL_DISABLED=true` (тодорхой opt-out). 0 / NaN / сөрөг нь seal-ийг ЧИМЭЭГҮЙ унтраахгүйн
 * тулд production-д `assertAuditSealSchedule` эхлэхийг хориглоно; production бус орчинд host анхааруулаад унтраана.
 */
export function auditSealSchedule(env: Record<string, string | undefined> = process.env): AuditSealSchedule {
  if (env.AUDIT_SEAL_DISABLED?.trim().toLowerCase() === 'true') return { intervalMs: 0, disabledBy: 'AUDIT_SEAL_DISABLED=true', invalid: null };
  const raw = env.AUDIT_SEAL_INTERVAL_MS?.trim() ?? '';
  if (raw === '') return { intervalMs: DEFAULT_AUDIT_SEAL_INTERVAL_MS, disabledBy: null, invalid: null };
  const n = Number(raw);
  // > 2^31-1 бол Node-ийн setInterval overflow болж 1 мс тутам ажиллана — буруу гэж үзнэ.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n > MAX_AUDIT_SEAL_INTERVAL_MS) {
    return { intervalMs: 0, disabledBy: null, invalid: `AUDIT_SEAL_INTERVAL_MS must be a non-negative integer <= ${MAX_AUDIT_SEAL_INTERVAL_MS} (milliseconds)` };
  }
  return n === 0 ? { intervalMs: 0, disabledBy: 'AUDIT_SEAL_INTERVAL_MS=0', invalid: null } : { intervalMs: n, disabledBy: null, invalid: null };
}

/** Production: буруу интервал эсвэл `AUDIT_SEAL_INTERVAL_MS=0`-ийг `AUDIT_SEAL_DISABLED=true`-гүйгээр хүлээн авахгүй (seal чимээгүй унтрахаас сэргийлнэ). */
export function assertAuditSealSchedule(env: Record<string, string | undefined> = process.env): void {
  if (!isProduction(env)) return;
  const s = auditSealSchedule(env);
  if (s.invalid) throw new Error(`${s.invalid}. Refusing to start`);
  if (s.disabledBy === 'AUDIT_SEAL_INTERVAL_MS=0') {
    throw new Error('AUDIT_SEAL_INTERVAL_MS=0 would silently disable audit sealing in production; set AUDIT_SEAL_DISABLED=true to opt out explicitly. Refusing to start');
  }
}
