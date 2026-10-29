import { describe, expect, it } from 'vitest';
import { ESIGN_CONSENT_VERSION, ContractSigned, ContractSigningFailed, ContractSigningRequested, CreateSigningRequest, DomainEvent, StartPublicSigning } from './index';

const base = { eventId: '3f1c2a0e-8f4b-4a53-9a57-0c2f6a8f1a11', occurredAt: '2026-10-28T09:00:00.000Z', version: 1 as const, orgId: 'org-1', actorId: null, correlationId: 'corr-1' };

describe('e-sign events', () => {
  it('ContractSigned нь DomainEvent union-д орно', () => {
    const e = { ...base, type: 'ContractSigned', signingRequestId: 's1', applicationId: 'a1', contractId: 'c1', contractNo: 'B10026102801', provider: 'TRIDUM', signedFileId: 'f2', signatureFileId: 'f3', originalSha256: 'a'.repeat(64), signedSha256: 'b'.repeat(64), signedAt: '2026-10-28T09:05:00.000Z', verificationCode: 'K7M2Q9XA4TDB' };
    expect(DomainEvent.parse(e).type).toBe('ContractSigned');
    expect(ContractSigned.safeParse(e).success).toBe(true);
  });
  it('ContractSigningRequested / Failed схем', () => {
    expect(ContractSigningRequested.safeParse({ ...base, type: 'ContractSigningRequested', signingRequestId: 's1', applicationId: 'a1', contractId: 'c1', contractNo: 'X', linkExpiresAt: '2026-10-31T09:00:00.000Z' }).success).toBe(true);
    expect(ContractSigningFailed.safeParse({ ...base, type: 'ContractSigningFailed', signingRequestId: 's1', applicationId: 'a1', contractId: 'c1', contractNo: 'X', reason: 'IDENTITY_MISMATCH' }).success).toBe(true);
    expect(ContractSigningFailed.safeParse({ ...base, type: 'ContractSigningFailed', signingRequestId: 's1', applicationId: 'a1', contractId: 'c1', contractNo: 'X', reason: 'NOPE' }).success).toBe(false);
  });
});

describe('e-sign DTO', () => {
  const ok = { orgId: 'o', applicationId: 'a', contractId: 'c', contractNo: 'B1', sourceFileId: 'f', signer: { customerId: 'cu', fullName: 'Бат-Эрдэнэ Болд', registerNo: 'УА12345678', phone: '+97699112233' } };
  it('зөв хүсэлтийг хүлээн авна', () => { expect(CreateSigningRequest.safeParse(ok).success).toBe(true); });
  it('утасны формат буруу бол татгалзана', () => { expect(CreateSigningRequest.safeParse({ ...ok, signer: { ...ok.signer, phone: '99-11' } }).success).toBe(false); });
  it('ttlHours хязгаараас хэтэрвэл татгалзана', () => { expect(CreateSigningRequest.safeParse({ ...ok, ttlHours: 1000 }).success).toBe(false); });
  it('зөвшөөрөлгүйгээр эхлүүлэх боломжгүй', () => {
    expect(StartPublicSigning.safeParse({ provider: 'MONPASS', consent: false, consentVersion: 'v1' }).success).toBe(false);
    expect(StartPublicSigning.safeParse({ provider: 'MONPASS', consent: true, consentVersion: ESIGN_CONSENT_VERSION }).success).toBe(true);
    expect(StartPublicSigning.safeParse({ provider: 'MONPASS', consent: true }).success).toBe(false);
    expect(StartPublicSigning.safeParse({ provider: 'OTHER', consent: true, consentVersion: 'v1' }).success).toBe(false);
  });
});
