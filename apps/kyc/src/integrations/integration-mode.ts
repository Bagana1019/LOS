// INTEGRATION_MODE env-ийг задлах (CLAUDE.md §3.2.7). Тохируулаагүй бол 'mock' — гэхдээ NODE_ENV=production үед тодорхой заавал.
export type IntegrationMode = 'mock' | 'real';

export function resolveIntegrationMode(env: Record<string, string | undefined> = process.env): IntegrationMode {
  const raw = env.INTEGRATION_MODE?.trim().toLowerCase();
  if (!raw) {
    // Production-д тохируулаагүйгээс болж чимээгүйхэн mock (зохиомол FIXTURE-* жагсаалт) сонгогдож, бодит хориг жагсаалтыг алдаж болохгүй.
    // Тодорхой INTEGRATION_MODE=mock (жишээ нь staging) зөвшөөрөгдөнө.
    if (env.NODE_ENV?.trim().toLowerCase() === 'production') {
      throw new Error('INTEGRATION_MODE is not set while NODE_ENV=production: refusing to fall back to the mock integrations. Set INTEGRATION_MODE=real (or explicitly INTEGRATION_MODE=mock)');
    }
    return 'mock';
  }
  if (raw === 'mock' || raw === 'real') return raw;
  throw new Error(`Invalid INTEGRATION_MODE "${env.INTEGRATION_MODE}": expected "mock" or "real"`);
}
