// FR-11.4 e2e: БОДИТ EsignModule HTTP-ээр — зээлдэгчийн бүтэн урсгал, provider бүр, webhook, татгалзах, хугацаа дуусах, давхар хүсэлт, линк шинэчлэх.
// memory persistence + storage, mock provider-ууд, удирдаж болох цаг. Хариу бүр PII-гүй эсэхийг transcript-ээр шалгана.
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerEndingWith, START_MS } from '../signing.test-harness';
import {
  applyE2eEnv, assertNoLeaks, CONTRACT_NO, OFFICER, providerRefFrom, PUBLIC_BASE_URL, signWebhook, SIGNER_NAME, SIGNER_PHONE, DEFAULT_REGISTER, tokenFrom,
  startE2e, type E2e,
} from './testing/e2e-app';
import { inspectPdf, pdftotext } from './testing/pdf-asserts';

const TIMEOUT = 60_000;
const GROUPED_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let restoreEnv: () => void;
let e2e: E2e;
beforeAll(() => {
  restoreEnv = applyE2eEnv();
});
afterAll(() => restoreEnv());
beforeEach(async () => {
  e2e = await startE2e();
});
afterEach(async () => {
  assertNoLeaks(e2e);
  await e2e.close();
});

const sign = (token: string, rest = ''): string => `/api/public/esign/${token}${rest}`;
const staff = (id: string, rest = ''): string => `/api/esign/requests/${id}${rest}`;

/** Зээлдэгч гэрээг үзээд зөвшөөрч provider сонгоно (PENDING → IN_PROGRESS) */
async function begin(token: string, provider: 'TRIDUM' | 'MONPASS' = 'TRIDUM') {
  expect((await e2e.getBinary(sign(token, '/document'))).status).toBe(200);
  return e2e.post(sign(token, '/start'), { provider, consent: true, consentVersion: 'v1' });
}

