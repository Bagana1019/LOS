// SigningService — finalization (шалгах → штамп → DMS → SIGNED), өрсөлдөөн, түр/байнгын алдаа, verify, татаж авах.
import { createHmac } from 'node:crypto';
import { DomainEvent, SigningVerification, type ESignProvider } from '@los/contracts';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSignature } from '../../integrations/esign/esign-provider.port';
import { MOCK_WEBHOOK_SIGNATURE_HEADER } from '../../integrations/esign/mock-remote-signer';
import * as verificationCodes from './domain/verification-code';
import { sha256Hex } from './domain/digest';
import { SigningFinalizationError } from './errors';
import { expectedQrMatrix, extractImages, pageText, readAttachments, readQrMatrix } from './pdf/pdf-inspect';
import type { PdfStamper } from './ports/pdf-stamper.port';
import type { SigningFiles } from './ports/signing-files.port';
import { SigningUniqueViolationError } from './stores/errors';
import {
  captureLogs, createHarness, CONTRACT_NO, CTX, DEFAULT_REGISTER, getSamplePdf, META, registerEndingWith, rejection, SIGNER_NAME, SIGNER_PHONE, tokenOf,
  type CapturedLogs, type Harness,
} from './signing.test-harness';

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
const CODE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** Хүсэлт үүсгэж, session нээж, зээлдэгч баталсан төлөвт хүргэнэ (provider SIGNED хэвээр, finalize хараахан хийгдээгүй) */
async function approved(h: Harness, provider: ESignProvider = 'TRIDUM', overrides: Parameters<Harness['create']>[0] = {}) {
  const created = await h.create(overrides);
  await h.beginSigning(created.token, provider);
  await h.approve(created.record.id);
  return created;
}

/** Provider-ийн бодит SIGNED хариуг авч, өөрчлөөд getSession-ийг түүгээр солино (хуурамч/буруу гарын үсгийг дуурайх) */
async function forgeSignature(h: Harness, id: string, mutate: (signature: ProviderSignature) => ProviderSignature): Promise<void> {
  const record = await h.record(id);
  const port = h.providerPort(record.provider as ESignProvider);
  const state = await port.getSession(record.providerRef as string);
  if (state.state !== 'SIGNED') throw new Error('provider has not signed');
  vi.spyOn(port, 'getSession').mockResolvedValue({ state: 'SIGNED', signature: mutate(state.signature) });
}

const eventsOf = (h: Harness, type: string) => h.events().filter((event) => event.type === type);
const filesInDms = (h: Harness): number => h.storage.keys().length;

