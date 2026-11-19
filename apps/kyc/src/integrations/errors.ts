// Real горимд шаардлагатай тохиргоо (env) дутуу үед шидэгдэнэ (fail closed). Зөвхөн хувьсагчийн НЭРийг заана — утгыг хэзээ ч оруулахгүй.
export class IntegrationNotConfiguredError extends Error {
  constructor(readonly integration: string, readonly missing: readonly string[]) {
    super(`Integration "${integration}" is not configured for INTEGRATION_MODE=real: missing ${missing.join(', ')}`);
    this.name = 'IntegrationNotConfiguredError';
  }
}

// RealXxx клиент хараахан хэрэгжээгүй үед шидэгдэнэ — "ажиллаж байгаа дүр" үзүүлэхгүй (fail closed).
export class IntegrationNotImplementedError extends Error {
  constructor(readonly integration: string) {
    super(`Integration "${integration}" is not implemented for INTEGRATION_MODE=real`);
    this.name = 'IntegrationNotImplementedError';
  }
}
