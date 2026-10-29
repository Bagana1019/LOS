// FR-11.4 e2e (HTTP хамгаалалт): параметр/биеийн шалгалт, алдааны хөрвүүлэлт, PII-гүй хариу, холболтын мета, кэшгүй толгой.
// Бүтэн урсгалууд нь esign.e2e.test.ts-д.
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESignProviderError } from '../../../integrations/esign/esign-provider.port';
import { MockRemoteSigner } from '../../../integrations/esign/mock-remote-signer';
import { PdfLibStamper } from '../pdf/pdf-lib-stamper';
import { SigningService } from '../signing.service';
import {
  applyE2eEnv, assertNoLeaks, DEFAULT_REGISTER, E2E_ORG, OFFICER, providerRefFrom, signWebhook, SIGNER_NAME, SIGNER_PHONE, startE2e, type E2e,
} from './testing/e2e-app';

const TIMEOUT = 60_000;
const UNKNOWN_TOKEN = randomBytes(32).toString('base64url');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  vi.restoreAllMocks();
  assertNoLeaks(e2e);
  await e2e.close();
});

const sign = (token: string, rest = ''): string => `/api/public/esign/${token}${rest}`;
const staff = (id: string, rest = ''): string => `/api/esign/requests/${id}${rest}`;
const START_BODY = { provider: 'TRIDUM', consent: true, consentVersion: 'v1' };

async function begin(token: string, provider: 'TRIDUM' | 'MONPASS' = 'TRIDUM') {
  expect((await e2e.getBinary(sign(token, '/document'))).status).toBe(200);
  return e2e.post(sign(token, '/start'), { provider, consent: true, consentVersion: 'v1' });
}