describe('Tridum: бүтэн урсгал (poll-оор дуусна)', () => {
  it('create → view → document → start → poll → SIGNED → татах → verify', { timeout: TIMEOUT }, async () => {
    // 1. Ажилтан хүсэлт үүсгэнэ
    const created = await e2e.createRequest();
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'PENDING', contractNo: CONTRACT_NO, signerNameMasked: 'Б. Болд', signerPhoneMasked: '+976 ****2233',
      provider: null, signedFileId: null, signatureFileId: null, verificationCode: null, failureReason: null,
    });
    expect(created.body.signingUrl).toMatch(new RegExp(`^${PUBLIC_BASE_URL}/sign/[A-Za-z0-9_-]{43}$`));
    expect(created.headers['cache-control']).toBe('no-store');
    const id: string = created.body.id;
    const token = tokenFrom(created.body.signingUrl);

    // 2. Зээлдэгч линкийг нээнэ
    const opened = await e2e.get(sign(token));
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      status: 'PENDING', contractNo: CONTRACT_NO, signerNameMasked: 'Б. Болд', documentViewed: false, signedDocumentAvailable: false, verificationCode: null,
      providers: [{ code: 'TRIDUM', displayName: 'Tridum', mock: true }, { code: 'MONPASS', displayName: 'Monpass', mock: true }],
    });
    expect(opened.headers['cache-control']).toBe('no-store');
    expect(opened.headers['x-content-type-options']).toBe('nosniff');

    // 3. Гэрээний PDF (inline stream) — "үзсэн" болно
    const document = await e2e.getBinary(sign(token, '/document'));
    expect(document.status).toBe(200);
    expect(document.headers['content-type']).toMatch(/^application\/pdf/);
    expect(document.headers['content-disposition']).toMatch(/^inline;/);
    expect(document.headers['cache-control']).toBe('no-store');
    expect(document.headers['x-content-type-options']).toBe('nosniff');
    expect(Number(document.headers['content-length'])).toBe(e2e.sourcePdf.length);
    expect(Buffer.compare(document.body, e2e.sourcePdf)).toBe(0);
    expect((await e2e.get(sign(token))).body.documentViewed).toBe(true);

    // 4. Зөвшөөрч Tridum сонгоно
    const started = await e2e.post(sign(token, '/start'), { provider: 'TRIDUM', consent: true, consentVersion: 'v1' });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: 'IN_PROGRESS', provider: 'TRIDUM', providers: [{ code: 'TRIDUM' }] });
    expect(started.body.challengeCode).toMatch(/^\d{4}$/);
    expect(started.body.deepLink).toMatch(/^mock-tridum:\/\/sign\/TRD-MOCK-/);
    expect(Date.parse(started.body.sessionExpiresAt)).toBe(START_MS + 300_000);

    // 5. Апп дээр баталгаажуулаагүй — poll IN_PROGRESS; хугацаа өнгөрмөгц SIGNED
    expect((await e2e.get(sign(token, '/status'))).body).toMatchObject({ status: 'IN_PROGRESS', signedDocumentAvailable: false });
    e2e.clock.advanceSeconds(3);
    const signed = await e2e.get(sign(token, '/status'));
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({
      status: 'SIGNED', provider: 'TRIDUM', challengeCode: null, deepLink: null, signedDocumentAvailable: true, signedAt: new Date(START_MS + 3000).toISOString(),
    });
    expect(signed.body.verificationCode).toMatch(GROUPED_CODE);
    const code: string = signed.body.verificationCode;

    // 6. Зээлдэгч гарын үсэгтэй PDF-ээ татна: эх хуудас + 1, QR, кирилл текст
    const download = await e2e.getBinary(sign(token, '/signed-document'));
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/pdf/);
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.headers['content-disposition']).toBe(`attachment; filename="___-2026-000123-signed.pdf"; filename*=UTF-8''%D0%93%D0%AD%D0%A0-2026-000123-signed.pdf`);
    const pdf: Buffer = download.body;
    expect(Number(download.headers['content-length'])).toBe(pdf.length);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    const source = await inspectPdf(e2e.sourcePdf);
    const facts = await inspectPdf(pdf);
    expect(facts.pageCount).toBe(source.pageCount + 1);
    expect(facts.qrMatchesOnEveryPage(`${PUBLIC_BASE_URL}/verify/${code.replaceAll('-', '')}`)).toBe(true);
    expect(facts.pageTexts.at(-1)).toEqual(expect.arrayContaining(['ЦАХИМ ГАРЫН ҮСГИЙН ХУУДАС']));
    expect(facts.pageTexts.flat().join(' ')).toContain(code);
    expect(facts.title).toBe(`${CONTRACT_NO} — гарын үсэгтэй`);
    expect(facts.keywords).toContain(sha256(e2e.sourcePdf));
    const text = pdftotext(pdf);
    if (text !== null) {
      expect(text).toContain('ЦАХИМ ГАРЫН ҮСГИЙН ХУУДАС');
      expect(text).toContain('Цахим гарын үсэг');
      expect(text).toContain(CONTRACT_NO);
      expect(text).toContain(code);
      expect(text).toContain('ТЕСТ');
      expect(text).toContain('Tridum');
      expect(text).toContain('УА****5633');
      expect(text).not.toContain(DEFAULT_REGISTER);
    }

    // 7. QR-ийн баталгаажуулалт (JWT-гүй): зураасгүй, зураастай, жижиг үсэгтэй
    const ungrouped = code.replaceAll('-', '');
    for (const form of [ungrouped, code, code.toLowerCase()]) {
      const verified = await e2e.get(`/api/public/esign/verify/${form}`);
      expect(verified.status).toBe(200);
      expect(verified.body).toEqual({
        valid: true, contractNo: CONTRACT_NO, signerNameMasked: 'Б. Болд', provider: 'TRIDUM', signedAt: new Date(START_MS + 3000).toISOString(),
        originalSha256: sha256(e2e.sourcePdf), signedSha256: sha256(pdf), certificateIssuer: 'LOS MOCK CA (ТЕСТ)', certificateSerial: expect.any(String), mock: true,
      });
      expect(verified.headers['cache-control']).toBe('no-store');
    }

    // 8. Ажилтны харагдац ба татаж авалт
    const view = await e2e.get(staff(id));
    expect(view.body).toMatchObject({ id, status: 'SIGNED', provider: 'TRIDUM', verificationCode: code, signedAt: new Date(START_MS + 3000).toISOString() });
    expect(view.body).not.toHaveProperty('signingUrl');
    const staffPdf = await e2e.getBinary(staff(id, '/signed-document'), OFFICER);
    expect(staffPdf.status).toBe(200);
    expect(staffPdf.headers['content-disposition']).toMatch(/^attachment;/);
    expect(Buffer.compare(staffPdf.body, pdf)).toBe(0);
    const signature = await e2e.getBinary(staff(id, '/signature'), OFFICER);
    expect(signature.status).toBe(200);
    expect(signature.headers['content-type']).toMatch(/^application\/pkcs7-signature/);
    expect(signature.headers['content-disposition']).toMatch(/^attachment; filename="[^"]+\.p7s"/);
    expect(facts.attachments).toEqual([{ name: 'signature.p7s', bytes: signature.body }]);
    expect(signature.body.toString('utf8')).toContain('MOCK-CMS');

    const listed = await e2e.get('/api/esign/requests?applicationId=app-1');
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ id, status: 'SIGNED' });
    expect(listed.body[0]).not.toHaveProperty('signingUrl');

    // 9. Outbox: ContractSigningRequested, ContractSigned (ЯГ нэг), correlationId дамжсан
    const events = await e2e.events();
    expect(events.map((event) => event.type)).toEqual(['ContractSigningRequested', 'ContractSigned']);
    expect(events[0]).toMatchObject({ signingRequestId: id, applicationId: 'app-1', contractId: 'contract-1', contractNo: CONTRACT_NO, actorId: 'officer-7', correlationId: 'corr-e2e-1' });
    expect(events[1]).toMatchObject({
      type: 'ContractSigned', signingRequestId: id, provider: 'TRIDUM', signedFileId: view.body.signedFileId, signatureFileId: view.body.signatureFileId,
      originalSha256: sha256(e2e.sourcePdf), signedSha256: sha256(pdf), verificationCode: ungrouped, correlationId: 'corr-e2e-1',
    });

  });
});

