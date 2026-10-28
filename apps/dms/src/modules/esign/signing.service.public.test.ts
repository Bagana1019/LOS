// SigningService — зээлдэгчийн (public, токентой) урсгал: харагдац, гэрээ үзэх, start, poll, татгалзах, хугацаа дуусах.
import { DomainEvent, PublicSigningSession } from '@los/contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESignProviderError } from '../../integrations/esign/esign-provider.port';
import type { SigningFiles } from './ports/signing-files.port';
import { SigningNotFoundError, SigningProviderUnavailableError, SigningTooManyAttemptsError } from './errors';
import {
  captureLogs, createHarness, DEFAULT_REGISTER, getSamplePdf, META, registerEndingWith, rejection, SIGNER_NAME, SIGNER_PHONE, type CapturedLogs,
} from './signing.test-harness';
import { sha256Hex } from './domain/digest';

let logs: CapturedLogs;
beforeAll(async () => {
  await getSamplePdf();
});
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  vi.restoreAllMocks();
});

const signer = (registerNo: string) => ({ customerId: 'cust-1', fullName: SIGNER_NAME, registerNo, phone: SIGNER_PHONE });

describe('getPublicSession', () => {
  it('PENDING харагдац: далдалсан нэр, provider-ийн сонголт, DTO схемд нийцнэ, PII-гүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();

    const view = await h.service.getPublicSession(token, META);

    expect(PublicSigningSession.parse(view)).toEqual(view);
    expect(view).toEqual({
      status: 'PENDING', contractNo: record.contractNo, signerNameMasked: 'Б. Болд', linkExpiresAt: record.linkExpiresAt.toISOString(),
      providers: [{ code: 'TRIDUM', displayName: 'Tridum', mock: true }, { code: 'MONPASS', displayName: 'Monpass', mock: true }],
      provider: null, challengeCode: null, deepLink: null, sessionExpiresAt: null, documentViewed: false, failureReason: null, signedAt: null,
      verificationCode: null, signedDocumentAvailable: false, signedCopyExpiresAt: null, consentVersion: 'v1', providerMock: false,
    });
    const text = JSON.stringify(view);
    for (const secret of [SIGNER_NAME, 'Бат-Эрдэнэ', DEFAULT_REGISTER, SIGNER_PHONE, record.tokenHash, token, record.id]) expect(text).not.toContain(secret);
  });

  it('preferredProvider заасан бол зөвхөн тэр provider-ийг санал болгоно', async () => {
    const h = await createHarness();
    const { token } = await h.create({ preferredProvider: 'MONPASS' });
    expect((await h.service.getPublicSession(token, META)).providers).toEqual([{ code: 'MONPASS', displayName: 'Monpass', mock: true }]);
  });

  it('бүртгэлгүй provider-ийг санал болгохгүй (INTEGRATION_MODE-оор бүрдсэн жагсаалт)', async () => {
    const h = await createHarness({ providers: ['TRIDUM'] });
    const { token } = await h.create();
    expect((await h.service.getPublicSession(token, META)).providers.map((p) => p.code)).toEqual(['TRIDUM']);
  });

  it('эхний нээлтийг OPENED аудитад ip/user-agent-тай бичнэ; гэрээг үзсэний дараа дахин бичихгүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();

    await h.service.getPublicSession(token, META);
    const opened = (await h.store.listAudit(record.id)).filter((a) => a.type === 'OPENED');
    expect(opened).toEqual([expect.objectContaining({ actor: 'BORROWER', ip: META.ip, userAgent: META.userAgent })]);

    await h.service.getDocumentForReview(token, META);
    await h.service.getPublicSession(token, META);
    expect((await h.store.listAudit(record.id)).filter((a) => a.type === 'OPENED')).toHaveLength(1);
  });

  it('ip/user-agent-ийн хяналтын тэмдэгтийг арилгаж, уртыг хязгаарлана (audit/log injection)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();

    await h.service.getPublicSession(token, { ip: '10.0.0.1\r\nINJECT', userAgent: `UA\n${'x'.repeat(1000)}` });

    const [opened] = (await h.store.listAudit(record.id)).filter((a) => a.type === 'OPENED');
    expect(opened.ip).toBe('10.0.0.1 INJECT');
    expect(opened.userAgent?.length).toBe(256);
    expect(opened.userAgent).not.toMatch(/[\r\n]/);
  });

  it('үл мэдэгдэх, буруу хэлбэртэй токен → SigningNotFoundError (DB-д хүрэхгүй)', async () => {
    const h = await createHarness();
    const getByTokenHash = vi.spyOn(h.store, 'getByTokenHash');

    for (const token of ['', 'short', 'A'.repeat(43), `${'A'.repeat(42)}!`, 'A'.repeat(500)]) {
      expect(await rejection(h.service.getPublicSession(token, META))).toBeInstanceOf(SigningNotFoundError);
    }
    expect(await rejection(h.service.getPublicSession(undefined as unknown as string, META))).toBeInstanceOf(SigningNotFoundError);
    expect(getByTokenHash).toHaveBeenCalledTimes(1); // зөвхөн 43 тэмдэгтийн зөв хэлбэртэй `A…A`
  });

  it('линк дууссан токен: харагдац EXPIRED, төлөв тэр дор шилжиж ContractSigningFailed(EXPIRED) НЭГ удаа гарна', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    h.clock.advanceHours(73);

    const view = await h.service.getPublicSession(token, META);
    await h.service.getPublicSession(token, META);

    expect(view).toMatchObject({ status: 'EXPIRED', failureReason: 'EXPIRED', providers: [], challengeCode: null, signedDocumentAvailable: false });
    expect((await h.record(record.id)).status).toBe('EXPIRED');
    const failed = h.store.events.filter((e) => e.type === 'ContractSigningFailed');
    expect(failed).toEqual([expect.objectContaining({ reason: 'EXPIRED', signingRequestId: record.id, correlationId: record.correlationId, actorId: null })]);
    expect(DomainEvent.parse(failed[0])).toBeTruthy();
    expect((await h.store.listAudit(record.id)).filter((a) => a.type === 'FAILED')).toHaveLength(1);
  });

  it('линк дууссан IN_PROGRESS: provider-оос асуусан ч PENDING хэвээр бол session-ийг цуцлаад EXPIRED болгоно', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    const { providerRef } = await h.record(record.id);
    h.clock.advanceHours(73);
    vi.spyOn(h.tridum, 'getSession').mockResolvedValue({ state: 'PENDING' });
    const cancel = vi.spyOn(h.tridum, 'cancelSession');

    await expect(h.service.getPublicSession(token, META)).resolves.toMatchObject({ status: 'EXPIRED' });

    expect((await h.record(record.id)).status).toBe('EXPIRED');
    expect(cancel).toHaveBeenCalledWith(providerRef);
  });

  it('линк дууссан IN_PROGRESS үед provider түр боломжгүй бол алдаагүй EXPIRED харагдац өгч, төлвийг sweeper-т үлдээнэ', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    h.clock.advanceHours(73);
    vi.spyOn(h.tridum, 'getSession').mockRejectedValue(new ESignProviderError('UNAVAILABLE', 'down', true));

    await expect(h.service.getPublicSession(token, META)).resolves.toMatchObject({ status: 'EXPIRED', failureReason: 'EXPIRED', challengeCode: null, deepLink: null });
    expect((await h.record(record.id)).status).toBe('IN_PROGRESS');
  });
});