describe('public: path параметрийн хэлбэр (service-д хүрэхээс өмнө 404)', () => {
  const MALFORMED_TOKENS = ['short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}+`, `${'a'.repeat(42)}.`, `${'a'.repeat(42)}%20`, '%00'.repeat(5), 'verify', 'null'];
  const TOKEN_ROUTES = [
    ['GET', ''], ['GET', '/document'], ['POST', '/start'], ['GET', '/status'], ['POST', '/decline'], ['GET', '/signed-document'],
  ] as const;

  it.each(MALFORMED_TOKENS)('буруу хэлбэрийн токен "%s": бүх route 404, service дуудагдахгүй', async (token) => {
    const spies = (['getPublicSession', 'getDocumentForReview', 'start', 'refresh', 'decline', 'getSignedDocumentForBorrower'] as const).map((method) =>
      vi.spyOn(SigningService.prototype, method),
    );
    for (const [method, rest] of TOKEN_ROUTES) {
      const res = method === 'GET' ? await e2e.get(sign(token, rest)) : await e2e.post(sign(token, rest), START_BODY);
      expect(res.status, `${method} ${rest}`).toBe(404);
      expect(res.body.code).toBe('SIGNING_NOT_FOUND');
    }
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it('үл мэдэгдэх ба шинэчлэгдсэн (хуучин) токен — бие нь яг ижил: хүчинтэй байсан эсэхийг илтгэхгүй', async () => {
    const { id, token: oldToken } = await e2e.issue();
    await e2e.post(staff(id, '/resend'));
    const unknown = await e2e.get(sign(UNKNOWN_TOKEN));
    const rotated = await e2e.get(sign(oldToken));
    expect(unknown.status).toBe(404);
    expect(rotated.status).toBe(404);
    expect(rotated.text).toBe(unknown.text);
  });

  it.each(['abc', 'UUUUUUUUUUUU', '0'.repeat(13), '0'.repeat(11), '..%2F..%2Fetc', '0000-0000-0000-0000', '%20'])('verify/%s → 404, service дуудагдахгүй', async (code) => {
    const spy = vi.spyOn(SigningService.prototype, 'verify');
    const res = await e2e.get(`/api/public/esign/verify/${code}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SIGNING_NOT_FOUND');
    expect(spy).not.toHaveBeenCalled();
  });

  it('хэлбэр зөв боловч байхгүй код, мөн SIGNED биш хүсэлтийн код → 404', async () => {
    await e2e.issue();
    expect((await e2e.get('/api/public/esign/verify/0123-4567-89AB')).status).toBe(404);
  });

  it('verify нь `:token` route-оос өмнө: /verify/<код> хэзээ ч токен гэж таарахгүй', async () => {
    const spy = vi.spyOn(SigningService.prototype, 'getPublicSession');
    await e2e.get('/api/public/esign/verify/0123-4567-89AB');
    expect(spy).not.toHaveBeenCalled();
  });

  it('танигдаагүй замууд → 404 NOT_FOUND (сервисийн нэгдсэн хариу; gateway энэ замд өөрийн 404-ийг тавина)', async () => {
    const secretPath = `/api/public/esign/${UNKNOWN_TOKEN}/nope/extra`;
    for (const res of [await e2e.get(secretPath), await e2e.post(`/api/public/esign/verify/0123-4567-89AB`, {}), await e2e.get(`/api/public/esign/${UNKNOWN_TOKEN}/decline`)]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
  });
});

describe('public: start-ын бие ба дараалал', () => {
  it('татгалзсан: гэрээг үзэхээс өмнө start → 400 DOCUMENT_NOT_VIEWED', async () => {
    const { token } = await e2e.issue();
    const res = await e2e.post(sign(token, '/start'), START_BODY);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'SIGNING_VALIDATION', reason: 'DOCUMENT_NOT_VIEWED', message: expect.any(String) });
    expect((await e2e.get(sign(token))).body.status).toBe('PENDING');
  });

  it('үл мэдэгдэх provider → 400, утгыг буцаан харуулахгүй', async () => {
    const { token } = await e2e.issue();
    await e2e.getBinary(sign(token, '/document'));
    const res = await e2e.post(sign(token, '/start'), { provider: 'DOCUSIGN', consent: true, consentVersion: 'v1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'REQUEST_INVALID', message: expect.any(String), issues: [{ path: 'provider', code: 'invalid_enum_value' }] });
    expect(res.text).not.toContain('DOCUSIGN');
  });

  it.each([
    ['consent: false', { provider: 'TRIDUM', consent: false }, 'consent'],
    ['consent байхгүй', { provider: 'TRIDUM' }, 'consent'],
    ['consent текст', { provider: 'TRIDUM', consent: 'true' }, 'consent'],
    ['provider байхгүй', { consent: true, consentVersion: 'v1' }, 'provider'],
    ['provider жижиг үсэг', { provider: 'tridum', consent: true, consentVersion: 'v1' }, 'provider'],
    ['хоосон обьект', {}, 'provider'],
  ])('%s → 400', async (_name, body, path) => {
    const { token } = await e2e.issue();
    await e2e.getBinary(sign(token, '/document'));
    const res = await e2e.post(sign(token, '/start'), body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUEST_INVALID');
    expect(res.body.issues.map((issue: { path: string }) => issue.path)).toContain(path);
  });

  it('биегүй start → 400', async () => {
    const { token } = await e2e.issue();
    await e2e.getBinary(sign(token, '/document'));
    expect((await e2e.post(sign(token, '/start'))).status).toBe(400);
  });

  it('буруу JSON → 400 ерөнхий хариу, биеийн хэсгийг (регистр г.м) эргүүлж харуулахгүй', async () => {
    const { token } = await e2e.issue();
    const res = await e2e.post(sign(token, '/start'), `{"provider":"TRIDUM","consent":true,"registerNo":"${DEFAULT_REGISTER}`, { 'content-type': 'application/json' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', message: expect.any(String) });
    expect(res.text).not.toContain(DEFAULT_REGISTER);
  });

  it('хэт том бие → 413 ерөнхий хариу', async () => {
    const { token } = await e2e.issue();
    const res = await e2e.post(sign(token, '/start'), JSON.stringify({ provider: 'TRIDUM', consent: true, padding: 'x'.repeat(200_000) }), { 'content-type': 'application/json' });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) });
  });

  it('start хоёр удаа → 409; SIGNED болсны дараа start → 410', { timeout: TIMEOUT }, async () => {
    const { token } = await e2e.issue();
    const started = await begin(token);
    const again = await e2e.post(sign(token, '/start'), START_BODY);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'SIGNING_CONFLICT', reason: 'INVALID_STATE' });

    await e2e.post(`/api/dev/esign/mock/${providerRefFrom(started.body.deepLink)}/approve`);
    expect((await e2e.get(sign(token, '/status'))).body.status).toBe('SIGNED');
    const afterSigned = await e2e.post(sign(token, '/start'), START_BODY);
    expect(afterSigned.status).toBe(410);
    expect(afterSigned.body).toMatchObject({ code: 'SIGNING_GONE', reason: 'TERMINAL' });
    expect((await e2e.getBinary(sign(token, '/document'))).status).toBe(410);
  });

  it('preferredProvider: зөвхөн тэр provider санал болгогдож, өөрийг сонговол 400', async () => {
    const { token } = await e2e.issue({ preferredProvider: 'MONPASS' });
    expect((await e2e.get(sign(token))).body.providers).toEqual([{ code: 'MONPASS', displayName: 'Monpass', mock: true }]);
    await e2e.getBinary(sign(token, '/document'));
    const res = await e2e.post(sign(token, '/start'), START_BODY);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'SIGNING_VALIDATION', reason: 'PROVIDER_NOT_ALLOWED' });
    expect((await e2e.post(sign(token, '/start'), { provider: 'MONPASS', consent: true, consentVersion: 'v1' })).status).toBe(200);
  });

  it('гарын үсэг зурагдсан ч линкийн хугацаа дууссан бол зээлдэгч ESIGN_SIGNED_COPY_TTL_DAYS хүртэл татна; дараа нь 410, ажилтан татна', { timeout: TIMEOUT }, async () => {
    const { id, token } = await e2e.issue({ ttlHours: 1 });
    const started = await begin(token);
    await e2e.post(`/api/dev/esign/mock/${providerRefFrom(started.body.deepLink)}/approve`);
    expect((await e2e.get(sign(token, '/status'))).body.status).toBe('SIGNED');
    e2e.clock.advanceHours(1);

    expect((await e2e.getBinary(sign(token, '/signed-document'))).status).toBe(200);
    expect((await e2e.get(sign(token))).body).toMatchObject({ status: 'SIGNED', signedDocumentAvailable: true, signedCopyExpiresAt: expect.any(String) });
    e2e.clock.advanceHours(30 * 24);
    expect((await e2e.getBinary(sign(token, '/signed-document'))).status).toBe(410);
    expect((await e2e.get(sign(token))).body).toMatchObject({ status: 'SIGNED', signedDocumentAvailable: false });
    expect((await e2e.getBinary(staff(id, '/signed-document'), OFFICER)).status).toBe(200);
  });
});

