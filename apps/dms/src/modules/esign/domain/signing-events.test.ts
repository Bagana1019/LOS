import { randomUUID } from 'node:crypto';
import { DomainEvent } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { contractSigned, contractSigningFailed, contractSigningRequested, type EventOrigin } from './signing-events';

const subject = { id: randomUUID(), orgId: 'org-1', applicationId: 'app-1', contractId: 'contract-1', contractNo: 'ГЭР-2026-000123' };
const origin: EventOrigin = { now: new Date('2026-10-28T03:00:00.000Z'), actorId: 'officer-7', correlationId: 'corr-1' };

describe('signing events', () => {
  it('ContractSigningRequested: схемд нийцнэ, origin-ийг дамжуулна', () => {
    const event = contractSigningRequested({ ...subject, linkExpiresAt: new Date('2026-10-31T03:00:00.000Z') }, origin);
    expect(DomainEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      type: 'ContractSigningRequested', version: 1, orgId: 'org-1', actorId: 'officer-7', correlationId: 'corr-1', occurredAt: '2026-10-28T03:00:00.000Z',
      signingRequestId: subject.id, applicationId: 'app-1', contractId: 'contract-1', contractNo: 'ГЭР-2026-000123', linkExpiresAt: '2026-10-31T03:00:00.000Z',
    });
  });

  it('ContractSigned: record-ын hash + шинэ facts-ийг нэгтгэнэ; actorId null байж болно', () => {
    const event = contractSigned(
      { ...subject, originalSha256: 'a'.repeat(64) },
      { provider: 'MONPASS', signedFileId: 'f1', signatureFileId: 'f2', signedSha256: 'b'.repeat(64), signedAt: new Date('2026-10-28T02:59:00.000Z'), verificationCode: '7K3QXM9ZB4TN' },
      { ...origin, actorId: null },
    );
    expect(DomainEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      type: 'ContractSigned', actorId: null, provider: 'MONPASS', signedFileId: 'f1', signatureFileId: 'f2', originalSha256: 'a'.repeat(64), signedSha256: 'b'.repeat(64),
      signedAt: '2026-10-28T02:59:00.000Z', verificationCode: '7K3QXM9ZB4TN',
    });
  });

  it.each(['DECLINED', 'EXPIRED', 'IDENTITY_MISMATCH', 'INTEGRITY_ERROR', 'PROVIDER_ERROR', 'CANCELLED'] as const)('ContractSigningFailed(%s): схемд нийцнэ', (reason) => {
    const event = contractSigningFailed(subject, reason, origin);
    expect(DomainEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({ type: 'ContractSigningFailed', reason, signingRequestId: subject.id });
  });

  it('eventId бүр өвөрмөц uuid', () => {
    const ids = new Set(Array.from({ length: 50 }, () => contractSigningFailed(subject, 'EXPIRED', origin).eventId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