describe('getDocumentForReview', () => {
  it('эх PDF-ийг буцааж, documentViewedAt-ийг тавьж, DOCUMENT_VIEWED аудитыг ip/ua-тай бичнэ (давтахад нэмэхгүй)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();

    const doc = await h.service.getDocumentForReview(token, META);

    expect(doc.bytes.equals(h.sourcePdf)).toBe(true);
    expect(doc).toMatchObject({ mime: 'application/pdf', fileName: 'ГЭР-2026-000123.pdf', sha256: sha256Hex(h.sourcePdf) });
    expect((await h.record(record.id)).documentViewedAt).toEqual(h.clock.now());
    await h.service.getDocumentForReview(token, META);
    const viewed = (await h.store.listAudit(record.id)).filter((a) => a.type === 'DOCUMENT_VIEWED');
    expect(viewed).toEqual([expect.objectContaining({ actor: 'BORROWER', ip: META.ip, userAgent: META.userAgent })]);
    await expect(h.service.getPublicSession(token, META)).resolves.toMatchObject({ documentViewed: true });
  });

  it('IN_PROGRESS үед ч нээлттэй (гэрээг дахин харах)', async () => {
    const h = await createHarness();
    const { token } = await h.create();
    await h.beginSigning(token);
    await expect(h.service.getDocumentForReview(token, META)).resolves.toMatchObject({ mime: 'application/pdf' });
  });

  it('төгсгөлийн төлөвт SigningGoneError(TERMINAL); хугацаа дууссан бол SigningGoneError(EXPIRED)', async () => {
    const h = await createHarness();
    const cancelled = await h.create();
    await h.service.cancel(cancelled.record.id, { actorId: 'o', correlationId: 'c' });
    expect(await rejection(h.service.getDocumentForReview(cancelled.token, META))).toMatchObject({ name: 'SigningGoneError', reason: 'TERMINAL', status: 'CANCELLED' });

    const expired = await h.create({ contractId: 'contract-2' });
    h.clock.advanceHours(73);
    expect(await rejection(h.service.getDocumentForReview(expired.token, META))).toMatchObject({ name: 'SigningGoneError', reason: 'EXPIRED' });
  });

  it('FINALIZING үед SigningConflictError(INVALID_STATE)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    await h.store.transition(record.id, ['IN_PROGRESS'], { status: 'FINALIZING' });
    expect(await rejection(h.service.getDocumentForReview(token, META))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });
  });

  it('эх файл гарын үсэг зурах hash-аас өөр болсон бол үзүүлэхгүй (SOURCE_FILE_HASH_MISMATCH), "үзсэн" гэж тэмдэглэхгүй', async () => {
    const other = Buffer.from('%PDF-1.7 a different, substituted contract');
    let substituted = false;
    const h = await createHarness({
      wrapFiles: (files): SigningFiles => ({
        save: (input) => files.save(input),
        // Агуулга + sha256 нь дотроо тууштай (FileService-ийн шалгалтыг давна) ч бидний хадгалсан originalSha256-аас өөр
        read: async (orgId, id) => {
          const file = await files.read(orgId, id);
          return substituted ? { ...file, bytes: other, sha256: sha256Hex(other), size: other.length } : file;
        },
      }),
    });
    const { record, token } = await h.create();
    substituted = true;

    const error = await rejection(h.service.getDocumentForReview(token, META));

    expect(error).toMatchObject({ name: 'SigningValidationError', reason: 'SOURCE_FILE_HASH_MISMATCH' });
    expect((await h.record(record.id)).documentViewedAt).toBeNull();
    expect(logs.lines.some((line) => line.includes('esign.source.tampered'))).toBe(true);
  });

  it('DMS-ийн файл устсан бол SOURCE_FILE_NOT_FOUND', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.store.transition(record.id, ['PENDING'], { sourceFileId: '3f5b3e0a-6f0e-4b52-8c61-0d2a9d9f7c11' });
    expect(await rejection(h.service.getDocumentForReview(token, META))).toMatchObject({ name: 'SigningValidationError', reason: 'SOURCE_FILE_NOT_FOUND' });
  });

  it('DMS-ийн агуулга эвдэрсэн (checksum зөрсөн) бол SOURCE_FILE_HASH_MISMATCH', async () => {
    const h = await createHarness();
    const { token } = await h.create();
    const [key] = h.storage.keys();
    await h.storage.put(key, Buffer.alloc(h.sourcePdf.length, 0x25), 'application/pdf');
    expect(await rejection(h.service.getDocumentForReview(token, META))).toMatchObject({ name: 'SigningValidationError', reason: 'SOURCE_FILE_HASH_MISMATCH' });
  });
});