describe('ажилтны create/list: толгой ба бие', () => {
  it('correlationId: толгойнхыг event-д, байхгүй/буруу бол шинэ uuid', async () => {
    await e2e.createRequest({}, { ...OFFICER, 'x-correlation-id': 'corr.ok-1_2' });
    const { 'x-correlation-id': _omitted, ...withoutCorrelation } = OFFICER;
    await e2e.createRequest({ contractId: 'contract-2' }, withoutCorrelation);
    await e2e.createRequest({ contractId: 'contract-3' }, { ...OFFICER, 'x-correlation-id': 'bad id!' });
    const [first, second, third] = await e2e.events();
    expect(first.correlationId).toBe('corr.ok-1_2');
    expect(second.correlationId).toMatch(UUID);
    expect(third.correlationId).toMatch(UUID);
    expect(third.correlationId).not.toBe('bad id!');
  });

  it('gateway-ийн итгэмжлэгдсэн контекст: actorId = X-User-Id, org = X-Org-Id; хүсэлтийн биеийн orgId үл тооцогдоно', async () => {
    const res = await e2e.createRequest({ orgId: 'someone-else' } as never);
    expect(res.status).toBe(201);
    expect(res.body.orgId).toBe(E2E_ORG);
    expect((await e2e.events())[0]).toMatchObject({ type: 'ContractSigningRequested', actorId: 'officer-7', orgId: E2E_ORG });
    expect((await e2e.store.listAudit(res.body.id))[0]).toMatchObject({ type: 'CREATED', actor: 'officer-7' });
  });

  it('нэвтрээгүй (X-User-Id байхгүй) → 401; X-Org-Id байхгүй → 401; эрхгүй дүр → 403; хүсэлт үүсэхгүй', async () => {
    const { 'x-user-id': _u, ...noUser } = OFFICER;
    const { 'x-org-id': _o, ...noOrg } = OFFICER;
    expect((await e2e.createRequest({}, noUser)).status).toBe(401);
    expect((await e2e.createRequest({}, noOrg)).status).toBe(401);
    expect((await e2e.createRequest({}, { ...OFFICER, 'x-roles': 'ADMIN' })).status).toBe(403);
    expect((await e2e.createRequest({}, { ...OFFICER, 'x-roles': '' })).status).toBe(403);
    expect(await e2e.events()).toHaveLength(0);
  });

  it('өөр байгууллагын ажилтан хүсэлтийг харахгүй, цуцлахгүй, татахгүй (404); жагсаалтад орохгүй', async () => {
    const { id } = await e2e.issue();
    const other = { ...OFFICER, 'x-org-id': 'another-org' };
    expect((await e2e.get(`/api/esign/requests/${id}`, other)).status).toBe(404);
    expect((await e2e.post(`/api/esign/requests/${id}/cancel`, {}, other)).status).toBe(404);
    expect((await e2e.post(`/api/esign/requests/${id}/resend`, {}, other)).status).toBe(404);
    expect((await e2e.get('/api/esign/requests?applicationId=app-1', other)).body).toEqual([]);
    // өөр байгууллагын файлыг эх гэрээ болгож болохгүй
    expect((await e2e.createRequest({ contractId: 'contract-x' }, other)).body).toMatchObject({ code: 'SIGNING_VALIDATION', reason: 'SOURCE_FILE_NOT_FOUND' });
    expect((await e2e.get(`/api/esign/requests/${id}`)).status).toBe(200);
  });

  it('буруу бие → 400, issues зөвхөн зам+төрөл; илгээсэн регистр/утас/нэр хариунд ЭРГЭХГҮЙ', async () => {
    const res = await e2e.createRequest({ signer: { customerId: 'cust-1', fullName: SIGNER_NAME, registerNo: DEFAULT_REGISTER, phone: 'ABC-not-a-phone' }, ttlHours: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUEST_INVALID');
    expect(res.body.issues).toEqual(expect.arrayContaining([{ path: 'signer.phone', code: 'invalid_string' }, { path: 'ttlHours', code: 'too_small' }]));
    for (const secret of [DEFAULT_REGISTER, 'ABC-not-a-phone', SIGNER_NAME]) expect(res.text).not.toContain(secret);
    expect(await e2e.events()).toHaveLength(0);
  });

  it('ttlHours дээд хязгаар 168; бутархай/тэмдэгт татгалзана', async () => {
    expect((await e2e.createRequest({ ttlHours: 169 })).status).toBe(400);
    expect((await e2e.createRequest({ ttlHours: 1.5 })).status).toBe(400);
    expect((await e2e.createRequest({ ttlHours: '24' as unknown as number })).status).toBe(400);
    const ok = await e2e.createRequest({ ttlHours: 168 });
    expect(ok.status).toBe(201);
    expect(Date.parse(ok.body.linkExpiresAt) - e2e.clock.now().getTime()).toBe(168 * 3_600_000);
  });

  it('регистр нормчлогдоно: латин look-alike/зайтай ч ижил регистр гэж хадгалагдаж, хариунд далдлагдсан', async () => {
    const res = await e2e.createRequest({ signer: { customerId: 'cust-1', fullName: SIGNER_NAME, registerNo: 'ya 12345633', phone: SIGNER_PHONE } });
    expect(res.status).toBe(201);
    expect(res.text).not.toContain('12345633');
  });

  it('list: applicationId заавал — байхгүй/хоосон/давхар бол 400; өөр хүсэлтийн түүх орохгүй', async () => {
    await e2e.issue();
    await e2e.issue({ applicationId: 'app-2', contractId: 'contract-2' });
    for (const query of ['', '?applicationId=', '?applicationId=a&applicationId=b', `?applicationId=${'x'.repeat(129)}`]) {
      const res = await e2e.get(`/api/esign/requests${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.code).toBe('REQUEST_INVALID');
    }
    const only = await e2e.get('/api/esign/requests?applicationId=app-2');
    expect(only.body).toHaveLength(1);
    expect(only.body[0]).toMatchObject({ applicationId: 'app-2' });
    expect((await e2e.get('/api/esign/requests?applicationId=none')).body).toEqual([]);
  });
});

describe('алдааны хөрвүүлэлт', () => {
  it('танигдаагүй алдаа → 500 ерөнхий хариу; лог-д зөвхөн нэр/route, мессеж/PII/токен ороогүй', async () => {
    const { token } = await e2e.issue();
    vi.spyOn(SigningService.prototype, 'getPublicSession').mockRejectedValueOnce(new Error(`boom ${DEFAULT_REGISTER} ${SIGNER_PHONE} ${token}`));

    const res = await e2e.get(sign(token), { 'x-correlation-id': 'corr-500' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', message: expect.any(String) });
    expect(res.headers['cache-control']).toBe('no-store');
    const line = e2e.logs.lines.find((entry) => entry.includes('esign.http.unhandled'));
    expect(JSON.parse(line ?? '{}')).toEqual({ event: 'esign.http.unhandled', errorName: 'Error', method: 'GET', route: '/api/public/esign/:token', correlationId: 'corr-500' });
    const everything = [res.text, ...e2e.logs.lines].join('\n');
    for (const secret of ['boom', DEFAULT_REGISTER, SIGNER_PHONE, token]) expect(everything).not.toContain(secret);
  });

  it('DB-ийн алдаа (код нь мэдэгдэх) → 500, лог-д зөвхөн код', async () => {
    const { token } = await e2e.issue();
    const dbError = Object.assign(new Error('Failing row contains (УА12345633)'), { name: 'DbOperationError', code: 'P2002' });
    vi.spyOn(SigningService.prototype, 'getPublicSession').mockRejectedValueOnce(dbError);

    expect((await e2e.get(sign(token))).status).toBe(500);
    const line = e2e.logs.lines.find((entry) => entry.includes('esign.http.unhandled'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({ errorName: 'DbOperationError', errorCode: 'P2002' });
    expect(e2e.logs.lines.join('\n')).not.toContain('УА12345633');
  });

  it('provider боломжгүй → 502, provider-ийн дэлгэрэнгүй гарахгүй', async () => {
    const { token } = await e2e.issue();
    await e2e.getBinary(sign(token, '/document'));
    vi.spyOn(MockRemoteSigner.prototype, 'createSession').mockRejectedValueOnce(new ESignProviderError('UNAVAILABLE', 'upstream detail https://internal.tridum.example/api', true));

    const res = await e2e.post(sign(token, '/start'), START_BODY);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ code: 'SIGNING_PROVIDER_UNAVAILABLE', message: expect.any(String) });
    expect(res.text).not.toContain('internal.tridum');
    expect(e2e.logs.lines.join('\n')).not.toContain('internal.tridum');
    // Түр алдаа: PENDING хэвээр, дахин оролдоход амжилттай
    expect((await e2e.post(sign(token, '/start'), START_BODY)).status).toBe(200);
  });

  it('finalization-ий түр алдаа → 503 + Retry-After; хүсэлт IN_PROGRESS хэвээр, дараагийн poll SIGNED болгоно', { timeout: TIMEOUT }, async () => {
    const { id, token } = await e2e.issue();
    const started = await begin(token);
    await e2e.post(`/api/dev/esign/mock/${providerRefFrom(started.body.deepLink)}/approve`);
    vi.spyOn(PdfLibStamper.prototype, 'stamp').mockRejectedValueOnce(new Error('disk full'));

    const failed = await e2e.get(sign(token, '/status'));
    expect(failed.status).toBe(503);
    expect(failed.headers['retry-after']).toBe('5');
    expect(failed.body.code).toBe('SIGNING_FINALIZATION_FAILED');
    expect(failed.text).not.toContain('disk full');
    expect((await e2e.get(staff(id))).body.status).toBe('IN_PROGRESS');

    expect((await e2e.get(sign(token, '/status'))).body.status).toBe('SIGNED');
    expect((await e2e.events()).filter((event) => event.type === 'ContractSigned')).toHaveLength(1);
  });

  it('webhook дээр finalization-ий түр алдаа → 5xx (provider дахин илгээнэ)', { timeout: TIMEOUT }, async () => {
    const { id, token } = await e2e.issue();
    const started = await begin(token);
    const providerRef = providerRefFrom(started.body.deepLink);
    await e2e.post(`/api/dev/esign/mock/${providerRef}/approve`);
    vi.spyOn(PdfLibStamper.prototype, 'stamp').mockRejectedValueOnce(new Error('disk full'));
    const body = JSON.stringify({ providerRef });
    const headers = { 'content-type': 'application/json', 'x-mock-signature': signWebhook(body) };

    expect((await e2e.post('/api/public/esign/callback/tridum', body, headers)).status).toBe(503);
    expect((await e2e.post('/api/public/esign/callback/tridum', body, headers)).status).toBe(204);
    expect((await e2e.get(staff(id))).body.status).toBe('SIGNED');
  });
});

describe('кэшгүй толгой', () => {
  it('public хариу бүрд (амжилт, 4xx, 5xx, 204) Cache-Control: no-store + nosniff', { timeout: TIMEOUT }, async () => {
    const { id, token } = await e2e.issue();
    const started = await begin(token);
    const providerRef = providerRefFrom(started.body.deepLink);
    const webhookBody = JSON.stringify({ providerRef });
    const replies = [
      await e2e.get(sign(token)),
      await e2e.getBinary(sign(token, '/document')),
      await e2e.get(sign(token, '/status')),
      await e2e.get(sign(UNKNOWN_TOKEN)),
      await e2e.get(sign('malformed')),
      await e2e.get('/api/public/esign/verify/0123-4567-89AB'),
      await e2e.get('/api/public/esign/verify/zzz'),
      await e2e.post(sign(token, '/start'), START_BODY),
      await e2e.post(sign(token, '/start'), {}),
      await e2e.post(sign(token, '/decline')),
      await e2e.get(sign(token, '/nope/nope')),
      await e2e.post('/api/public/esign/callback/tridum', webhookBody, { 'content-type': 'application/json', 'x-mock-signature': 'bad' }),
      await e2e.post('/api/public/esign/callback/tridum', webhookBody, { 'content-type': 'application/json', 'x-mock-signature': signWebhook(webhookBody) }),
      await e2e.getBinary(sign(token, '/signed-document')),
      await e2e.get(staff(id)),
      await e2e.post(staff(id, '/resend')),
    ];
    expect(new Set(replies.map((reply) => reply.status))).toEqual(new Set([200, 204, 400, 401, 404, 410, 409]));
    for (const reply of replies) {
      expect(reply.headers['cache-control'], `${reply.status}`).toBe('no-store');
      expect(reply.headers['x-content-type-options'], `${reply.status}`).toBe('nosniff');
    }
  });
});

describe('холболтын мета (audit)', () => {
  const auditOf = async (id: string, type: string) => (await e2e.store.listAudit(id)).filter((entry) => entry.type === type);

  it('X-Forwarded-For-ийн ЭХНИЙ hop, User-Agent 255-д таслагдаж audit-д бичигдэнэ', async () => {
    const { id, token } = await e2e.issue();
    await e2e.get(sign(token), { 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2', 'user-agent': `Mozilla/5.0 ${'x'.repeat(400)}` });
    const [opened] = await auditOf(id, 'OPENED');
    expect(opened.ip).toBe('203.0.113.9');
    expect(opened.userAgent).toHaveLength(255);
    expect(opened.userAgent?.startsWith('Mozilla/5.0 xxx')).toBe(true);
    expect(opened.actor).toBe('BORROWER');
  });

  it('IPv6 каноник болно; IPv4-mapped IPv6 → IPv4', async () => {
    const { id, token } = await e2e.issue();
    await e2e.get(sign(token), { 'x-forwarded-for': '2001:DB8::1' });
    expect((await auditOf(id, 'OPENED'))[0].ip).toBe('2001:db8::1');

    const second = await e2e.issue({ contractId: 'contract-2' });
    await e2e.get(sign(second.token), { 'x-forwarded-for': '::ffff:198.51.100.4' });
    expect((await auditOf(second.id, 'OPENED'))[0].ip).toBe('198.51.100.4');
  });

  it.each(['garbage', 'unknown', '999.1.1.1', ', 203.0.113.9', "1.2.3.4'; DROP TABLE"])('X-Forwarded-For "%s" IP биш → сокетын хаяг', async (forwarded) => {
    const { id, token } = await e2e.issue();
    await e2e.get(sign(token), { 'x-forwarded-for': forwarded });
    const [opened] = await auditOf(id, 'OPENED');
    expect(opened.ip).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it('толгойгүй бол сокетын хаяг, User-Agent байхгүй бол null; document үзсэнийг мөн бичнэ', async () => {
    const { id, token } = await e2e.issue();
    await e2e.getBinary(sign(token, '/document'), { 'user-agent': '' });
    const [viewed] = await auditOf(id, 'DOCUMENT_VIEWED');
    expect(viewed.ip).toMatch(/^(127\.0\.0\.1|::1)$/);
    expect(viewed.userAgent).toBeNull();
  });

  it('consent ба provider session эхэлсэнийг зээлдэгчийн IP-тэй бичнэ; IP/UA лог-д орохгүй', async () => {
    const { id, token } = await e2e.issue();
    await e2e.getBinary(sign(token, '/document'), { 'x-forwarded-for': '203.0.113.9' });
    await e2e.post(sign(token, '/start'), START_BODY, { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'TestBrowser/1.0' });
    expect((await auditOf(id, 'CONSENT_GIVEN'))[0]).toMatchObject({ actor: 'BORROWER', ip: '203.0.113.9', userAgent: 'TestBrowser/1.0', detail: { provider: 'TRIDUM' } });
    expect(e2e.logs.lines.join('\n')).not.toMatch(/203\.0\.113\.9|TestBrowser/);
  });

  it('public замд ирсэн X-User-Id итгэмжлэгдэхгүй: үйлдэл BORROWER-ээр бичигдэнэ', async () => {
    const { id, token } = await e2e.issue();
    await e2e.get(sign(token), { 'x-user-id': 'admin-1', 'x-roles': 'ADMIN' });
    expect((await auditOf(id, 'OPENED'))[0].actor).toBe('BORROWER');
  });
});
