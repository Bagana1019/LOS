import type { IntegrationMode } from '@los/contracts';

type Env = Record<string, string | undefined>;

/** NODE_ENV=production. Том/жижиг үсэг, хоосон зайг үл хамаарна: алдаатай бичлэг production-ийн хамгаалалтыг тойрохгүй (kyc-ийн загвар). */
export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV?.trim().toLowerCase() === 'production';
}

/** `.env.example` нь `KEY=` (хоосон) гэж тавьдаг: хоосон/зөвхөн хоосон зайтай утга = тохируулаагүй. Жинхэнэ утгыг өөрчлөхгүй (нууцыг trim хийхгүй). */
export function unsetIfBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

// CLAUDE.md §3.2.7: гадаад интеграци бүр `integrations/<name>/` дотор interface + MockXxx + RealXxx; INTEGRATION_MODE env-ээр солино.
// Нэг интеграцийг тусад нь солих: INTEGRATION_MODE_QPAY=real (name → том үсэг, `-` → `_`).
// Тохируулаагүй бол 'mock' — ГЭХДЭЭ NODE_ENV=production үед тодорхой заавал (mock Core/банк хуурамч амжилт буцаадаг тул чимээгүй fallback хориотой).
// Тодорхой INTEGRATION_MODE=mock (жишээ нь staging) зөвшөөрөгдөнө — kyc, ERP-тэй ижил.
export function resolveIntegrationMode(name: string, env: Env = process.env): IntegrationMode {
  const specific = unsetIfBlank(env[`INTEGRATION_MODE_${name.toUpperCase().replace(/-/g, '_')}`]);
  const raw = specific ?? unsetIfBlank(env.INTEGRATION_MODE);
  if (raw === undefined) {
    if (isProduction(env)) throw new Error(`INTEGRATION_MODE must be set explicitly (mock | real) in production (integration: ${name}): refusing to fall back to the mock adapter`);
    return 'mock';
  }
  const value = raw.trim().toLowerCase();
  if (value !== 'mock' && value !== 'real') throw new Error(`INTEGRATION_MODE (${name}) нь 'mock' эсвэл 'real' байх ёстой: ${raw}`);
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
  const missing = names.filter((n) => unsetIfBlank(env[n]) === undefined);
  if (missing.length) throw new IntegrationNotConfiguredError(integration, missing);
  return Object.fromEntries(names.map((n) => [n, env[n] as string]));
}