describe('start', () => {
  it('гэрээ үзээгүй бол SigningValidationError(DOCUMENT_NOT_VIEWED); provider session нээгдэхгүй, оролдлого шатахгүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    const createSession = vi.spyOn(h.tridum, 'createSession');

    const error = await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META));

    expect(error).toMatchObject({ name: 'SigningValidationError', reason: 'DOCUMENT_NOT_VIEWED' });
    expect(createSession).not.toHaveBeenCalled();
    expect(await h.record(record.id)).toMatchObject({ status: 'PENDING', attempts: 0, consentAt: null });
  });

  it('зөвшөөрөлгүй (consent !== true) бол SigningValidationError(CONSENT_REQUIRED)', async () => {
    const h = await createHarness();
    const { token } = await h.create();
    await h.service.getDocumentForReview(token, META);
    for (const consent of [false, undefined, 'true', 1]) {
      const error = await rejection(h.service.start(token, { provider: 'TRIDUM', consent } as never, META));
      expect(error).toMatchObject({ name: 'SigningValidationError', reason: 'CONSENT_REQUIRED' });
    }
  });

  it('IN_PROGRESS болгож, provider session-ий талбар, оролдлого, зөвшөөрлийн мөчийг хадгалан CONSENT_GIVEN + PROVIDER_SESSION_STARTED аудит бичнэ', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();

    const view = await h.beginSigning(token, 'TRIDUM');

    const stored = await h.record(record.id);
    expect(stored).toMatchObject({
      status: 'IN_PROGRESS', provider: 'TRIDUM', providerMock: true, attempts: 1, consentAt: h.clock.now(), failureReason: null,
      sessionExpiresAt: new Date(h.clock.now().getTime() + 300_000),
    });
    expect(stored.providerRef).toMatch(/^TRD-MOCK-/);
    expect(stored.challengeCode).toMatch(/^\d{4}$/);
    expect(stored.deepLink).toBe(`mock-tridum://sign/${stored.providerRef}`);
    expect(PublicSigningSession.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      status: 'IN_PROGRESS', provider: 'TRIDUM', challengeCode: stored.challengeCode, deepLink: stored.deepLink, sessionExpiresAt: stored.sessionExpiresAt?.toISOString(),
      providers: [{ code: 'TRIDUM', displayName: 'Tridum', mock: true }], documentViewed: true,
    });
    const audit = (await h.store.listAudit(record.id)).filter((a) => a.type === 'CONSENT_GIVEN' || a.type === 'PROVIDER_SESSION_STARTED');
    expect(audit.map((a) => a.type)).toEqual(['CONSENT_GIVEN', 'PROVIDER_SESSION_STARTED']);
    for (const entry of audit) expect(entry).toMatchObject({ actor: 'BORROWER', ip: META.ip, userAgent: META.userAgent });
    expect(audit[1].detail).toMatchObject({ provider: 'TRIDUM', attempt: 1, ttlSeconds: 300 });
  });

  it('provider-т ЗӨВХӨН hash-ийг (PDF-г биш), нормчилсон регистр, callback URL, ttl, correlationId-г дамжуулна', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    const createSession = vi.spyOn(h.monpass, 'createSession');

    await h.beginSigning(token, 'MONPASS');

    expect(createSession).toHaveBeenCalledWith({
      signingRequestId: record.id,
      document: { name: 'ГЭР-2026-000123.pdf', digest: { algorithm: 'SHA-256', hex: sha256Hex(h.sourcePdf) } },
      signer: { fullName: SIGNER_NAME, registerNo: DEFAULT_REGISTER, phone: SIGNER_PHONE },
      callbackUrl: 'http://localhost:4000/api/public/esign/callback/monpass',
      ttlSeconds: 300,
      correlationId: record.correlationId,
    });
    expect((await h.record(record.id)).deepLink).toMatch(/^mock-monpass:\/\//);
  });

  it('session-ий ttl нь линкийн үлдсэн хугацаанаас хэтрэхгүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create({ ttlHours: 1 });
    h.clock.advance(3_600_000 - 10_500); // линк дуусахад 10.5 секунд
    await h.service.getDocumentForReview(token, META);
    const createSession = vi.spyOn(h.tridum, 'createSession');

    await h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META);

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 10 }));
    expect((await h.record(record.id)).sessionExpiresAt).toEqual(new Date(h.clock.now().getTime() + 10_000));
  });

  it('линк дуусахад 1 секундээс бага үлдсэн бол SigningGoneError(EXPIRED)', async () => {
    const h = await createHarness();
    const { token } = await h.create({ ttlHours: 1 });
    await h.service.getDocumentForReview(token, META);
    h.clock.advance(3_600_000 - 500);
    expect(await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META))).toMatchObject({ name: 'SigningGoneError', reason: 'EXPIRED' });
  });

  it('бүртгэлгүй provider → PROVIDER_NOT_AVAILABLE; preferredProvider-оос өөрийг → PROVIDER_NOT_ALLOWED', async () => {
    const single = await createHarness({ providers: ['TRIDUM'] });
    const a = await single.create();
    await single.service.getDocumentForReview(a.token, META);
    expect(await rejection(single.service.start(a.token, { provider: 'MONPASS', consent: true, consentVersion: 'v1' }, META))).toMatchObject({ name: 'SigningValidationError', reason: 'PROVIDER_NOT_AVAILABLE' });

    const h = await createHarness();
    const pinned = await h.create({ preferredProvider: 'MONPASS' });
    await h.service.getDocumentForReview(pinned.token, META);
    expect(await rejection(h.service.start(pinned.token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META))).toMatchObject({ name: 'SigningValidationError', reason: 'PROVIDER_NOT_ALLOWED' });
    await expect(h.service.start(pinned.token, { provider: 'MONPASS', consent: true, consentVersion: 'v1' }, META)).resolves.toMatchObject({ status: 'IN_PROGRESS', provider: 'MONPASS' });
  });

  it('оролдлогын хязгаар хэтэрсэн бол SigningTooManyAttemptsError', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.service.getDocumentForReview(token, META);
    await h.store.transition(record.id, ['PENDING'], { attempts: 3 });
    const createSession = vi.spyOn(h.tridum, 'createSession');

    const error = await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META));

    expect(error).toBeInstanceOf(SigningTooManyAttemptsError);
    expect(error).toMatchObject({ maxAttempts: 3 });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('PENDING биш үед: IN_PROGRESS → INVALID_STATE; төгсгөлийн → SigningGoneError(TERMINAL)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    expect(await rejection(h.service.start(token, { provider: 'MONPASS', consent: true, consentVersion: 'v1' }, META))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });

    await h.service.cancel(record.id, { actorId: 'o', correlationId: 'c' });
    expect(await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META))).toMatchObject({ name: 'SigningGoneError', reason: 'TERMINAL' });
  });

  it('линк дууссан токеноор start хийвэл SigningGoneError(EXPIRED)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.service.getDocumentForReview(token, META);
    h.clock.advanceHours(73);

    expect(await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META))).toMatchObject({ name: 'SigningGoneError', reason: 'EXPIRED' });
    expect((await h.record(record.id)).status).toBe('EXPIRED');
  });

  it('provider алдааг SigningProviderUnavailableError болгож, дэлгэрэнгүйг (регистр, нэр, provider-ийн мессеж) задруулахгүй; оролдлого шатахгүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.service.getDocumentForReview(token, META);
    const leak = `upstream 500 for ${SIGNER_NAME} ${DEFAULT_REGISTER} ${SIGNER_PHONE}`;
    vi.spyOn(h.tridum, 'createSession').mockRejectedValueOnce(new ESignProviderError('UNAVAILABLE', leak, true));

    const error = await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META));

    expect(error).toBeInstanceOf(SigningProviderUnavailableError);
    expect(error).toMatchObject({ retryable: true, code: 'SIGNING_PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify({ message: (error as Error).message, ...(error as object) })).not.toMatch(/Бат|УА1234|99112233|upstream/);
    expect(logs.lines.join('\n')).not.toMatch(/Бат|УА1234|99112233|upstream/);
    expect(logs.lines.some((line) => line.includes('esign.provider.error') && line.includes('"errorCode":"UNAVAILABLE"'))).toBe(true);
    expect(await h.record(record.id)).toMatchObject({ status: 'PENDING', attempts: 0 });
    // Хоёр дахь оролдлого амжилттай
    await expect(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META)).resolves.toMatchObject({ status: 'IN_PROGRESS' });
  });

  it('provider-ийн ESignProviderError бус (түүхий) алдааг ч мөн нэгтгэж, retryable=true', async () => {
    const h = await createHarness();
    const { token } = await h.create();
    await h.service.getDocumentForReview(token, META);
    vi.spyOn(h.tridum, 'createSession').mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'));
    expect(await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META))).toMatchObject({ name: 'SigningProviderUnavailableError', retryable: true });
  });

  it('provider NOT_CONFIGURED/REJECTED бол retryable=false', async () => {
    const h = await createHarness();
    const { token } = await h.create();
    await h.service.getDocumentForReview(token, META);
    vi.spyOn(h.tridum, 'createSession').mockRejectedValueOnce(new ESignProviderError('REJECTED', 'bad'));
    expect(await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META))).toMatchObject({ retryable: false });
  });

  it('зэрэгцээ хоёр start: нэг нь IN_PROGRESS болж, нөгөөх нь INVALID_STATE + өөрийн нээсэн provider session-ийг цуцална', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.service.getDocumentForReview(token, META);
    const cancel = vi.spyOn(h.tridum, 'cancelSession');

    const results = await Promise.allSettled([
      h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META),
      h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });
    const stored = await h.record(record.id);
    expect(stored.attempts).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalledWith(stored.providerRef);
  });
});