describe('Monpass: dev endpoint-оор шууд баталгаажуулна', () => {
  it('start → POST /dev/esign/mock/:ref/approve → status SIGNED (цаг хүлээхгүй)', { timeout: TIMEOUT }, async () => {
    const { id, token } = await e2e.issue();
    const started = await begin(token, 'MONPASS');
    expect(started.body).toMatchObject({ status: 'IN_PROGRESS', provider: 'MONPASS' });
    expect(started.body.deepLink).toMatch(/^mock-monpass:\/\/sign\/MPS-MOCK-/);

    const approved = await e2e.post(`/api/dev/esign/mock/${providerRefFrom(started.body.deepLink)}/approve`);
    expect(approved.status).toBe(200);
    const signed = await e2e.get(sign(token, '/status'));
    expect(signed.body).toMatchObject({ status: 'SIGNED', provider: 'MONPASS', signedDocumentAvailable: true });

    const verified = await e2e.get(`/api/public/esign/verify/${signed.body.verificationCode}`);
    expect(verified.body).toMatchObject({ valid: true, provider: 'MONPASS', mock: true });
    const pdf = await e2e.getBinary(staff(id, '/signed-document'), OFFICER);
    expect((await inspectPdf(pdf.body)).pageCount).toBe((await inspectPdf(e2e.sourcePdf)).pageCount + 1);
    const text = pdftotext(pdf.body);
    if (text !== null) expect(text).toContain('Monpass');
    expect((await e2e.events()).map((event) => event.type)).toEqual(['ContractSigningRequested', 'ContractSigned']);
  });

  it('start-аар сонгоогүй provider-ийн ref-ийг өөр хүсэлтэд ашиглах боломжгүй: үл мэдэгдэх ref → 404', async () => {
    expect((await e2e.post('/api/dev/esign/mock/TRD-MOCK-unknown/approve')).status).toBe(404);
  });
});