describe('амжилттай finalization', () => {
  it.each(['TRIDUM', 'MONPASS'] as const)('%s: poll → SIGNED, яг нэг файлын багц, яг нэг ContractSigned', async (provider) => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token, provider);
    await h.approve(record.id);

    const view = await h.service.refresh(token, META);

    const signed = await h.record(record.id);
    expect(signed.status).toBe('SIGNED');
    expect(signed).toMatchObject({ provider, providerMock: true, failureReason: null, challengeCode: null, deepLink: null, sessionExpiresAt: null, signedAt: h.clock.now() });
    expect(signed.verificationCode).toMatch(CODE);
    expect(signed.signedFileId).toBeTruthy();
    expect(signed.signatureFileId).toBeTruthy();
    expect(signed.certificate).toMatchObject({ subjectName: SIGNER_NAME, issuer: 'LOS MOCK CA (ТЕСТ)' });
    expect(signed.providerTxnId).toBeTruthy();
    expect(view).toMatchObject({ status: 'SIGNED', signedDocumentAvailable: true, signedAt: h.clock.now().toISOString(), challengeCode: null });
    expect(view.verificationCode).toBe(`${signed.verificationCode?.slice(0, 4)}-${signed.verificationCode?.slice(4, 8)}-${signed.verificationCode?.slice(8)}`);
    expect(filesInDms(h)).toBe(3); // эх PDF + гарын үсэгтэй PDF + .p7s
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(1);
    expect(h.store.events.map((e) => e.type)).toEqual(['ContractSigningRequested', 'ContractSigned']);
  });

  it('ContractSigned event: схемд нийцнэ, бүх талбар бодит утгатай, correlationId нь анхны хүсэлтийнх, нэг л удаа (давтан poll/webhook нэмэхгүй)', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);

    await h.service.refresh(token, META);
    await h.service.refresh(token, META);
    const [event] = eventsOf(h, 'ContractSigned');
    const signed = await h.record(record.id);

    expect(eventsOf(h, 'ContractSigned')).toHaveLength(1);
    expect(DomainEvent.parse(event)).toEqual(event);
    expect(event).toEqual({
      type: 'ContractSigned', eventId: expect.any(String), occurredAt: h.clock.now().toISOString(), version: 1, orgId: 'org-1', actorId: null, correlationId: CTX.correlationId,
      signingRequestId: record.id, applicationId: 'app-1', contractId: 'contract-1', contractNo: CONTRACT_NO, provider: 'TRIDUM',
      signedFileId: signed.signedFileId, signatureFileId: signed.signatureFileId, originalSha256: sha256Hex(h.sourcePdf), signedSha256: signed.signedSha256,
      signedAt: signed.signedAt?.toISOString(), verificationCode: signed.verificationCode,
    });
  });

  it('DMS-д "<contractNo>-signed.pdf" ба "<contractNo>.p7s" хадгалагдана; sha256 нь record-той таарна; эх файл хөндөгдөөгүй', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    await h.service.refresh(token, META);
    const signed = await h.record(record.id);

    const pdf = await h.fileService.getContent(signed.signedFileId as string);
    const p7s = await h.fileService.getContent(signed.signatureFileId as string);

    expect(pdf).toMatchObject({ name: `${CONTRACT_NO}-signed.pdf`, mime: 'application/pdf', sha256: signed.signedSha256 });
    expect(p7s).toMatchObject({ name: `${CONTRACT_NO}.p7s`, mime: 'application/pkcs7-signature' });
    expect(p7s.bytes.toString('utf8').startsWith('MOCK-CMS')).toBe(true);
    expect(signed.signedSha256).not.toBe(signed.originalSha256);
    expect(sha256Hex((await h.fileService.getContent(h.sourceFileId)).bytes)).toBe(signed.originalSha256);
  });

  it('штамплагдсан PDF: QR нь verify URL-ийг агуулж, гарын үсгийн хуудас, mock ус тэмдэг, .p7s хавсралт, metadata зөв', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    await h.service.refresh(token, META);
    const signed = await h.record(record.id);
    const code = signed.verificationCode as string;
    const grouped = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;

    const bytes = (await h.fileService.getContent(signed.signedFileId as string)).bytes;
    const p7s = (await h.fileService.getContent(signed.signatureFileId as string)).bytes;
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });

    expect(doc.getPageCount()).toBe(3); // 2 хуудас гэрээ + гарын үсгийн хуудас
    const verifyUrl = `${h.config.publicBaseUrl}/verify/${code}`;
    expect(readQrMatrix(extractImages(doc, doc.getPage(0))[0])).toEqual(expectedQrMatrix(verifyUrl));
    const lastPage = pageText(doc, doc.getPage(2)).join('\n');
    for (const expected of ['ЦАХИМ ГАРЫН ҮСГИЙН ХУУДАС', CONTRACT_NO, grouped, 'УА****5633', 'Tridum', 'LOS MOCK CA (ТЕСТ)', sha256Hex(h.sourcePdf).slice(0, 32)]) {
      expect(lastPage).toContain(expected);
    }
    expect(pageText(doc, doc.getPage(0)).join('\n')).toContain('ТЕСТ — ХҮЧИНГҮЙ');
    expect(pageText(doc, doc.getPage(0)).join('\n')).toContain(grouped);
    const attachment = readAttachments(doc).find((a) => a.name === 'signature.p7s');
    expect(attachment?.bytes.equals(p7s)).toBe(true);
    expect(doc.getTitle()).toBe(`${CONTRACT_NO} — гарын үсэгтэй`);
    expect(doc.getProducer()).toBe('LOS Radix DMS');
    expect(doc.getKeywords()).toContain(sha256Hex(h.sourcePdf));
  });

  it('SIGNED аудит: provider, txn, сериал, hash-тай (PII-гүй); бүтэн амьдралын мөчлөгийн аудитын дараалал', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.service.getPublicSession(token, META);
    await h.beginSigning(token, 'MONPASS');
    await h.approve(record.id);
    await h.service.refresh(token, META);
    const signed = await h.record(record.id);

    const audit = await h.store.listAudit(record.id);

    expect(audit.map((a) => a.type)).toEqual(['CREATED', 'OPENED', 'DOCUMENT_VIEWED', 'CONSENT_GIVEN', 'PROVIDER_SESSION_STARTED', 'SIGNED']);
    expect(audit.at(-1)).toMatchObject({
      actor: 'SYSTEM',
      detail: {
        provider: 'MONPASS', providerTxnId: signed.providerTxnId, certificateSerial: signed.certificate?.serialNumber, originalSha256: signed.originalSha256,
        signedSha256: signed.signedSha256, mock: true,
      },
    });
    const text = JSON.stringify(audit);
    for (const secret of [SIGNER_NAME, DEFAULT_REGISTER, '12345633', SIGNER_PHONE, token]) expect(text).not.toContain(secret);
  });

  it('SIGNED болон төгсгөлийн төлвөөс дахин finalize хийхгүй: provider-ээс асуухгүй', async () => {
    const h = await createHarness();
    const { token } = await approved(h);
    await h.service.refresh(token, META);
    const getSession = vi.spyOn(h.tridum, 'getSession');

    await h.service.refresh(token, META);

    expect(getSession).not.toHaveBeenCalled();
    expect(filesInDms(h)).toBe(3);
  });

  it('гэрчилгээний регистр латин look-alike/жижиг үсэг/зайтай ч (нормчилсон хэлбэрээр) таарвал SIGNED', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    await forgeSignature(h, record.id, (s) => ({ ...s, certificate: { ...s.certificate, subjectRegisterNo: ' ya-12345633 ' } }));

    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'SIGNED' });
  });

  it('signedAt нь зөвшөөрөгдсөн цагийн хэлбэлзэл дотор (ирээдүйд 1 минут) байвал SIGNED', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    await forgeSignature(h, record.id, (s) => ({ ...s, signedAt: new Date(h.clock.now().getTime() + 60_000) }));
    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'SIGNED' });
  });
});

