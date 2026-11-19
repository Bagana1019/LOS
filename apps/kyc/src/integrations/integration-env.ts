// Real adapter-ийн env тохиргоо (CLAUDE.md §3.2.7). origination/shared/integration-mode.ts-ийн kyc-ийн хувилбар: kyc-д INTEGRATION_MODE глобал.
import { IntegrationNotConfiguredError } from './errors';
import { resolveIntegrationMode } from './integration-mode';

type Env = Record<string, string | undefined>;

/** NODE_ENV=production. Том/жижиг үсэг, хоосон зайг үл хамаарна: алдаатай бичлэг production-ийн хамгаалалтыг тойрохгүй. */
export const isProduction = (env: Env = process.env): boolean => env.NODE_ENV?.trim().toLowerCase() === 'production';

const isBlank = (v: string | undefined): boolean => v === undefined || v.trim() === '';

/** Хоосон / зөвхөн хоосон зайтай утга = тохируулаагүй (`.env.example`-ийн `KEY=`). Утгыг trim хийхгүй (нууцыг өөрчлөхгүй). */
export function requireEnv(integration: string, names: readonly string[], env: Env = process.env): Record<string, string> {
  const missing = names.filter((n) => isBlank(env[n]));
  if (missing.length) throw new IntegrationNotConfiguredError(integration, missing);
  return Object.fromEntries(names.map((n) => [n, env[n] as string]));
}

/**
 * Phase 5: NODE_ENV=production + real горимд шаардлагатай env дутуу бол апп ЭХЭЛЖ БОЛОХГҮЙ (assertInternalAuthSecret-ийн загвар).
 * Алдаа зөвхөн хувьсагчийн нэрийг заана. Production биш үед юу ч хийхгүй — тэнд дуудлага бүр fail-closed хэвээр.
 */
export function assertRealIntegrationEnv(integration: string, names: readonly string[], env: Env = process.env): void {
  if (isProduction(env) && resolveIntegrationMode(env) === 'real') requireEnv(integration, names, env);
}