describe('Webhook-оор дуусна', () => {
  async function inProgress(provider: 'TRIDUM' | 'MONPASS' = 'TRIDUM') {
    const { id, token } = await e2e.issue();
    const started = await begin(token, provider);
    const providerRef = providerRefFrom(started.body.deepLink);
    return { id, token, providerRef, body: JSON.stringify({ providerRef }) };
  }
  const callback = (provider: string, body: string, headers: Record<string, string>) =>
    e2e.post(`/api/public/esign/callback/${provider}`, body, { 'content-type': 'application/json', ...headers });

  it('HMAC-тай webhook → 204; зээлдэгч poll хийлгүйгээр SIGNED; дахин илгээсэн webhook шинэ event үүсгэхгүй', { timeout: TIMEOUT }, async () => {
    const { id, token, body } = await inProgress();
    e2e.clock.advanceSeconds(3);

    const accepted = await callback('tridum', body, { 'x-mock-signature': signWebhook(body) });
    expect(accepted.status).toBe(204);
    expect(accepted.text).toBe('');
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect((await e2e.get(staff(id))).body).toMatchObject({ status: 'SIGNED', provider: 'TRIDUM' });

    expect((await callback('tridum', body, { 'x-mock-signature': signWebhook(body) })).status).toBe(204);
    expect((await e2e.get(sign(token, '/status'))).body.status).toBe('SIGNED');
    expect((await e2e.events()).filter((event) => event.type === 'ContractSigned')).toHaveLength(1);
    expect((await e2e.store.listAudit(id)).map((entry) => entry.type)).toEqual(expect.arrayContaining(['WEBHOOK_RECEIVED', 'SIGNED']));
  });

  it('webhook нь төлөвийг биеэс биш provider-оос асууж шийднэ: баталгаажаагүй session дээр webhook ирсэн ч IN_PROGRESS хэвээр', async () => {
    const { id, body } = await inProgress();
    expect((await callback('tridum', body, { 'x-mock-signature': signWebhook(body) })).status).toBe(204);
    expect((await e2e.get(staff(id))).body.status).toBe('IN_PROGRESS');
  });

  it('Monpass-ийн webhook (/callback/monpass)', async () => {
    const { id, body } = await inProgress('MONPASS');
    e2e.clock.advanceSeconds(3);
    expect((await callback('monpass', body, { 'x-mock-signature': signWebhook(body) })).status).toBe(204);
    expect((await e2e.get(staff(id))).body).toMatchObject({ status: 'SIGNED', provider: 'MONPASS' });
  });

  describe('татгалзах (401, дэлгэрэнгүйгүй)', () => {
    it.each([
      ['буруу HMAC', (body: string) => ({ 'x-mock-signature': signWebhook(body, 'another-secret-0123456789abcdef') })],
      ['гарын үсгийн толгой байхгүй', () => ({})],
      ['hex биш гарын үсэг', () => ({ 'x-mock-signature': 'not-a-signature' })],
    ])('%s', async (_name, headersFor) => {
      const { id, body } = await inProgress();
      e2e.clock.advanceSeconds(3);
      const rejected = await callback('tridum', body, headersFor(body));
      expect(rejected.status).toBe(401);
      expect(Object.keys(rejected.body).sort()).toEqual(['code', 'message']);
      expect(rejected.body.code).toBe('SIGNING_WEBHOOK_REJECTED');
      expect(rejected.text).not.toMatch(/signature|secret|mismatch|header/i);
      expect((await e2e.get(staff(id))).body.status).toBe('IN_PROGRESS');
    });

    it('бие нь өөрчлөгдсөн (гарын үсэг өөр байтад)', async () => {
      const { body, providerRef } = await inProgress();
      const tampered = JSON.stringify({ providerRef, extra: 1 });
      expect((await callback('tridum', tampered, { 'x-mock-signature': signWebhook(body) })).status).toBe(401);
    });

    it('JSON биш content-type (rawBody тогтоогдохгүй) → 401', async () => {
      const { body } = await inProgress();
      const res = await e2e.post('/api/public/esign/callback/tridum', body, { 'content-type': 'text/plain', 'x-mock-signature': signWebhook(body) });
      expect(res.status).toBe(401);
    });

    it('хоосон бие → 401', async () => {
      await inProgress();
      expect((await e2e.post('/api/public/esign/callback/tridum', undefined, { 'x-mock-signature': signWebhook('') })).status).toBe(401);
    });

    it('өөр provider-ийн ref-ийг /callback/tridum руу илгээвэл → 401', async () => {
      const { body } = await inProgress('MONPASS');
      expect((await callback('tridum', body, { 'x-mock-signature': signWebhook(body) })).status).toBe(401);
    });
  });

  it('үл мэдэгдэх (баталгаажсан) session → 204: хүчинтэй ref-ийг таах боломж өгөхгүй', async () => {
    const body = JSON.stringify({ providerRef: 'TRD-MOCK-00000000-0000-4000-8000-000000000000' });
    expect((await callback('tridum', body, { 'x-mock-signature': signWebhook(body) })).status).toBe(204);
  });

  it.each(['docusign', 'TRIDUM', 'Monpass', '..%2Ftridum', 'tridum%20'])('provider замын сегмент "%s" → 404', async (segment) => {
    const body = JSON.stringify({ providerRef: 'TRD-MOCK-x' });
    const res = await callback(segment, body, { 'x-mock-signature': signWebhook(body) });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SIGNING_NOT_FOUND');
  });
});

