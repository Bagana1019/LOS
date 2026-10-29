// ERP синк модулийн domain алдаанууд. Controller HTTP руу хөрвүүлнэ; бусад модуль шууд барина.
export class InvalidErpEventInputError extends Error {
  constructor(message: string, readonly issues: string[] = []) { super(message); this.name = 'InvalidErpEventInputError'; }
}
// Ижил idempotency түлхүүрээр өөр агуулгатай үйл явдал оролдсон — дуудагчийн алдаа, чимээгүй давхардуулахгүй
export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) { super(`ERP event ${idempotencyKey} already exists with different content`); this.name = 'IdempotencyConflictError'; }
}
export class ErpEventNotFoundError extends Error {
  constructor(readonly id: string) { super(`ERP event ${id} not found`); this.name = 'ErpEventNotFoundError'; }
}
export class ErpEventStateError extends Error {
  constructor(message: string) { super(message); this.name = 'ErpEventStateError'; }
}