describe('байнгын алдаа → FAILED + ContractSigningFailed (файл хадгалахгүй)', () => {
  async function expectFailed(h: Harness, token: string, id: string, reason: string, detail: string) {
    const view = await h.service.refresh(token, META);
    expect(view).toMatchObject({ status: 'FAILED', failureReason: reason, signedDocumentAvailable: false, verificationCode: null });
    const failed = await h.record(id);
    expect(failed).toMatchObject({
      status: 'FAILED', failureReason: reason, failureDetail: detail, signedFileId: null, signatureFileId: null, verificationCode: null, signedSha256: null, signedAt: null,
      certificate: null, // гэрчилгээ (бусдын регистр байж болно) хадгалагдахгүй
    });
    expect(filesInDms(h)).toBe(1); // зөвхөн эх PDF
    const events = eventsOf(h, 'ContractSigningFailed');
    expect(events).toEqual([expect.objectContaining({ reason, signingRequestId: id, correlationId: failed.correlationId, actorId: null })]);
    expect(DomainEvent.parse(events[0])).toBeTruthy();
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(0);
    expect((await h.store.listAudit(id)).at(-1)).toMatchObject({ type: 'FAILED', actor: 'SYSTEM', detail: { reason, detail } });
    await h.service.refresh(token, META); // давтан poll нэмэлт event гаргахгүй
    expect(eventsOf(h, 'ContractSigningFailed')).toHaveLength(1);
    return failed;
  }

  it('fixture 77: гэрчилгээний регистр зөрөх → FAILED(IDENTITY_MISMATCH)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create({ signer: signer(registerEndingWith('77')) });
    await h.beginSigning(token);
    h.clock.advanceSeconds(4);

    await expectFailed(h, token, record.id, 'IDENTITY_MISMATCH', 'CERTIFICATE_REGISTER_MISMATCH');
  });

  it('fixture 11: гарын үсэг зурсан hash зөрөх → FAILED(INTEGRITY_ERROR)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create({ signer: signer(registerEndingWith('11')) });
    await h.beginSigning(token);
    h.clock.advanceSeconds(4);

    await expectFailed(h, token, record.id, 'INTEGRITY_ERROR', 'DIGEST_MISMATCH');
  });

  it('гэрчилгээ гарын үсэг зурсан мөчид хүчингүй (дууссан / эхлээгүй) → INTEGRITY_ERROR', async () => {
    for (const mutate of [
      (s: ProviderSignature): ProviderSignature => ({ ...s, certificate: { ...s.certificate, notAfter: new Date(s.signedAt.getTime() - 1) } }),
      (s: ProviderSignature): ProviderSignature => ({ ...s, certificate: { ...s.certificate, notBefore: new Date(s.signedAt.getTime() + 1) } }),
    ]) {
      const h = await createHarness();
      const { record, token } = await approved(h);
      await forgeSignature(h, record.id, mutate);
      await expectFailed(h, token, record.id, 'INTEGRITY_ERROR', 'CERTIFICATE_NOT_VALID_AT_SIGNING');
    }
  });

  it('signedAt зөвшөөрлөөс өмнө, эсвэл ирээдүйд (хэлбэлзлээс хол) → INTEGRITY_ERROR', async () => {
    const early = await createHarness();
    const a = await approved(early);
    await forgeSignature(early, a.record.id, (s) => ({ ...s, signedAt: new Date(early.clock.now().getTime() - 3 * 60_000) }));
    await expectFailed(early, a.token, a.record.id, 'INTEGRITY_ERROR', 'SIGNED_BEFORE_CONSENT');

    const future = await createHarness();
    const b = await approved(future);
    await forgeSignature(future, b.record.id, (s) => ({ ...s, signedAt: new Date(future.clock.now().getTime() + 3 * 60_000) }));
    await expectFailed(future, b.token, b.record.id, 'INTEGRITY_ERROR', 'SIGNED_IN_FUTURE');
  });

  it('хоосон CMS гарын үсэг → INTEGRITY_ERROR', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    await forgeSignature(h, record.id, (s) => ({ ...s, signatureCms: Buffer.alloc(0) }));
    await expectFailed(h, token, record.id, 'INTEGRITY_ERROR', 'EMPTY_SIGNATURE');
  });

  it('эх файлыг гарын үсэг зурсны дараа солих (hash зөрөх) → INTEGRITY_ERROR(SOURCE_TAMPERED)', async () => {
    const other = Buffer.from('%PDF-1.7 substituted after consent');
    let substituted = false;
    const h = await createHarness({
      wrapFiles: (files): SigningFiles => ({
        save: (input) => files.save(input),
        read: async (orgId, id) => {
          const file = await files.read(orgId, id);
          return substituted ? { ...file, bytes: other, sha256: sha256Hex(other), size: other.length } : file;
        },
      }),
    });
    const { record, token } = await approved(h);
    substituted = true;

    await expectFailed(h, token, record.id, 'INTEGRITY_ERROR', 'SOURCE_TAMPERED');
  });

  it('DMS-ийн агуулга эвдэрсэн → INTEGRITY_ERROR(SOURCE_FILE_CORRUPT); файл устсан → SOURCE_FILE_MISSING', async () => {
    const corrupt = await createHarness();
    const a = await approved(corrupt);
    const [key] = corrupt.storage.keys();
    await corrupt.storage.put(key, Buffer.alloc(corrupt.sourcePdf.length, 0x25), 'application/pdf');
    await expectFailed(corrupt, a.token, a.record.id, 'INTEGRITY_ERROR', 'SOURCE_FILE_CORRUPT');

    const missing = await createHarness();
    const b = await approved(missing);
    await missing.store.transition(b.record.id, ['IN_PROGRESS'], { sourceFileId: '3f5b3e0a-6f0e-4b52-8c61-0d2a9d9f7c11' });
    await expectFailed(missing, b.token, b.record.id, 'INTEGRITY_ERROR', 'SOURCE_FILE_MISSING');
  });

  it('эх PDF штамплах боломжгүй (эвдэрсэн) бол бодит stamper-ийн InvalidPdfError → INTEGRITY_ERROR(SOURCE_PDF_INVALID)', async () => {
    const h = await createHarness();
    const broken = await h.fileService.put({ name: 'broken.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7\nthis is not a real pdf body'), uploadedBy: null });
    const { record, token } = await approved(h, 'TRIDUM', { sourceFileId: broken.id });

    const view = await h.service.refresh(token, META);

    expect(view).toMatchObject({ status: 'FAILED', failureReason: 'INTEGRITY_ERROR' });
    expect(await h.record(record.id)).toMatchObject({ failureDetail: 'SOURCE_PDF_INVALID', signedFileId: null });
    expect(eventsOf(h, 'ContractSigningFailed')).toHaveLength(1);
  });
});