describe('татгалзах', () => {
  it('зээлдэгч утсан дээр татгалзана: POST decline → DECLINED, дараа нь бүх үйлдэл 410, ContractSigningFailed(DECLINED)', async () => {
    const { id, token } = await e2e.issue();
    await begin(token);

    const declined = await e2e.post(sign(token, '/decline'));
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ status: 'DECLINED', failureReason: 'DECLINED', signedDocumentAvailable: false, challengeCode: null, deepLink: null });
    expect((await e2e.post(sign(token, '/decline'))).body.status).toBe('DECLINED');

    for (const res of [await e2e.getBinary(sign(token, '/document')), await e2e.post(sign(token, '/start'), { provider: 'TRIDUM', consent: true, consentVersion: 'v1' }), await e2e.getBinary(sign(token, '/signed-document'))]) {
      expect(res.status).toBe(410);
    }
    expect((await e2e.get(staff(id))).body).toMatchObject({ status: 'DECLINED', failureReason: 'DECLINED' });
    expect((await e2e.events()).map((event) => event.type)).toEqual(['ContractSigningRequested', 'ContractSigningFailed']);
    expect((await e2e.events())[1]).toMatchObject({ reason: 'DECLINED', signingRequestId: id });
  });

  it('provider session нээгдээгүй (PENDING) үед татгалзах → 409', async () => {
    const { token } = await e2e.issue();
    const res = await e2e.post(sign(token, '/decline'));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SIGNING_CONFLICT', reason: 'INVALID_STATE' });
  });

  it('provider-ийн fixture `00`: апп дээр татгалзсан → poll DECLINED', async () => {
    const { token } = await e2e.issue({ signer: { customerId: 'cust-1', fullName: SIGNER_NAME, registerNo: registerEndingWith('00'), phone: SIGNER_PHONE } });
    await begin(token);
    e2e.clock.advanceSeconds(3);
    expect((await e2e.get(sign(token, '/status'))).body).toMatchObject({ status: 'DECLINED', failureReason: 'DECLINED' });
  });
});

describe('provider-ийн алдаа, шалгалтын амжилтгүй байдал', () => {
  it('fixture `77` (гэрчилгээний регистр зөрсөн): SIGNED биш, FAILED(IDENTITY_MISMATCH), PDF үүсэхгүй', async () => {
    const { id, token } = await e2e.issue({ signer: { customerId: 'cust-1', fullName: SIGNER_NAME, registerNo: registerEndingWith('77'), phone: SIGNER_PHONE } });
    await begin(token);
    e2e.clock.advanceSeconds(3);

    const status = await e2e.get(sign(token, '/status'));
    expect(status.body).toMatchObject({ status: 'FAILED', failureReason: 'IDENTITY_MISMATCH', signedDocumentAvailable: false, verificationCode: null });
    expect((await e2e.get(staff(id, '/signed-document'), OFFICER)).status).toBe(409);
    expect((await e2e.events()).map((event) => event.type)).toEqual(['ContractSigningRequested', 'ContractSigningFailed']);
    expect((await e2e.events())[1]).toMatchObject({ reason: 'IDENTITY_MISMATCH' });
  });

  it('fixture `55` (provider алдаа): линк хүчинтэй тул PENDING руу буцаж зээлдэгч дахин оролдож чадна', async () => {
    const { token } = await e2e.issue({ signer: { customerId: 'cust-1', fullName: SIGNER_NAME, registerNo: registerEndingWith('55'), phone: SIGNER_PHONE } });
    await begin(token);
    e2e.clock.advanceSeconds(3);

    const status = await e2e.get(sign(token, '/status'));
    expect(status.body).toMatchObject({ status: 'PENDING', provider: null, challengeCode: null });
    expect((await e2e.post(sign(token, '/start'), { provider: 'MONPASS', consent: true, consentVersion: 'v1' })).body).toMatchObject({ status: 'IN_PROGRESS', provider: 'MONPASS' });
  });
});

