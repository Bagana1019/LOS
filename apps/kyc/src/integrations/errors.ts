// RealXxx клиент хараахан хэрэгжээгүй үед шидэгдэнэ — "ажиллаж байгаа дүр" үзүүлэхгүй (fail closed).
export class IntegrationNotImplementedError extends Error {
  constructor(readonly integration: string) {
    super(`Integration "${integration}" is not implemented for INTEGRATION_MODE=real`);
    this.name = 'IntegrationNotImplementedError';
  }
}