describe('түр (дэд бүтцийн) алдаа → IN_PROGRESS руу буцаж дахин оролдоно', () => {
  function flakyStamper(failures: number): (stamper: PdfStamper) => PdfStamper {
    let left = failures;
    return (stamper) => ({
      stamp: async (input) => {
        if (left-- > 0) throw new Error(`stamper crashed for ${SIGNER_NAME}`);
        return stamper.stamp(input);
      },
    });
  }

  it('штамп унавал: FINALIZING → IN_PROGRESS, SigningFinalizationError, event/файл гарахгүй; дараагийн poll амжилттай — яг нэг ContractSigned', async () => {
    const h = await createHarness({ wrapStamper: flakyStamper(1) });
    const { record, token } = await approved(h);

    const error = await rejection(h.service.refresh(token, META));

    expect(error).toBeInstanceOf(SigningFinalizationError);
    expect(JSON.stringify({ message: (error as Error).message, ...(error as object) })).not.toContain('Бат');
    expect(await h.record(record.id)).toMatchObject({ status: 'IN_PROGRESS', signedFileId: null });
    expect(filesInDms(h)).toBe(1);
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(0);
    expect(eventsOf(h, 'ContractSigningFailed')).toHaveLength(0);
    // Лог: алдааны нэр л, PII-гүй
    expect(logs.lines.some((line) => line.includes('esign.finalize.transient_error') && line.includes('"errorName":"Error"'))).toBe(true);
    expect(logs.lines.join('\n')).not.toContain('Бат');

    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'SIGNED' });
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(1);
    expect(filesInDms(h)).toBe(3);
  });

  it('DMS-д хадгалах үед унавал (PDF хадгалагдсаны дараа .p7s унах) ч алдагдалгүй дахин оролдож SIGNED; record шинэ файлуудыг заана', async () => {
    let saves = 0;
    const h = await createHarness({
      wrapFiles: (files): SigningFiles => ({
        read: (orgId, id) => files.read(orgId, id),
        save: async (input) => {
          if (++saves === 2) throw new Error('minio down');
          return files.save(input);
        },
      }),
    });
    const { record, token } = await approved(h);

    expect(await rejection(h.service.refresh(token, META))).toBeInstanceOf(SigningFinalizationError);
    expect(await h.record(record.id)).toMatchObject({ status: 'IN_PROGRESS', signedFileId: null, signatureFileId: null });
    expect(filesInDms(h)).toBe(2); // эх + хэнд ч заагдаагүй үлдсэн PDF

    await h.service.refresh(token, META);
    const signed = await h.record(record.id);
    expect(signed.status).toBe('SIGNED');
    expect((await h.fileService.getContent(signed.signedFileId as string)).name).toBe(`${CONTRACT_NO}-signed.pdf`);
    expect((await h.fileService.getContent(signed.signatureFileId as string)).name).toBe(`${CONTRACT_NO}.p7s`);
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(1);
  });

  it('эх файл унших үед дэд бүтцийн алдаа (FileIntegrityError биш) бол түр алдаа гэж үзнэ', async () => {
    let outage = false;
    const h = await createHarness({
      wrapFiles: (files): SigningFiles => ({
        save: (input) => files.save(input),
        read: async (orgId, id) => {
          if (outage) throw new Error('socket hang up');
          return files.read(orgId, id);
        },
      }),
    });
    const { record, token } = await approved(h);

    outage = true;
    expect(await rejection(h.service.refresh(token, META))).toBeInstanceOf(SigningFinalizationError);
    expect((await h.record(record.id)).status).toBe('IN_PROGRESS');
    outage = false;
    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'SIGNED' });
  });

  it('линк дууссан хойно түр алдаа гарвал үүрд оролдохгүй: FAILED(INTEGRITY_ERROR) + event', async () => {
    const h = await createHarness({ wrapStamper: flakyStamper(10) });
    const { record, token } = await approved(h);
    h.clock.advanceHours(73);

    const view = await h.service.refresh(token, META);

    expect(view).toMatchObject({ status: 'FAILED', failureReason: 'INTEGRITY_ERROR' });
    expect(await h.record(record.id)).toMatchObject({ status: 'FAILED', failureDetail: 'FINALIZE_RETRIES_EXHAUSTED' });
    expect(eventsOf(h, 'ContractSigningFailed')).toEqual([expect.objectContaining({ reason: 'INTEGRITY_ERROR' })]);
  });

  it('webhook-оор орсон түр алдаа дээр SigningFinalizationError шидэж (provider дахин илгээнэ), дараагийн webhook амжилттай', async () => {
    const h = await createHarness({ wrapStamper: flakyStamper(1) });
    const { record } = await approved(h, 'MONPASS');
    const body = Buffer.from(JSON.stringify({ providerRef: (await h.record(record.id)).providerRef }));
    const request = { headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: createHmac('sha256', 'unit-test-webhook-secret-0123456789').update(body).digest('hex') }, rawBody: body };

    expect(await rejection(h.service.handleWebhook('monpass', request))).toBeInstanceOf(SigningFinalizationError);
    await h.service.handleWebhook('monpass', request);

    expect((await h.record(record.id)).status).toBe('SIGNED');
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(1);
  });
});

