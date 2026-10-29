import type { PublicSigningSession, SigningRequestView, SigningVerification } from '@los/contracts';

// Тестийн өгөгдөл (production код импортлохгүй). Токен 43 тэмдэгт base64url — жинхэнэ токентой ижил хэлбэр.
export const TOKEN = 'Zx7Qm2-vL_p9RkT4wYb1NcH8sDfG3jUaEoI6tXe5Wq0';
export const CODE = '7K3M9QZ4T8VX';
/** 2026-10-28 06:00:00 UTC = 14:00 Улаанбаатар */
export const NOW_MS = Date.parse('2026-10-28T06:00:00.000Z');

export function sessionFixture(overrides: Partial<PublicSigningSession> = {}): PublicSigningSession {
  return {
    status: 'PENDING',
    contractNo: 'ГЭР-2026-000123',
    signerNameMasked: 'Б. Болд',
    linkExpiresAt: '2026-10-31T06:00:00.000Z',
    providers: [
      { code: 'TRIDUM', displayName: 'Tridum', mock: true },
      { code: 'MONPASS', displayName: 'Monpass', mock: false },
    ],
    provider: null,
    challengeCode: null,
    deepLink: null,
    sessionExpiresAt: null,
    documentViewed: false,
    failureReason: null,
    signedAt: null,
    verificationCode: null,
    signedDocumentAvailable: false,
    signedCopyExpiresAt: null,
    consentVersion: 'v1',
    providerMock: false,
    ...overrides,
  };
}

export const waitingSession = (overrides: Partial<PublicSigningSession> = {}): PublicSigningSession =>
  sessionFixture({
    status: 'IN_PROGRESS',
    documentViewed: true,
    provider: 'TRIDUM',
    challengeCode: '4821',
    deepLink: 'mock-tridum://sign/TRD-MOCK-1',
    sessionExpiresAt: '2026-10-28T06:04:30.000Z',
    ...overrides,
  });

export const signedSession = (overrides: Partial<PublicSigningSession> = {}): PublicSigningSession =>
  sessionFixture({
    status: 'SIGNED',
    documentViewed: true,
    provider: 'TRIDUM',
    signedAt: '2026-10-28T06:05:09.000Z',
    verificationCode: CODE,
    signedDocumentAvailable: true,
    signedCopyExpiresAt: '2026-11-27T06:05:09.000Z',
    ...overrides,
  });

export function verificationFixture(overrides: Partial<SigningVerification> = {}): SigningVerification {
  return {
    valid: true,
    contractNo: 'ГЭР-2026-000123',
    signerNameMasked: 'Б. Болд',
    provider: 'MONPASS',
    signedAt: '2026-10-28T06:05:09.000Z',
    originalSha256: 'a'.repeat(64),
    signedSha256: 'b'.repeat(64),
    certificateIssuer: 'Monpass CA',
    certificateSerial: '0A1B2C3D4E5F',
    mock: false,
    ...overrides,
  };
}

export function staffViewFixture(overrides: Partial<SigningRequestView> = {}): SigningRequestView {
  return {
    id: 'req-1',
    orgId: 'org-1',
    applicationId: 'app-1',
    contractId: 'ctr-1',
    contractNo: 'ГЭР-2026-000123',
    status: 'PENDING',
    provider: null,
    providerMock: false,
    signerCustomerId: 'cus-1',
    signerNameMasked: 'Б. Болд',
    signerPhoneMasked: '+976 ****2233',
    linkExpiresAt: '2026-10-31T06:00:00.000Z',
    signedAt: null,
    signedFileId: null,
    signatureFileId: null,
    verificationCode: null,
    failureReason: null,
    createdAt: '2026-10-28T05:00:00.000Z',
    ...overrides,
  };
}

/** Mock fetch Response */
export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}
