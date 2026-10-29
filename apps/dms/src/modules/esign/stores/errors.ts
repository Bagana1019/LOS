// SigningStore-ийн төрөлжсөн алдаанууд. Мессежид хувийн мэдээлэл ОРОХГҮЙ (id, талбарын нэр, constraint-ийн нэр л).

/** Нэг гэрээнд нэгээс олон идэвхтэй (PENDING|IN_PROGRESS|FINALIZING) хүсэлт үүсгэх гэсэн — DB-ийн partial unique index */
export class ActiveSigningExistsError extends Error {
  constructor(readonly contractId: string) {
    super(`an active signing request already exists for contract ${contractId}`);
    this.name = 'ActiveSigningExistsError';
  }
}

export type SigningUniqueField = 'id' | 'tokenHash' | 'verificationCode' | 'providerRef' | 'eventId';

/**
 * Unique хязгаарлалт зөрчигдсөн. `verificationCode` бол дуудагч шинэ код үүсгээд дахин оролдоно (60 бит тул ховор);
 * `tokenHash`/`id` бол санамсаргүй утга давхцсан гэсэн үг (бараг боломжгүй) — шинээр үүсгэж дахин оролдоно.
 */
export class SigningUniqueViolationError extends Error {
  constructor(readonly field: SigningUniqueField) {
    super(`signing store unique violation: ${field}`);
    this.name = 'SigningUniqueViolationError';
  }
}

export class SigningRequestNotFoundError extends Error {
  constructor(readonly signingRequestId: string) {
    super(`signing request not found: ${signingRequestId}`);
    this.name = 'SigningRequestNotFoundError';
  }
}

/** DB-ийн CHECK constraint (эсвэл memory store-ын тэдгээртэй ижил дүрэм) зөрчигдсөн. `constraint` нь DB-ийн constraint-ийн нэр */
export class SigningConstraintError extends Error {
  constructor(readonly constraint: string) {
    super(`signing store constraint violated: ${constraint}`);
    this.name = 'SigningConstraintError';
  }
}