describe('хугацаа дуусах', () => {
  it('линкийн хугацаа дуусав: нээхэд EXPIRED харагдац (200), үйлдэл бүр 410, ContractSigningFailed(EXPIRED)', async () => {
    const { id, token } = await e2e.issue({ ttlHours: 1 });
    e2e.clock.advanceHours(1);

    const view = await e2e.get(sign(token));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: 'EXPIRED', failureReason: 'EXPIRED', providers: [], signedDocumentAvailable: false });
    const document = await e2e.getBinary(sign(token, '/document'));
    expect(document.status).toBe(410);
    expect(document.body).toMatchObject({ code: 'SIGNING_GONE', reason: 'EXPIRED' });
    expect((await e2e.post(sign(token, '/start'), { provider: 'TRIDUM', consent: true, consentVersion: 'v1' })).status).toBe(410);
    expect((await e2e.get(sign(token, '/status'))).body.status).toBe('EXPIRED');
    expect((await e2e.get(staff(id))).body).toMatchObject({ status: 'EXPIRED', failureReason: 'EXPIRED' });
    expect((await e2e.events()).map((event) => event.type)).toEqual(['ContractSigningRequested', 'ContractSigningFailed']);
    expect((await e2e.events())[1]).toMatchObject({ reason: 'EXPIRED' });
  });

  it('хугацаа дуусахаас өмнөх сүүлийн хормой хүртэл ажиллана', async () => {
    const { token } = await e2e.issue({ ttlHours: 1 });
    e2e.clock.advance(3_600_000 - 1);
    expect((await e2e.getBinary(sign(token, '/document'))).status).toBe(200);
  });

  it('sweeper: зээлдэгч нээгээгүй ч хугацаа дууссан хүсэлт EXPIRED болно', async () => {
    const { id } = await e2e.issue({ ttlHours: 1 });
    e2e.clock.advanceHours(2);
    await e2e.sweeper.tick();
    expect((await e2e.get(staff(id))).body).toMatchObject({ status: 'EXPIRED', failureReason: 'EXPIRED' });
  });

  it('provider session дууссан (хэзээ ч батлахгүй fixture `99`): EXPIRED биш — линк хүчинтэй тул дахин оролдох боломжтой', async () => {
    const { token } = await e2e.issue({ signer: { customerId: 'cust-1', fullName: SIGNER_NAME, registerNo: registerEndingWith('99'), phone: SIGNER_PHONE } });
    await begin(token);
    e2e.clock.advanceSeconds(300);
    expect((await e2e.get(sign(token, '/status'))).body).toMatchObject({ status: 'PENDING', provider: null });
  });
});

