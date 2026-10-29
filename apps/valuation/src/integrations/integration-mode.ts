export type IntegrationMode = 'mock' | 'real';

/** CLAUDE.md §3.2 rule 7. An unset mode defaults to mock outside production only: mocks must never serve production valuations. */
export function resolveIntegrationMode(env: { INTEGRATION_MODE?: string; NODE_ENV?: string }): IntegrationMode {
  const raw = env.INTEGRATION_MODE?.trim().toLowerCase();
  if (raw === 'mock' || raw === 'real') return raw;
  if (raw) throw new Error(`INTEGRATION_MODE must be 'mock' or 'real', got '${env.INTEGRATION_MODE?.trim()}'`);
  if (env.NODE_ENV === 'production') {
    throw new Error("INTEGRATION_MODE must be set explicitly in production ('mock' is never a default there)");
  }
  return 'mock';
}