describe('verification code', () => {
  it('өмнө нь олгосон кодтой давхцвал (pre-check) өөр код үүсгэнэ', async () => {
    const h = await createHarness();
    const first = await approved(h);
    await h.service.refresh(first.token, META);
    const taken = (await h.record(first.record.id)).verificationCode as string;
    const real = verificationCodes.generateVerificationCode;
    const generate = vi.spyOn(verificationCodes, 'generateVerificationCode').mockImplementationOnce(() => taken).mockImplementation(real);

    const second = await approved(h, 'MONPASS', { contractId: 'contract-2', applicationId: 'app-2' });
    await h.service.refresh(second.token, META);

    const code = (await h.record(second.record.id)).verificationCode;
    expect(code).toMatch(CODE);
    expect(code).not.toBe(taken);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('pre-check давхцлыг штамп/файл хадгалахаас ӨМНӨ илрүүлнэ: орфан файл үлдэхгүй (зөвхөн гарын үсэгтэй PDF + .p7s нэмэгдэнэ)', async () => {
    const h = await createHarness();
    const first = await approved(h);
    await h.service.refresh(first.token, META);
    const taken = (await h.record(first.record.id)).verificationCode as string;
    const real = verificationCodes.generateVerificationCode;
    vi.spyOn(verificationCodes, 'generateVerificationCode').mockImplementationOnce(() => taken).mockImplementation(real);
    const second = await approved(h, 'MONPASS', { contractId: 'contract-2', applicationId: 'app-2' });
    const before = h.storage.keys().length;

    await h.service.refresh(second.token, META);

    expect(h.storage.keys().length - before).toBe(2);
  });

  it('pre-check-ээс хойш өөр хүсэлт кодыг авчихвал (unique зөрчил) CAS дээр дахин оролдож өөр кодоор SIGNED болно', async () => {
    const h = await createHarness();
    const first = await approved(h);
    await h.service.refresh(first.token, META);
    const taken = (await h.record(first.record.id)).verificationCode as string;
    const real = verificationCodes.generateVerificationCode;
    vi.spyOn(verificationCodes, 'generateVerificationCode').mockImplementationOnce(() => taken).mockImplementation(real);
    // pre-check "чөлөөтэй" гэж худал хэлнэ → зөрчил зөвхөн CAS дээр илэрнэ
    vi.spyOn(h.store, 'getByVerificationCode').mockResolvedValueOnce(null);

    const second = await approved(h, 'MONPASS', { contractId: 'contract-2', applicationId: 'app-2' });
    await expect(h.service.refresh(second.token, META)).resolves.toMatchObject({ status: 'SIGNED' });

    const signed = await h.record(second.record.id);
    expect(signed.verificationCode).not.toBe(taken);
    // Штамп дахин хийгдсэн тул PDF-д ШИНЭ код: QR нь шинэ кодын URL
    const doc = await PDFDocument.load((await h.fileService.getContent(signed.signedFileId as string)).bytes, { updateMetadata: false });
    expect(readQrMatrix(extractImages(doc, doc.getPage(0))[0])).toEqual(expectedQrMatrix(`${h.config.publicBaseUrl}/verify/${signed.verificationCode}`));
    expect(eventsOf(h, 'ContractSigned').filter((e) => e.signingRequestId === second.record.id)).toHaveLength(1);
  });

  it('5 удаа дараалан давхцвал түр алдаа (IN_PROGRESS руу буцна), код хэзээ ч давхцахгүй', async () => {
    const h = await createHarness();
    const first = await approved(h);
    await h.service.refresh(first.token, META);
    const taken = (await h.record(first.record.id)).verificationCode as string;
    const generate = vi.spyOn(verificationCodes, 'generateVerificationCode').mockReturnValue(taken);

    const second = await approved(h, 'MONPASS', { contractId: 'contract-2', applicationId: 'app-2' });
    expect(await rejection(h.service.refresh(second.token, META))).toBeInstanceOf(SigningFinalizationError);

    expect(generate).toHaveBeenCalledTimes(5);
    expect(await h.record(second.record.id)).toMatchObject({ status: 'IN_PROGRESS', verificationCode: null });
  });

  it('verificationCode-оос өөр unique зөрчил (eventId) нь код солилтоор нуугдахгүй — түр алдаа болж IN_PROGRESS руу буцна', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    const original = h.store.transition.bind(h.store);
    vi.spyOn(h.store, 'transition').mockImplementation(async (id, from, patch, effects) =>
      patch.status === 'SIGNED' ? Promise.reject(new SigningUniqueViolationError('eventId')) : original(id, from, patch, effects),
    );

    expect(await rejection(h.service.refresh(token, META))).toBeInstanceOf(SigningFinalizationError);
    expect((await h.record(record.id)).status).toBe('IN_PROGRESS');
  });
});

describe('өрсөлдөөн: poll + webhook + sweeper', () => {
  function webhook(providerRef: string, secret = 'unit-test-webhook-secret-0123456789') {
    const rawBody = Buffer.from(JSON.stringify({ providerRef }));
    return { headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: createHmac('sha256', secret).update(rawBody).digest('hex') }, rawBody };
  }

  it('Promise.all(poll×3, webhook×2): яг ГАНЦ SIGNED файлын багц, ганц ContractSigned', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    const { providerRef } = await h.record(record.id);

    await Promise.all([
      h.service.refresh(token, META),
      h.service.refresh(token, META),
      h.service.refresh(token, META),
      h.service.handleWebhook('tridum', webhook(providerRef as string)),
      h.service.handleWebhook('tridum', webhook(providerRef as string)),
    ]);

    expect((await h.record(record.id)).status).toBe('SIGNED');
    expect(filesInDms(h)).toBe(3); // эх + 1 PDF + 1 p7s — хоёрдох багц хэзээ ч үүсэхгүй
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(1);
    expect(h.store.events.map((e) => e.type)).toEqual(['ContractSigningRequested', 'ContractSigned']);
  });

  it('линк дууссан хойно poll + webhook + sweeper нэгэн зэрэг: нэг л багц, нэг л event', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    const { providerRef } = await h.record(record.id);
    h.clock.advanceHours(73); // provider-ийн шийдвэр (баталсан) хугацаа дууссан ч хүчинтэй

    const results = await Promise.all([
      h.service.refresh(token, META),
      h.service.handleWebhook('tridum', webhook(providerRef as string)),
      h.service.sweep(),
      h.service.sweep(),
    ]);

    expect((await h.record(record.id)).status).toBe('SIGNED');
    expect(filesInDms(h)).toBe(3);
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(1);
    expect(eventsOf(h, 'ContractSigningFailed')).toHaveLength(0);
    // sweeper-ийн хоёр дуудлагын аль нэг нь л SIGNED болгосон гэж тоолно; нийт дээр давхар тоолохгүй
    expect(results.slice(2).reduce((sum, r) => sum + (r as { signed: number }).signed, 0)).toBeLessThanOrEqual(1);
  });

  it('finalize-ийг хожигдсон тал FINALIZING-ийг харвал өөрчлөхгүй буцна (дуусгах ажилтан өөр)', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    await h.store.transition(record.id, ['IN_PROGRESS'], { status: 'FINALIZING' });

    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'FINALIZING' });
    expect(filesInDms(h)).toBe(1);
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(0);
  });
});

