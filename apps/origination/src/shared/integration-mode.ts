import type { IntegrationMode } from '@los/contracts';

// CLAUDE.md §3.2.7: гадаад интеграци бүр `integrations/<name>/` дотор interface + MockXxx + RealXxx; INTEGRATION_MODE env-ээр солино.
// Нэг интеграцийг тусад нь солих: INTEGRATION_MODE_QPAY=real (name → том үсэг, `-` → `_`).
export function resolveIntegrationMode(name: string, env: NodeJS.ProcessEnv = process.env): IntegrationMode {
  const specific = env[`INTEGRATION_MODE_${name.toUpperCase().replace(/-/g, '_')}`];
  const value = (specific ?? env.INTEGRATION_MODE ?? 'mock').toLowerCase();
  if (value !== 'mock' && value !== 'real') throw new Error(`INTEGRATION_MODE (${name}) нь 'mock' эсвэл 'real' байх ёстой: ${value}`);
  return value;
}

/** Real горимд шаардлагатай тохиргоо дутуу үед тодорхой алдаа. */
export class IntegrationNotConfiguredError extends Error {
  constructor(readonly integration: string, readonly missing: string[]) {
    super(`${integration}: real горимд ${missing.join(', ')} тохируулаагүй байна`);
    this.name = 'IntegrationNotConfiguredError';
  }
}

export function requireEnv(integration: string, names: string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new IntegrationNotConfiguredError(integration, missing);
  return Object.fromEntries(names.map((n) => [n, env[n] as string]));
}
