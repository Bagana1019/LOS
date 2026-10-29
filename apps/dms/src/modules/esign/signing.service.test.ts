// SigningService — ажилтны (origination → dms) API: хүсэлт үүсгэх, resend, cancel, supersede, харагдац.
import { createHash } from 'node:crypto';
import { DomainEvent, SigningRequestView } from '@los/contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SigningFiles } from './ports/signing-files.port';
import { SigningConflictError, SigningNotFoundError, SigningValidationError } from './errors';
import { captureLogs, CONTRACT_NO, CTX, DEFAULT_REGISTER, getSamplePdf, META, SIGNER_NAME, SIGNER_PHONE, createHarness, rejection, tokenOf, type CapturedLogs } from './signing.test-harness';
import { hashToken } from './domain/tokens';

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
let logs: CapturedLogs;

beforeAll(async () => {
  await getSamplePdf();
});
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

describe('createRequest', () => {
  it('PENDING хүсэлт үүсгэж, токенгүйгээр хадгалаад зөвхөн линкээр токеныг буцаана', async () => {
    const h = await createHarness();
    const { record, signingUrl, token } = await h.create();

    expect(signingUrl).toBe(`${h.config.publicBaseUrl}/sign/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({
      status: 'PENDING', attempts: 0, provider: null, providerRef: null, contractNo: CONTRACT_NO, orgId: 'org-1', applicationId: 'app-1', contractId: 'contract-1',
      originalSha256: sha256(h.sourcePdf), tokenHash: hashToken(token), correlationId: CTX.correlationId, createdBy: CTX.actorId, sourceFileId: h.sourceFileId,
    });
    expect(record.linkExpiresAt).toEqual(new Date(h.clock.now().getTime() + 72 * 3_600_000));
    // Токен хадгалагдсан record, event, audit, лог, дурын газар байхгүй
    const everything = JSON.stringify([record, h.store.events, await h.store.listAudit(record.id)]);
    expect(everything).not.toContain(token);
  });

  it('регистр, утсыг шифрлэж хадгалж, далдалсан хэлбэрийг тусад нь бичнэ', async () => {
    const h = await createHarness();
    const { record } = await h.create();

    expect(record.signerRegisterEnc).not.toContain('12345633');
    expect(record.signerPhoneEnc).not.toContain(SIGNER_PHONE);
    expect(h.cipher.decrypt(record.signerRegisterEnc)).toBe(DEFAULT_REGISTER);
    expect(h.cipher.decrypt(record.signerPhoneEnc)).toBe(SIGNER_PHONE);
    expect(record.signerRegisterMasked).toBe('УА****5633');
    expect(record.signerPhoneMasked).toBe('+976 ****2233');
    expect(record.signerName).toBe(SIGNER_NAME);
  });

  it('регистрийг шифрлэхээс өмнө нормчилно (латин look-alike, жижиг үсэг, зай)', async () => {
    const h = await createHarness();
    const { record } = await h.create({ signer: { customerId: 'c', fullName: SIGNER_NAME, registerNo: 'ab 12345633', phone: SIGNER_PHONE } });

    expect(h.cipher.decrypt(record.signerRegisterEnc)).toBe('АВ12345633');
    expect(record.signerRegisterMasked).toBe('АВ****5633');
  });

  it('ttlHours өгвөл линкийн хугацааг тэр дагуу тооцно', async () => {
    const h = await createHarness();
    const { record } = await h.create({ ttlHours: 24 });
    expect(record.linkExpiresAt).toEqual(new Date(h.clock.now().getTime() + 24 * 3_600_000));
  });

  it('ContractSigningRequested event-ийг CREATE-тэй НЭГ транзакцид, correlationId-тай нь гаргана; CREATED аудит бичнэ', async () => {
    const h = await createHarness();
    const { record } = await h.create({ preferredProvider: 'MONPASS' });

    expect(h.store.events).toHaveLength(1);
    const [event] = h.store.events;
    expect(DomainEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      type: 'ContractSigningRequested', signingRequestId: record.id, applicationId: 'app-1', contractId: 'contract-1', contractNo: CONTRACT_NO, orgId: 'org-1',
      actorId: 'officer-7', correlationId: CTX.correlationId, linkExpiresAt: record.linkExpiresAt.toISOString(), occurredAt: h.clock.now().toISOString(),
    });
    const audit = await h.store.listAudit(record.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ type: 'CREATED', actor: 'officer-7', detail: { preferredProvider: 'MONPASS', superseded: false, linkTtlHours: 72 } });
  });

  it('actorId байхгүй дуудлагад audit actor нь SYSTEM, event actorId нь null', async () => {
    const h = await createHarness();
    const { record } = await h.create({}, { actorId: null, correlationId: 'corr-sys' });
    expect((await h.store.listAudit(record.id))[0].actor).toBe('SYSTEM');
    expect(h.store.events[0]).toMatchObject({ actorId: null, correlationId: 'corr-sys' });
    expect(record.createdBy).toBeNull();
  });

  it('эх файл байхгүй бол SigningValidationError(SOURCE_FILE_NOT_FOUND), хүсэлт үүсэхгүй', async () => {
    const h = await createHarness();
    const error = await rejection(h.create({ sourceFileId: '3f5b3e0a-6f0e-4b52-8c61-0d2a9d9f7c11' }));
    expect(error).toBeInstanceOf(SigningValidationError);
    expect(error).toMatchObject({ reason: 'SOURCE_FILE_NOT_FOUND' });
    expect(h.store.events).toHaveLength(0);
    expect(await h.service.listByApplication('app-1')).toHaveLength(0);
  });

  it('PDF биш файлыг татгалзана (NOT_A_PDF)', async () => {
    const h = await createHarness();
    const notPdf = await h.fileService.put({ name: 'contract.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from('PK\u0003\u0004 not a pdf'), uploadedBy: null });
    expect(await rejection(h.create({ sourceFileId: notPdf.id }))).toMatchObject({ name: 'SigningValidationError', reason: 'NOT_A_PDF' });
  });

  it('DMS-ийн агуулга өөрчлөгдсөн (checksum зөрсөн) файлыг татгалзана (SOURCE_FILE_HASH_MISMATCH)', async () => {
    const h = await createHarness();
    const [key] = h.storage.keys();
    await h.storage.put(key, Buffer.alloc(h.sourcePdf.length, 0x25), 'application/pdf');
    expect(await rejection(h.create())).toMatchObject({ name: 'SigningValidationError', reason: 'SOURCE_FILE_HASH_MISMATCH' });
  });

  it('файлын сан өөрийн sha256-аас өөр агуулга буцаавал татгалзана (давхар хамгаалалт)', async () => {
    const h = await createHarness({ wrapFiles: (files): SigningFiles => ({ ...files, read: async (orgId, id) => ({ ...(await files.read(orgId, id)), sha256: 'f'.repeat(64) }), save: (input) => files.save(input) }) });
    expect(await rejection(h.create())).toMatchObject({ name: 'SigningValidationError', reason: 'SOURCE_FILE_HASH_MISMATCH' });
  });

  it('файлын сангийн дэд бүтцийн алдааг (түр) validation болгохгүй, шууд дамжуулна', async () => {
    const outage = new Error('storage down');
    const h = await createHarness({ wrapFiles: (files): SigningFiles => ({ read: () => Promise.reject(outage), save: (input) => files.save(input) }) });
    expect(await rejection(h.create())).toBe(outage);
  });

  it('хэт богино регистрийг татгалзана (INVALID_SIGNER)', async () => {
    const h = await createHarness();
    const error = await rejection(h.create({ signer: { customerId: 'c', fullName: SIGNER_NAME, registerNo: ' УА-1  ', phone: SIGNER_PHONE } }));
    expect(error).toMatchObject({ name: 'SigningValidationError', reason: 'INVALID_SIGNER' });
  });

  it('нэг гэрээнд идэвхтэй хүсэлт байвал SigningConflictError(ACTIVE_EXISTS) — шинэ event, мөр гарахгүй', async () => {
    const h = await createHarness();
    const first = await h.create();

    const error = await rejection(h.create());
    expect(error).toBeInstanceOf(SigningConflictError);
    expect(error).toMatchObject({ reason: 'ACTIVE_EXISTS', activeRequestId: first.record.id });
    expect(await h.service.listByApplication('app-1')).toHaveLength(1);
    expect(h.store.events).toHaveLength(1);
  });

  it('өөр гэрээний хүсэлт саадгүй үүснэ', async () => {
    const h = await createHarness();
    await h.create();
    await expect(h.create({ contractId: 'contract-2', applicationId: 'app-2' })).resolves.toBeDefined();
  });

  it('зэрэгцээ хоёр create: яг нэг нь амжина, нөгөө нь ACTIVE_EXISTS (DB-ийн unique хамгаалалт)', async () => {
    const h = await createHarness();
    const results = await Promise.allSettled([h.create(), h.create()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SigningConflictError);
    expect(rejected.reason).toMatchObject({ reason: 'ACTIVE_EXISTS' });
    expect(h.store.events).toHaveLength(1);
  });

  it('терминал төлөвийн дараа шинэ хүсэлт үүсгэж болно; түүх хадгалагдаж шинэ нь түрүүлж', async () => {
    const h = await createHarness();
    const first = await h.create();
    await h.service.cancel(first.record.id, CTX);
    h.clock.advance(1000);
    const second = await h.create();

    const list = await h.service.listByApplication('app-1');
    expect(list.map((r) => r.id)).toEqual([second.record.id, first.record.id]);
    expect(list.map((r) => r.status)).toEqual(['PENDING', 'CANCELLED']);
  });

  describe('supersedeActive', () => {
    it('PENDING хуучныг CANCELLED болгож, SUPERSEDED аудит + ContractSigningFailed(CANCELLED) гаргаад шинийг үүсгэнэ', async () => {
      const h = await createHarness();
      const old = await h.create();
      const superseder = { actorId: 'officer-9', correlationId: 'corr-supersede' };

      const fresh = await h.create({ supersedeActive: true }, superseder);

      expect(fresh.record.id).not.toBe(old.record.id);
      expect(fresh.record.status).toBe('PENDING');
      const oldNow = await h.record(old.record.id);
      expect(oldNow).toMatchObject({ status: 'CANCELLED', failureReason: 'CANCELLED', failureDetail: 'SUPERSEDED' });
      expect((await h.store.listAudit(old.record.id)).map((a) => [a.type, a.actor])).toEqual([['CREATED', 'officer-7'], ['SUPERSEDED', 'officer-9']]);
      expect((await h.store.listAudit(fresh.record.id))[0].detail).toMatchObject({ superseded: true });
      // Event-ийн дараалал: хуучин Requested, хуучин Failed(CANCELLED), шинэ Requested
      expect(h.events().map((e) => [e.type, e.signingRequestId])).toEqual([
        ['ContractSigningRequested', old.record.id],
        ['ContractSigningFailed', old.record.id],
        ['ContractSigningRequested', fresh.record.id],
      ]);
      expect(h.store.events[1]).toMatchObject({ reason: 'CANCELLED', correlationId: 'corr-supersede', actorId: 'officer-9' });
      // Хуучин линк нь шинэ хүсэлтийн токеноос өөр бөгөөд цуцлагдсан хүсэлтийг л харуулна
      expect(fresh.token).not.toBe(old.token);
      await expect(h.service.getPublicSession(old.token, META)).resolves.toMatchObject({ status: 'CANCELLED', failureReason: 'CANCELLED' });
      await expect(h.service.getDocumentForReview(old.token, META)).rejects.toMatchObject({ name: 'SigningGoneError', reason: 'TERMINAL' });
    });

    it('IN_PROGRESS хуучны provider session-ийг цуцална', async () => {
      const h = await createHarness();
      const old = await h.create();
      await h.beginSigning(old.token);
      const { providerRef } = await h.record(old.record.id);

      await h.create({ supersedeActive: true });

      expect(await h.tridum.getSession(providerRef as string)).toEqual({ state: 'EXPIRED' });
      expect((await h.record(old.record.id)).status).toBe('CANCELLED');
    });

    it('FINALIZING хуучныг цуцалж болохгүй (гарын үсэг аль хэдийн ирсэн) — ACTIVE_EXISTS', async () => {
      const h = await createHarness();
      const old = await h.create();
      await h.beginSigning(old.token);
      await h.store.transition(old.record.id, ['IN_PROGRESS'], { status: 'FINALIZING' });

      const error = await rejection(h.create({ supersedeActive: true }));
      expect(error).toMatchObject({ name: 'SigningConflictError', reason: 'ACTIVE_EXISTS', activeRequestId: old.record.id });
      expect((await h.record(old.record.id)).status).toBe('FINALIZING');
    });

    it('идэвхтэй хүсэлт байхгүй бол supersedeActive нь юу ч цуцлахгүй', async () => {
      const h = await createHarness();
      await h.create({ supersedeActive: true });
      expect(h.store.events.map((e) => e.type)).toEqual(['ContractSigningRequested']);
    });
  });
});

describe('resend', () => {
  it('токеныг сольж хуучныг тэр даруй үхүүлнэ; хуучин ба үл мэдэгдэх токены алдаа яг ижил', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    h.clock.advanceHours(1);

    const resent = await h.service.resend(record.id, { actorId: 'officer-9', correlationId: 'corr-resend' });
    const newToken = tokenOf(resent.signingUrl);

    expect(newToken).not.toBe(token);
    expect(resent.record.tokenHash).toBe(hashToken(newToken));
    const rotated = await rejection(h.service.getPublicSession(token, META));
    const unknown = await rejection(h.service.getPublicSession('A'.repeat(43), META));
    expect(rotated).toBeInstanceOf(SigningNotFoundError);
    expect(unknown).toBeInstanceOf(SigningNotFoundError);
    expect(rotated).toEqual(unknown);
    expect((rotated as Error).message).toBe((unknown as Error).message);
    await expect(h.service.getPublicSession(newToken, META)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('линкийн хугацааг одооноос ESIGN_LINK_TTL_HOURS-аар сунгана; LINK_ROTATED аудит; event гаргахгүй', async () => {
    const h = await createHarness();
    const { record } = await h.create();
    h.clock.advanceHours(60);

    const resent = await h.service.resend(record.id, { actorId: 'officer-9', correlationId: 'corr-resend' });

    expect(resent.record.linkExpiresAt).toEqual(new Date(h.clock.now().getTime() + 72 * 3_600_000));
    const audit = await h.store.listAudit(record.id);
    expect(audit.at(-1)).toMatchObject({ type: 'LINK_ROTATED', actor: 'officer-9', detail: { linkExpiresAt: resent.record.linkExpiresAt.toISOString() } });
    expect(h.store.events).toHaveLength(1);
  });

  it('урт хугацаатай (168 цаг) хүсэлтийн хугацааг resend богиносгохгүй', async () => {
    const h = await createHarness();
    const { record } = await h.create({ ttlHours: 168 });
    h.clock.advanceHours(1);

    const resent = await h.service.resend(record.id, CTX);
    expect(resent.record.linkExpiresAt).toEqual(record.linkExpiresAt);
  });

  it('IN_PROGRESS үед ч ажиллаж, нээлттэй session-ийг хэвээр үлдээнэ', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    const started = await h.beginSigning(token);

    const resent = await h.service.resend(record.id, CTX);

    expect(resent.record).toMatchObject({ status: 'IN_PROGRESS', challengeCode: started.challengeCode });
    await expect(h.service.refresh(tokenOf(resent.signingUrl), META)).resolves.toMatchObject({ status: 'IN_PROGRESS', challengeCode: started.challengeCode });
  });

  it.each(['FINALIZING', 'CANCELLED'] as const)('%s төлөвт SigningConflictError(INVALID_STATE)', async (status) => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    if (status === 'CANCELLED') await h.service.cancel(record.id, CTX);
    else await h.store.transition(record.id, ['IN_PROGRESS'], { status });

    expect(await rejection(h.service.resend(record.id, CTX))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });
  });

  it('үл мэдэгдэх хүсэлт → SigningNotFoundError', async () => {
    const h = await createHarness();
    expect(await rejection(h.service.resend('3f5b3e0a-6f0e-4b52-8c61-0d2a9d9f7c11', CTX))).toBeInstanceOf(SigningNotFoundError);
  });
});

describe('cancel', () => {
  it('PENDING → CANCELLED: failureReason, CANCELLED аудит, ContractSigningFailed(CANCELLED) нь дуудлагын correlationId-тай', async () => {
    const h = await createHarness();
    const { record } = await h.create();
    const ctx = { actorId: 'officer-9', correlationId: 'corr-cancel' };

    const cancelled = await h.service.cancel(record.id, ctx);

    expect(cancelled).toMatchObject({ status: 'CANCELLED', failureReason: 'CANCELLED', challengeCode: null, deepLink: null });
    expect((await h.store.listAudit(record.id)).at(-1)).toMatchObject({ type: 'CANCELLED', actor: 'officer-9', detail: { reason: 'CANCELLED' } });
    expect(h.store.events.at(-1)).toMatchObject({ type: 'ContractSigningFailed', reason: 'CANCELLED', signingRequestId: record.id, correlationId: 'corr-cancel', actorId: 'officer-9' });
    expect(DomainEvent.parse(h.store.events.at(-1))).toBeTruthy();
  });

  it('IN_PROGRESS үед provider session-ийг цуцална', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    const { providerRef } = await h.record(record.id);
    expect(await h.tridum.getSession(providerRef as string)).toEqual({ state: 'PENDING' });

    await h.service.cancel(record.id, CTX);

    expect(await h.tridum.getSession(providerRef as string)).toEqual({ state: 'EXPIRED' });
  });

  it('provider цуцлалт амжилтгүй болсон ч хүсэлт CANCELLED болно (best-effort), лог-д алдааны нэр л', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    h.tridum.cancelSession = () => Promise.reject(new Error(`boom for ${SIGNER_NAME}`));

    await expect(h.service.cancel(record.id, CTX)).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(logs.lines.some((line) => line.includes('esign.provider.cancel_failed') && line.includes('"errorName":"Error"'))).toBe(true);
    expect(logs.lines.join('\n')).not.toContain(SIGNER_NAME);
  });

  it('аль хэдийн CANCELLED бол өөрчлөлтгүй буцаана (idempotent) — шинэ event, аудит нэмэгдэхгүй', async () => {
    const h = await createHarness();
    const { record } = await h.create();
    await h.service.cancel(record.id, CTX);
    const eventsBefore = h.store.events.length;
    const auditBefore = (await h.store.listAudit(record.id)).length;

    await expect(h.service.cancel(record.id, CTX)).resolves.toMatchObject({ status: 'CANCELLED' });

    expect(h.store.events).toHaveLength(eventsBefore);
    expect(await h.store.listAudit(record.id)).toHaveLength(auditBefore);
  });

  it('FINALIZING, EXPIRED зэрэг төлөвт SigningConflictError(INVALID_STATE)', async () => {
    const h = await createHarness();
    const finalizing = await h.create();
    await h.beginSigning(finalizing.token);
    await h.store.transition(finalizing.record.id, ['IN_PROGRESS'], { status: 'FINALIZING' });
    expect(await rejection(h.service.cancel(finalizing.record.id, CTX))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });

    const expiring = await h.create({ contractId: 'contract-2' });
    h.clock.advanceHours(73);
    await h.service.sweep();
    expect((await h.record(expiring.record.id)).status).toBe('EXPIRED');
    expect(await rejection(h.service.cancel(expiring.record.id, CTX))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });
  });

  it('үл мэдэгдэх хүсэлт → SigningNotFoundError', async () => {
    const h = await createHarness();
    expect(await rejection(h.service.cancel('3f5b3e0a-6f0e-4b52-8c61-0d2a9d9f7c11', CTX))).toBeInstanceOf(SigningNotFoundError);
  });
});

describe('get / listByApplication / toView', () => {
  it('get: үл мэдэгдэх id → SigningNotFoundError', async () => {
    const h = await createHarness();
    expect(await rejection(h.service.get('3f5b3e0a-6f0e-4b52-8c61-0d2a9d9f7c11'))).toBeInstanceOf(SigningNotFoundError);
  });

  it('toView: DTO схемд нийцнэ, PII-г ЗӨВХӨН далдалсан хэлбэрээр гаргана, токен/шифр/hash-гүй', async () => {
    const h = await createHarness();
    const { record, signingUrl, token } = await h.create();

    const view = h.service.toView(await h.service.get(record.id), signingUrl);

    expect(SigningRequestView.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      id: record.id, status: 'PENDING', provider: null, signerCustomerId: 'cust-1', signerNameMasked: 'Б. Болд', signerPhoneMasked: '+976 ****2233',
      signedAt: null, signedFileId: null, signatureFileId: null, verificationCode: null, failureReason: null, signingUrl,
    });
    const text = JSON.stringify({ ...view, signingUrl: undefined });
    for (const secret of [SIGNER_NAME, 'Бат-Эрдэнэ', DEFAULT_REGISTER, '12345633', SIGNER_PHONE, record.signerRegisterEnc, record.signerPhoneEnc, record.tokenHash, token]) {
      expect(text).not.toContain(secret);
    }
  });

  it('toView: signingUrl-гүй дуудлагад signingUrl түлхүүр огт байхгүй', async () => {
    const h = await createHarness();
    const { record } = await h.create();
    expect('signingUrl' in h.service.toView(record)).toBe(false);
  });
});