describe('webhook', () => {
  const SECRET = 'unit-test-webhook-secret-0123456789';
  const signedRequest = (payload: unknown, secret = SECRET) => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    return { headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: createHmac('sha256', secret).update(rawBody).digest('hex') }, rawBody };
  };

  it('хүчинтэй webhook → provider-оос дахин асууж SIGNED болгоно; WEBHOOK_RECEIVED аудит (PROVIDER)', async () => {
    const h = await createHarness();
    const { record } = await approved(h, 'MONPASS');
    const { providerRef } = await h.record(record.id);

    await h.service.handleWebhook('MONPASS', signedRequest({ providerRef }));

    expect((await h.record(record.id)).status).toBe('SIGNED');
    const audit = await h.store.listAudit(record.id);
    expect(audit.map((a) => a.type)).toContain('WEBHOOK_RECEIVED');
    expect(audit.find((a) => a.type === 'WEBHOOK_RECEIVED')).toMatchObject({ actor: 'PROVIDER', detail: { provider: 'MONPASS' } });
  });

  it('webhook-ийн БИЕ-д итгэхгүй: "state: SIGNED" гэж хэлсэн ч provider PENDING бол төлөв өөрчлөгдөхгүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token); // зээлдэгч хараахан батлаагүй
    const { providerRef } = await h.record(record.id);

    await h.service.handleWebhook('tridum', signedRequest({ providerRef, state: 'SIGNED', status: 'SIGNED', signedDigestHex: 'f'.repeat(64) }));

    expect((await h.record(record.id)).status).toBe('IN_PROGRESS');
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(0);
  });

  it('webhook-оор татгалзсан ч (fixture 00) төлөв provider-ийн хариугаар DECLINED болно', async () => {
    const h = await createHarness();
    const { record, token } = await h.create({ signer: signer(registerEndingWith('00')) });
    await h.beginSigning(token);
    h.clock.advanceSeconds(4);
    const { providerRef } = await h.record(record.id);

    await h.service.handleWebhook('tridum', signedRequest({ providerRef }));

    expect((await h.record(record.id)).status).toBe('DECLINED');
  });

  it('буруу гарын үсэг / гарын үсэггүй / өөр provider-ийн ref → SigningWebhookRejectedError, юу ч өөрчлөгдөхгүй', async () => {
    const h = await createHarness();
    const { record } = await approved(h, 'TRIDUM');
    const { providerRef } = await h.record(record.id);
    const before = (await h.store.listAudit(record.id)).length;

    const forged = signedRequest({ providerRef }, 'attacker-secret-attacker-secret');
    const missing = { headers: {}, rawBody: Buffer.from(JSON.stringify({ providerRef })) };
    const foreignRef = signedRequest({ providerRef: 'MPS-MOCK-1234' });
    for (const request of [forged, missing, foreignRef]) {
      const error = await rejection(h.service.handleWebhook('tridum', request));
      expect(error).toMatchObject({ name: 'SigningWebhookRejectedError', code: 'SIGNING_WEBHOOK_REJECTED', message: 'webhook rejected' });
    }

    expect((await h.record(record.id)).status).toBe('IN_PROGRESS');
    expect(await h.store.listAudit(record.id)).toHaveLength(before);
    expect(logs.lines.join('\n')).not.toContain(providerRef as string);
  });

  it('үл мэдэгдэх / бүртгэлгүй provider-ийн нэр → SigningNotFoundError', async () => {
    const h = await createHarness({ providers: ['TRIDUM'] });
    const request = signedRequest({ providerRef: 'x' });
    for (const code of ['nope', '', 'monpass', 'TRIDUM/../x']) {
      expect(await rejection(h.service.handleWebhook(code, request))).toMatchObject({ name: 'SigningNotFoundError' });
    }
  });

  it('баталгаажсан ч үл мэдэгдэх session → алдаагүй (2xx), аудит бичихгүй', async () => {
    const h = await createHarness();
    await expect(h.service.handleWebhook('tridum', signedRequest({ providerRef: 'TRD-MOCK-00000000-0000-0000-0000-000000000000' }))).resolves.toBeUndefined();
    expect(logs.lines.some((line) => line.includes('esign.webhook.unknown_session'))).toBe(true);
  });

  it('SIGNED болсон / цуцлагдсан хүсэлтэд дахин ирсэн webhook нь no-op (шинэ event, файл байхгүй)', async () => {
    const h = await createHarness();
    const done = await approved(h);
    const { providerRef } = await h.record(done.record.id);
    await h.service.handleWebhook('tridum', signedRequest({ providerRef }));
    await h.service.handleWebhook('tridum', signedRequest({ providerRef }));
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(1);

    const other = await h.create({ contractId: 'contract-2', applicationId: 'app-2' });
    await h.beginSigning(other.token, 'MONPASS');
    const otherRef = (await h.record(other.record.id)).providerRef as string;
    await h.service.cancel(other.record.id, CTX);
    await h.service.handleWebhook('monpass', signedRequest({ providerRef: otherRef }));
    expect((await h.record(other.record.id)).status).toBe('CANCELLED');
    expect(filesInDms(h)).toBe(3);
  });

  it('provider-ийн parseWebhook-ийн алдааны мессеж лог/алдаанд гарахгүй (кодыг л лог-д)', async () => {
    const h = await createHarness();
    const request = signedRequest({ providerRef: 'whatever' }, 'attacker-secret-attacker-secret');
    await rejection(h.service.handleWebhook('tridum', request));
    expect(logs.lines.some((line) => line.includes('esign.webhook.rejected') && line.includes('"errorCode":"INVALID_WEBHOOK"'))).toBe(true);
    expect(logs.lines.join('\n')).not.toContain('signature mismatch');
  });
});