describe('refresh (poll) — provider-ийн үр дүнгүүд', () => {
  it('provider хараахан хариулаагүй бол өөрчлөлтгүй, event-гүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    const started = await h.beginSigning(token);

    h.clock.advance(1000);
    const view = await h.service.refresh(token, META);

    expect(view).toEqual(started);
    expect((await h.record(record.id)).status).toBe('IN_PROGRESS');
    expect(h.store.events.map((e) => e.type)).toEqual(['ContractSigningRequested']);
  });

  it('PENDING / терминал хүсэлтэд provider-ээс асуухгүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    const getSession = vi.spyOn(h.tridum, 'getSession');
    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'PENDING' });
    await h.service.cancel(record.id, { actorId: 'o', correlationId: 'c' });
    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('линк дууссан PENDING хүсэлтийг poll шилжүүлнэ', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    h.clock.advanceHours(73);
    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'EXPIRED' });
    expect((await h.record(record.id)).status).toBe('EXPIRED');
  });

  it('fixture 00: зээлдэгч provider дээр татгалзвал DECLINED (төгсгөл) + ContractSigningFailed(DECLINED)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create({ signer: signer(registerEndingWith('00')) });
    await h.beginSigning(token);
    h.clock.advanceSeconds(4);

    const view = await h.service.refresh(token, META);

    expect(view).toMatchObject({ status: 'DECLINED', failureReason: 'DECLINED', challengeCode: null, deepLink: null, sessionExpiresAt: null });
    const stored = await h.record(record.id);
    expect(stored).toMatchObject({ status: 'DECLINED', failureReason: 'DECLINED', challengeCode: null, deepLink: null, sessionExpiresAt: null });
    expect(stored.providerRef).toMatch(/^TRD-MOCK-/); // ул мөр (webhook, дэмжлэг) хадгалагдана
    const last = h.store.events.at(-1);
    expect(last).toMatchObject({ type: 'ContractSigningFailed', reason: 'DECLINED', signingRequestId: record.id, correlationId: record.correlationId, actorId: null });
    expect(DomainEvent.parse(last)).toBeTruthy();
    expect(h.store.events.filter((e) => e.type === 'ContractSigningFailed')).toHaveLength(1);
    const audit = (await h.store.listAudit(record.id)).map((a) => a.type);
    expect(audit.slice(-2)).toEqual(['PROVIDER_SESSION_ENDED', 'FAILED']);
    await h.service.refresh(token, META); // давтан poll нэмэлт event гаргахгүй
    expect(h.store.events.filter((e) => e.type === 'ContractSigningFailed')).toHaveLength(1);
  });

  it('fixture 99: provider session дуусахад линк хүчинтэй, оролдлого үлдсэн бол PENDING рүү буцаж session-ий талбарууд цэвэрлэгдэнэ', async () => {
    const h = await createHarness();
    const { record, token } = await h.create({ signer: signer(registerEndingWith('99')) });
    await h.beginSigning(token, 'TRIDUM');
    h.clock.advanceSeconds(301);

    const view = await h.service.refresh(token, META);

    expect(view).toMatchObject({ status: 'PENDING', provider: null, challengeCode: null, deepLink: null, sessionExpiresAt: null, documentViewed: true });
    expect(view.providers).toHaveLength(2);
    expect(await h.record(record.id)).toMatchObject({ status: 'PENDING', provider: null, providerRef: null, providerMock: false, attempts: 1, failureReason: 'EXPIRED' });
    expect(h.store.events.map((e) => e.type)).toEqual(['ContractSigningRequested']);
    const ended = (await h.store.listAudit(record.id)).find((a) => a.type === 'PROVIDER_SESSION_ENDED');
    expect(ended).toMatchObject({ actor: 'PROVIDER', detail: { provider: 'TRIDUM', outcome: 'EXPIRED', attempt: 1, willRetry: true } });
  });

  it('буцсан PENDING-ээс өөр provider-оор дахин start хийж болно; хязгаар дүүрэхэд EXPIRED (төгсгөл) + event', async () => {
    const h = await createHarness();
    const { record, token } = await h.create({ signer: signer(registerEndingWith('99')) });

    await h.beginSigning(token, 'TRIDUM');
    h.clock.advanceSeconds(301);
    await h.service.refresh(token, META);
    await h.beginSigning(token, 'MONPASS');
    expect(await h.record(record.id)).toMatchObject({ provider: 'MONPASS', attempts: 2, status: 'IN_PROGRESS' });
    h.clock.advanceSeconds(301);
    await h.service.refresh(token, META);
    await h.beginSigning(token, 'TRIDUM');
    expect((await h.record(record.id)).attempts).toBe(3);
    h.clock.advanceSeconds(301);

    const view = await h.service.refresh(token, META);

    expect(view).toMatchObject({ status: 'EXPIRED', failureReason: 'EXPIRED' });
    expect(h.store.events.filter((e) => e.type === 'ContractSigningFailed')).toEqual([expect.objectContaining({ reason: 'EXPIRED', signingRequestId: record.id })]);
    expect(await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META))).toMatchObject({ name: 'SigningGoneError', reason: 'EXPIRED' });
  });

  it('fixture 55: provider алдаа + оролдлого үлдсэн бол PENDING; хязгаар дүүрсэн бол FAILED(PROVIDER_ERROR) + provider-ийн код failureDetail-д', async () => {
    const h = await createHarness({ config: { maxAttempts: 2 } });
    const { record, token } = await h.create({ signer: signer(registerEndingWith('55')) });

    await h.beginSigning(token);
    h.clock.advanceSeconds(4);
    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'PENDING' });
    const ended = (await h.store.listAudit(record.id)).find((a) => a.type === 'PROVIDER_SESSION_ENDED');
    expect(ended?.detail).toMatchObject({ outcome: 'FAILED', willRetry: true, providerCode: 'MOCK_PROVIDER_ERROR' });

    await h.beginSigning(token);
    h.clock.advanceSeconds(4);
    const view = await h.service.refresh(token, META);

    expect(view).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_ERROR' });
    expect(await h.record(record.id)).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_ERROR', failureDetail: 'MOCK_PROVIDER_ERROR', attempts: 2 });
    expect(h.store.events.at(-1)).toMatchObject({ type: 'ContractSigningFailed', reason: 'PROVIDER_ERROR' });
  });

  it('provider session-ийг мэдэхгүй (UNKNOWN_SESSION) бол session алдагдсан гэж үзнэ', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    vi.spyOn(h.tridum, 'getSession').mockRejectedValueOnce(new ESignProviderError('UNKNOWN_SESSION', 'gone'));

    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'PENDING' });
    expect((await h.record(record.id)).providerRef).toBeNull();
  });

  it('provider түр боломжгүй бол SigningProviderUnavailableError (төлөв хэвээр, дараагийн poll дахин оролдоно)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    vi.spyOn(h.tridum, 'getSession').mockRejectedValueOnce(new ESignProviderError('UNAVAILABLE', 'db down', true));

    expect(await rejection(h.service.refresh(token, META))).toMatchObject({ name: 'SigningProviderUnavailableError', retryable: true });
    expect((await h.record(record.id)).status).toBe('IN_PROGRESS');
    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'IN_PROGRESS' });
  });

  it('provider-ийг registry-ээс хассан (NOT_CONFIGURED) бол: линк дуусаагүй үед алдаа; дууссан бол үүрд гацахгүй EXPIRED', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token, 'MONPASS');
    vi.spyOn(h.registry, 'get').mockImplementation(() => {
      throw new ESignProviderError('NOT_CONFIGURED', 'removed');
    });

    expect(await rejection(h.service.refresh(token, META))).toMatchObject({ name: 'SigningProviderUnavailableError', retryable: false });
    h.clock.advanceHours(73);
    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'EXPIRED' });
    expect((await h.record(record.id)).status).toBe('EXPIRED');
  });

  it('provider/ref байхгүй IN_PROGRESS мөр (бүрэн бүтэн бус) session алдагдсан гэж үзэж PENDING болно', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    await h.store.transition(record.id, ['IN_PROGRESS'], { provider: null, providerRef: null });

    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('үл мэдэгдэх токен → SigningNotFoundError', async () => {
    const h = await createHarness();
    expect(await rejection(h.service.refresh('B'.repeat(43), META))).toBeInstanceOf(SigningNotFoundError);
  });
});

