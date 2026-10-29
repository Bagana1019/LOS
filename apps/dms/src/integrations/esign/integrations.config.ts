// FR-11.4 INTEGRATION_MODE ба mock тохиргоог env-ээс уншиж, шалгана (CLAUDE.md §3.2.7).
// Алдааны мессеж нь env хувьсагчийн НЭР-ийг л хэлнэ; нууцын утгыг хэзээ ч агуулахгүй.
import { z } from 'zod';

export const INTEGRATION_MODES = ['mock', 'real'] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export const DEFAULT_MOCK_APPROVE_AFTER_MS = 3000;
export const MAX_MOCK_APPROVE_AFTER_MS = 60 * 60 * 1000;
/** Зөвхөн dev/тестэд; production-д mock горим ерөнхийдөө хориотой тул энэ утга production-д хэзээ ч ашиглагдахгүй */
export const DEV_MOCK_WEBHOOK_SECRET = 'dev-only-mock-esign-webhook-secret';
export const MIN_MOCK_WEBHOOK_SECRET_LENGTH = 16;

export type IntegrationsConfig =
  | { mode: 'real' }
  | { mode: 'mock'; approveAfterMs: number; webhookSecret: string };

export class IntegrationsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationsConfigError';
  }
}

const modeSchema = z.enum(INTEGRATION_MODES);
const approveAfterMsSchema = z.coerce.number().int().min(0).max(MAX_MOCK_APPROVE_AFTER_MS);
const webhookSecretSchema = z.string().min(MIN_MOCK_WEBHOOK_SECRET_LENGTH);

/** Хоосон/зөвхөн зайтай утгыг "тохируулаагүй" гэж үзнэ (docker-compose `VAR=`) */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

export function loadIntegrationsConfig(env: Readonly<Record<string, string | undefined>>): IntegrationsConfig {
  const rawMode = envValue(env, 'INTEGRATION_MODE')?.trim() ?? 'mock';
  const mode = modeSchema.safeParse(rawMode);
  if (!mode.success) {
    throw new IntegrationsConfigError(`Invalid INTEGRATION_MODE "${rawMode.slice(0, 32)}": expected one of ${INTEGRATION_MODES.join(', ')}`);
  }
  if (mode.data === 'real') return { mode: 'real' };

  if (env.NODE_ENV === 'production') {
    throw new IntegrationsConfigError('INTEGRATION_MODE=mock is not allowed when NODE_ENV=production (INTEGRATION_MODE defaults to mock); set INTEGRATION_MODE=real');
  }
  const approveAfterMs = approveAfterMsSchema.safeParse(envValue(env, 'MOCK_ESIGN_APPROVE_AFTER_MS') ?? DEFAULT_MOCK_APPROVE_AFTER_MS);
  if (!approveAfterMs.success) {
    throw new IntegrationsConfigError(`Invalid MOCK_ESIGN_APPROVE_AFTER_MS: expected an integer between 0 and ${MAX_MOCK_APPROVE_AFTER_MS}`);
  }
  const webhookSecret = webhookSecretSchema.safeParse(envValue(env, 'MOCK_ESIGN_WEBHOOK_SECRET') ?? DEV_MOCK_WEBHOOK_SECRET);
  if (!webhookSecret.success) {
    throw new IntegrationsConfigError(`Invalid MOCK_ESIGN_WEBHOOK_SECRET: expected at least ${MIN_MOCK_WEBHOOK_SECRET_LENGTH} characters`);
  }
  return { mode: 'mock', approveAfterMs: approveAfterMs.data, webhookSecret: webhookSecret.data };
}