describe('verify (QR хуудас)', () => {
  async function signedRequest() {
    const h = await createHarness();
    const created = await approved(h);
    await h.service.refresh(created.token, META);
    const record = await h.record(created.record.id);
    return { h, ...created, record, code: record.verificationCode as string };
  }

  it('SIGNED хүсэлтийн нийтийн мэдээлэл: DTO-д нийцнэ, регистр/утас/файлын id/бүтэн нэр байхгүй', async () => {
    const { h, record, code } = await signedRequest();

    const result = await h.service.verify(code);

    expect(SigningVerification.parse(result)).toEqual(result);
    expect(result).toEqual({
      valid: true, contractNo: CONTRACT_NO, signerNameMasked: 'Б. Болд', provider: 'TRIDUM', signedAt: record.signedAt?.toISOString(),
      originalSha256: record.originalSha256, signedSha256: record.signedSha256, certificateIssuer: 'LOS MOCK CA (ТЕСТ)',
      certificateSerial: record.certificate?.serialNumber, mock: true,
    });
    const text = JSON.stringify(result);
    for (const secret of [SIGNER_NAME, 'Бат-Эрдэнэ', DEFAULT_REGISTER, '12345633', SIGNER_PHONE, record.signedFileId, record.signatureFileId, record.id, record.sourceFileId]) {
      expect(text).not.toContain(secret as string);
    }
  });

  it('бүлэглэсэн, жижиг үсэг, зайтай хэлбэрийг ч хүлээн авна', async () => {
    const { h, code } = await signedRequest();
    const grouped = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
    for (const input of [grouped, grouped.toLowerCase(), ` ${grouped} `, code.toLowerCase()]) {
      await expect(h.service.verify(input)).resolves.toMatchObject({ valid: true });
    }
  });

  it('үл мэдэгдэх / хэлбэр буруу / SIGNED биш хүсэлтийн код → SigningNotFoundError', async () => {
    const h = await createHarness();
    await h.create();
    for (const code of ['', 'short', '0'.repeat(12), 'UUUUUUUUUUUU', 'A'.repeat(64), undefined as unknown as string]) {
      expect(await rejection(h.service.verify(code))).toMatchObject({ name: 'SigningNotFoundError' });
    }
  });

  it('SIGNED биш төлөвт (гарын үсгийн талбарууд үлдсэн ч) нийтийн verify хариу өгөхгүй', async () => {
    const { h, record, code } = await signedRequest();
    for (const status of ['FINALIZING', 'IN_PROGRESS', 'FAILED', 'CANCELLED', 'DECLINED', 'EXPIRED'] as const) {
      const spy = vi.spyOn(h.store, 'getByVerificationCode').mockResolvedValue({ ...record, status });
      expect(await rejection(h.service.verify(code))).toMatchObject({ name: 'SigningNotFoundError' });
      spy.mockRestore();
    }
  });

  it('гарын үсэгтэй файлын агуулга өөрчлөгдсөн бол valid=false (бусад мэдээлэл хэвээр)', async () => {
    const { h, record, code } = await signedRequest();
    for (const key of h.storage.keys()) {
      const bytes = await h.storage.get(key);
      if (sha256Hex(bytes) === record.signedSha256) await h.storage.put(key, Buffer.alloc(bytes.length, 0x41), 'application/pdf');
    }

    await expect(h.service.verify(code)).resolves.toMatchObject({ valid: false, contractNo: CONTRACT_NO, provider: 'TRIDUM' });
  });

  it('файлын сангийн дэд бүтцийн алдаа verify дээр valid=false гэж нуугдахгүй, шууд гарна', async () => {
    const { h, code } = await signedRequest();
    const outage = new Error('storage down');
    vi.spyOn(h.fileService, 'getContent').mockRejectedValue(outage);
    expect(await rejection(h.service.verify(code))).toBe(outage);
  });
});