describe('decline', () => {
  it('IN_PROGRESS үед зээлдэгч татгалзвал DECLINED: provider session цуцлагдаж, audit (BORROWER, ip/ua) + event бичигдэнэ', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    const { providerRef } = await h.record(record.id);

    const view = await h.service.decline(token, META);

    expect(view).toMatchObject({ status: 'DECLINED', failureReason: 'DECLINED', challengeCode: null });
    expect(await h.record(record.id)).toMatchObject({ status: 'DECLINED', failureReason: 'DECLINED', failureDetail: 'BORROWER' });
    expect(await h.tridum.getSession(providerRef as string)).toEqual({ state: 'EXPIRED' });
    const failedAudit = (await h.store.listAudit(record.id)).find((a) => a.type === 'FAILED');
    expect(failedAudit).toMatchObject({ actor: 'BORROWER', ip: META.ip, userAgent: META.userAgent, detail: { reason: 'DECLINED', detail: 'BORROWER' } });
    expect(h.store.events.at(-1)).toMatchObject({ type: 'ContractSigningFailed', reason: 'DECLINED', correlationId: record.correlationId, actorId: null });
  });

  it('давтан татгалзах нь idempotent (шинэ event байхгүй); PENDING-д INVALID_STATE; бусад терминалд Gone', async () => {
    const h = await createHarness();
    const { token } = await h.create();
    expect(await rejection(h.service.decline(token, META))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });

    await h.beginSigning(token);
    await h.service.decline(token, META);
    const events = h.store.events.length;
    await expect(h.service.decline(token, META)).resolves.toMatchObject({ status: 'DECLINED' });
    expect(h.store.events).toHaveLength(events);

    const other = await h.create({ contractId: 'contract-2' });
    await h.service.cancel(other.record.id, { actorId: 'o', correlationId: 'c' });
    expect(await rejection(h.service.decline(other.token, META))).toMatchObject({ name: 'SigningGoneError', reason: 'TERMINAL' });
  });

  it('FINALIZING үед татгалзаж болохгүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    await h.store.transition(record.id, ['IN_PROGRESS'], { status: 'FINALIZING' });
    expect(await rejection(h.service.decline(token, META))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });
  });
});

describe('PII — public урсгалын бүх гаралт', () => {
  it('харагдац, алдаа, лог, audit, event-д регистр/утас/бүтэн нэр/токен байхгүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    const outputs: unknown[] = [];
    outputs.push(await h.service.getPublicSession(token, META));
    await h.service.getDocumentForReview(token, META);
    outputs.push(await h.beginSigning(token));
    outputs.push(await h.service.refresh(token, META));
    outputs.push(await rejection(h.service.start(token, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }, META)));
    outputs.push(await h.service.decline(token, META));
    outputs.push(await rejection(h.service.getDocumentForReview(token, META)));
    outputs.push(await rejection(h.service.getPublicSession('Z'.repeat(43), META)));
    outputs.push(await h.store.listAudit(record.id), h.store.events);
    const serialized = JSON.stringify(outputs, (_key, value: unknown) => (value instanceof Error ? { ...value, name: value.name, message: value.message } : value)) + logs.lines.join('\n');

    for (const secret of [SIGNER_NAME, 'Бат-Эрдэнэ', DEFAULT_REGISTER, '12345633', SIGNER_PHONE, '99112233', token, record.tokenHash]) {
      expect(serialized, `leaked: ${secret}`).not.toContain(secret);
    }
  });
});
