// FR-11.4 dms-ээс гарах domain event-үүдийг бүтээнэ (outbox-д SigningStore.transition-ий effects-ээр бичигдэнэ — CLAUDE.md §3.2.4).
// Event-д PII орохгүй: зөвхөн id, гэрээний дугаар, hash, код. correlationId-г дуудагч тодорхойлно.
import { randomUUID } from 'node:crypto';
import type { DomainEvent, SigningFailureReason } from '@los/contracts';
import type { SigningRequestRecord } from '../ports/signing.store';

export type ContractSigningRequestedEvent = Extract<DomainEvent, { type: 'ContractSigningRequested' }>;
export type ContractSignedEvent = Extract<DomainEvent, { type: 'ContractSigned' }>;
export type ContractSigningFailedEvent = Extract<DomainEvent, { type: 'ContractSigningFailed' }>;

/** Event-д хэрэгтэй хүсэлтийн талбарууд (create үед бүтэн record хараахан байхгүй тул `NewSigningRequest`-ээс ч авна) */
export type EventSubject = Pick<SigningRequestRecord, 'id' | 'orgId' | 'applicationId' | 'contractId' | 'contractNo'>;

export interface EventOrigin {
  now: Date;
  /** Ажилтны үйлдэл бол хэрэглэгчийн id; зээлдэгч/provider/систем бол null */
  actorId: string | null;
  correlationId: string;
}

function base(record: EventSubject, origin: EventOrigin) {
  return {
    eventId: randomUUID(),
    occurredAt: origin.now.toISOString(),
    version: 1 as const,
    orgId: record.orgId,
    actorId: origin.actorId,
    correlationId: origin.correlationId,
    signingRequestId: record.id,
    applicationId: record.applicationId,
    contractId: record.contractId,
    contractNo: record.contractNo,
  };
}

export function contractSigningRequested(record: EventSubject & Pick<SigningRequestRecord, 'linkExpiresAt'>, origin: EventOrigin): ContractSigningRequestedEvent {
  return { ...base(record, origin), type: 'ContractSigningRequested', linkExpiresAt: record.linkExpiresAt.toISOString() };
}

export interface SignedFacts {
  provider: NonNullable<SigningRequestRecord['provider']>;
  signedFileId: string;
  signatureFileId: string;
  signedSha256: string;
  signedAt: Date;
  verificationCode: string;
}

/** SIGNED-д шилжих мөрийн ШИНЭ утгууд `facts`-д ирнэ (record нь шилжилтээс өмнөх тул) */
export function contractSigned(record: EventSubject & Pick<SigningRequestRecord, 'originalSha256'>, facts: SignedFacts, origin: EventOrigin): ContractSignedEvent {
  return {
    ...base(record, origin),
    type: 'ContractSigned',
    provider: facts.provider,
    signedFileId: facts.signedFileId,
    signatureFileId: facts.signatureFileId,
    originalSha256: record.originalSha256,
    signedSha256: facts.signedSha256,
    signedAt: facts.signedAt.toISOString(),
    verificationCode: facts.verificationCode,
  };
}

export function contractSigningFailed(record: EventSubject, reason: SigningFailureReason, origin: EventOrigin): ContractSigningFailedEvent {
  return { ...base(record, origin), type: 'ContractSigningFailed', reason };
}