describe('гарын үсэгтэй баримт татах', () => {
  it('зээлдэгч: SIGNED үед PDF-ийг татаж SIGNED_DOWNLOADED аудит (BORROWER, ip/ua) бичнэ', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    await h.service.refresh(token, META);
    const signed = await h.record(record.id);

    const doc = await h.service.getSignedDocumentForBorrower(token, META);

    expect(doc).toMatchObject({ fileName: `${CONTRACT_NO}-signed.pdf`, mime: 'application/pdf', sha256: signed.signedSha256 });
    expect(sha256Hex(doc.bytes)).toBe(signed.signedSha256);
    expect((await h.store.listAudit(record.id)).at(-1)).toMatchObject({ type: 'SIGNED_DOWNLOADED', actor: 'BORROWER', ip: META.ip, userAgent: META.userAgent });
  });

  it('SIGNED биш бол: идэвхтэй → INVALID_STATE, төгсгөлийн → Gone(TERMINAL)', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    expect(await rejection(h.service.getSignedDocumentForBorrower(token, META))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });
    await h.service.cancel(record.id, CTX);
    expect(await rejection(h.service.getSignedDocumentForBorrower(token, META))).toMatchObject({ name: 'SigningGoneError', reason: 'TERMINAL', status: 'CANCELLED' });
  });

  it('EXPIRED хүсэлтэд Gone(EXPIRED)', async () => {
    const h = await createHarness();
    const { token } = await h.create();
    h.clock.advanceHours(73);
    await h.service.getPublicSession(token, META);
    expect(await rejection(h.service.getSignedDocumentForBorrower(token, META))).toMatchObject({ name: 'SigningGoneError', reason: 'EXPIRED' });
  });

  it('линкийн хугацаа дууссан ч гарын үсэгтэй хувийг ESIGN_SIGNED_COPY_TTL_DAYS хүртэл токеноор татна; дараа нь зөвхөн ажилтан', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    await h.service.refresh(token, META);
    h.clock.advanceHours(73);

    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'SIGNED', signedDocumentAvailable: true, signedCopyExpiresAt: expect.any(String) });
    await expect(h.service.getSignedDocumentForBorrower(token, META)).resolves.toMatchObject({ mime: 'application/pdf' });

    h.clock.advanceHours(30 * 24);
    expect(await rejection(h.service.getSignedDocumentForBorrower(token, META))).toMatchObject({ name: 'SigningGoneError', reason: 'EXPIRED', status: 'SIGNED' });
    await expect(h.service.refresh(token, META)).resolves.toMatchObject({ status: 'SIGNED', signedDocumentAvailable: false });
    await expect(h.service.getSignedDocument(record.id)).resolves.toMatchObject({ mime: 'application/pdf' });
  });

  it('ажилтан: getSignedDocument / getSignature; ctx өгвөл хэн татсан нь аудитад; SIGNED биш бол INVALID_STATE', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    expect(await rejection(h.service.getSignedDocument(record.id))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });
    expect(await rejection(h.service.getSignature(record.id))).toMatchObject({ name: 'SigningConflictError', reason: 'INVALID_STATE' });
    await h.service.refresh(token, META);

    const pdf = await h.service.getSignedDocument(record.id, { actorId: 'officer-3', correlationId: 'c' });
    const p7s = await h.service.getSignature(record.id);

    expect(pdf.fileName).toBe(`${CONTRACT_NO}-signed.pdf`);
    expect(p7s).toMatchObject({ fileName: `${CONTRACT_NO}.p7s`, mime: 'application/pkcs7-signature' });
    expect(p7s.bytes.toString('utf8').startsWith('MOCK-CMS')).toBe(true);
    const downloads = (await h.store.listAudit(record.id)).filter((a) => a.type === 'SIGNED_DOWNLOADED');
    expect(downloads.map((a) => a.actor)).toEqual(['officer-3', 'SYSTEM']);
  });

  it('хадгалсан гарын үсэгтэй PDF өөрчлөгдсөн бол татахыг татгалзана (SIGNED_FILE_HASH_MISMATCH)', async () => {
    const h = await createHarness();
    const { record, token } = await approved(h);
    await h.service.refresh(token, META);
    const signed = await h.record(record.id);
    await h.store.transition(record.id, ['SIGNED'], { signedSha256: 'a'.repeat(64) });

    expect(await rejection(h.service.getSignedDocument(record.id))).toMatchObject({ name: 'SigningValidationError', reason: 'SIGNED_FILE_HASH_MISMATCH' });
    expect(await rejection(h.service.getSignedDocumentForBorrower(token, META))).toMatchObject({ name: 'SigningValidationError', reason: 'SIGNED_FILE_HASH_MISMATCH' });
    expect(logs.lines.some((line) => line.includes('esign.signed_file.tampered'))).toBe(true);
    expect(signed.signedSha256).not.toBe('a'.repeat(64));
  });
});

describe('PII — finalization-ий бүх гаралт', () => {
  it('амжилттай болон амжилтгүй урсгалд лог, event, audit, record-ын нийтлэг талбарт бүтэн нэр/регистр/утас/токен байхгүй', async () => {
    const h = await createHarness();
    const ok = await approved(h);
    await h.service.refresh(ok.token, META);
    const bad = await h.create({ contractId: 'contract-2', applicationId: 'app-2', signer: signer(registerEndingWith('77')) });
    await h.beginSigning(bad.token);
    h.clock.advanceSeconds(4);
    await h.service.refresh(bad.token, META);

    const serialized = JSON.stringify([
      h.store.events, await h.store.listAudit(ok.record.id), await h.store.listAudit(bad.record.id), h.service.toView(await h.record(ok.record.id)),
      h.service.toView(await h.record(bad.record.id)), await h.service.verify((await h.record(ok.record.id)).verificationCode as string),
    ]) + logs.lines.join('\n');

    for (const secret of [SIGNER_NAME, 'Бат-Эрдэнэ', DEFAULT_REGISTER, registerEndingWith('77'), '12345633', '12345677', SIGNER_PHONE, ok.token, bad.token]) {
      expect(serialized, `leaked: ${secret}`).not.toContain(secret);
    }
    expect(tokenOf(ok.signingUrl)).toBe(ok.token);
  });
});