describe('давхар хүсэлт, шинэчлэл', () => {
  it('нэг гэрээнд хоёр дахь идэвхтэй хүсэлт → 409; supersedeActive → 201, хуучин CANCELLED, хуучин линк хаагдана', async () => {
    const first = await e2e.issue();

    const conflict = await e2e.createRequest();
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'SIGNING_CONFLICT', reason: 'ACTIVE_EXISTS' });

    e2e.clock.advanceSeconds(1); // түүх createdAt-аар эрэмбэлэгдэнэ — тогтмол цагтай бол хоёул ижил мөчид үүсч id-аар (санамсаргүй) эрэмбэлэгдэнэ
    const second = await e2e.createRequest({ supersedeActive: true });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.id);
    expect((await e2e.get(staff(first.id))).body).toMatchObject({ status: 'CANCELLED', failureReason: 'CANCELLED' });
    expect((await e2e.get(sign(first.token))).body.status).toBe('CANCELLED');
    expect((await e2e.getBinary(sign(first.token, '/document'))).status).toBe(410);
    expect((await e2e.get(sign(tokenFrom(second.body.signingUrl)))).body.status).toBe('PENDING');

    const history = await e2e.get('/api/esign/requests?applicationId=app-1');
    expect(history.body.map((view: { status: string }) => view.status)).toEqual(['PENDING', 'CANCELLED']);
    expect((await e2e.events()).map((event) => event.type)).toEqual(['ContractSigningRequested', 'ContractSigningFailed', 'ContractSigningRequested']);
  });

  it('төгсгөлийн төлөвт хүсэлт дахин үүсгэж болно (түүх хадгалагдана)', async () => {
    const { id, token } = await e2e.issue();
    await begin(token);
    await e2e.post(sign(token, '/decline'));
    const again = await e2e.createRequest();
    expect(again.status).toBe(201);
    expect((await e2e.get(staff(id))).body.status).toBe('DECLINED');
  });

  it('resend: шинэ линк, хуучин токен тэр даруй 404, шинэ токен ажиллана', async () => {
    const { id, token: oldToken } = await e2e.issue();

    const resent = await e2e.post(staff(id, '/resend'), undefined, OFFICER);
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ id, status: 'PENDING' });
    const newToken = tokenFrom(resent.body.signingUrl);
    expect(newToken).not.toBe(oldToken);

    for (const rest of ['', '/document', '/status', '/signed-document']) expect((await e2e.get(sign(oldToken, rest))).status).toBe(404);
    expect((await e2e.post(sign(oldToken, '/start'), { provider: 'TRIDUM', consent: true, consentVersion: 'v1' })).status).toBe(404);
    expect((await e2e.get(sign(newToken))).status).toBe(200);
    expect((await e2e.getBinary(sign(newToken, '/document'))).status).toBe(200);
  });

  it('resend: төгсгөлийн төлөвт 409', async () => {
    const { id } = await e2e.issue();
    expect((await e2e.post(staff(id, '/cancel'))).status).toBe(200);
    const res = await e2e.post(staff(id, '/resend'));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SIGNING_CONFLICT', reason: 'INVALID_STATE' });
  });

  it('cancel: CANCELLED болж линк хаагдана; дахин cancel хийхэд өөрчлөлтгүй 200', async () => {
    const { id, token } = await e2e.issue();
    const cancelled = await e2e.post(staff(id, '/cancel'), undefined, OFFICER);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', failureReason: 'CANCELLED' });
    expect((await e2e.post(staff(id, '/cancel'))).body.status).toBe('CANCELLED');
    expect((await e2e.getBinary(sign(token, '/document'))).status).toBe(410);
    expect((await e2e.events()).filter((event) => event.type === 'ContractSigningFailed')).toHaveLength(1);
  });
});

describe('ажилтны татаж авалт', () => {
  it('SIGNED болоогүй үед signed-document / signature → 409', async () => {
    const { id } = await e2e.issue();
    for (const rest of ['/signed-document', '/signature']) {
      const res = await e2e.get(staff(id, rest), OFFICER);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SIGNING_CONFLICT', reason: 'INVALID_STATE' });
    }
  });

  it('татсан нь audit-д хэн татсаныг бичнэ', { timeout: TIMEOUT }, async () => {
    const { id, token } = await e2e.issue();
    const started = await begin(token);
    await e2e.post(`/api/dev/esign/mock/${providerRefFrom(started.body.deepLink)}/approve`);
    await e2e.get(sign(token, '/status'));

    expect((await e2e.getBinary(staff(id, '/signed-document'), OFFICER)).status).toBe(200);
    expect((await e2e.getBinary(sign(token, '/signed-document'))).status).toBe(200);
    const downloads = (await e2e.store.listAudit(id)).filter((entry) => entry.type === 'SIGNED_DOWNLOADED');
    expect(downloads.map((entry) => entry.actor)).toEqual(['officer-7', 'BORROWER']);
  });

  it('үл мэдэгдэх id → 404; uuid биш id → 404 (DB руу очихгүй)', async () => {
    for (const id of ['2f8c1c0e-1b57-4d0e-9a53-2a0c4b9b6a11', 'not-a-uuid', '1']) {
      for (const [method, rest] of [['get', ''], ['get', '/signed-document'], ['get', '/signature'], ['post', '/resend'], ['post', '/cancel']] as const) {
        const res = method === 'get' ? await e2e.get(staff(id, rest)) : await e2e.post(staff(id, rest));
        expect(res.status, `${method} ${rest} ${id}`).toBe(404);
        expect(res.body).toMatchObject({ code: 'SIGNING_NOT_FOUND' });
      }
    }
  });

  it('PDF биш / байхгүй эх файл → 400', async () => {
    const missing = await e2e.createRequest({ sourceFileId: '2f8c1c0e-1b57-4d0e-9a53-2a0c4b9b6a11' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'SIGNING_VALIDATION', reason: 'SOURCE_FILE_NOT_FOUND' });
  });
});
