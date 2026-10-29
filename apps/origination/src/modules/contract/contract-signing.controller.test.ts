import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CommonModule } from '@los/nest-common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLICATION_SIGNING_LOOKUP } from './application-signing-lookup';
import { ContractSigningController } from './contract-signing.controller';
import { ContractSigningService } from './contract-signing.service';
import { APPLICATION_ID, createHarness, silenceLogs, type Harness } from './contract-signing.fixtures';
import { CONTRACT_REPOSITORY } from './contract.repository';
import { ESIGN_GATEWAY } from './esign.gateway';
import { SIGNING_LINK_NOTIFIER } from './signing-link-notifier';

silenceLogs();

const OFFICER = { 'x-user-id': 'officer-1', 'x-roles': 'OFFICER', 'x-branch-id': 'branch-1', 'x-org-id': 'org-1', 'x-correlation-id': 'corr-http-1' };
const URL_PATH = `/contracts/${APPLICATION_ID}/esign`;

let h: Harness;
let app: INestApplication;

beforeEach(async () => {
  h = createHarness();
  const moduleRef = await Test.createTestingModule({
    imports: [CommonModule.forRoot()],
    controllers: [ContractSigningController],
    providers: [
      ContractSigningService,
      { provide: APPLICATION_SIGNING_LOOKUP, useValue: h.lookup },
      { provide: CONTRACT_REPOSITORY, useValue: h.contracts },
      { provide: ESIGN_GATEWAY, useValue: h.gateway },
      { provide: SIGNING_LINK_NOTIFIER, useValue: h.notifier },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});
afterEach(() => app.close());

describe('POST /contracts/:applicationId/esign', () => {
  it('201: хүсэлт үүсгэнэ, хариунд signingUrl ГАРАХГҮЙ, SMS-д очно', async () => {
    const res = await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'sr-1', applicationId: APPLICATION_ID, status: 'PENDING', signerPhoneMasked: expect.stringContaining('2233') });
    expect(res.body).not.toHaveProperty('signingUrl');
    expect(res.text).not.toContain(h.notifier.sent[0]!.signingUrl);
    expect(res.text).not.toContain('sign.example.test');
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('body-гүй хүсэлтийг зөвшөөрнө; толгойн контекстыг dms-д дамжуулна', async () => {
    const res = await request(app.getHttpServer()).post(URL_PATH).set(OFFICER);
    expect(res.status).toBe(201);
    expect(h.gateway.calls[0]!.ctx).toEqual({ userId: 'officer-1', roles: ['OFFICER'], branchId: 'branch-1', orgId: 'org-1', customerId: null, correlationId: 'corr-http-1' });
  });

  it('preferredProvider, ttlHours-ийг дамжуулна', async () => {
    await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).send({ preferredProvider: 'MONPASS', ttlHours: 24 }).expect(201);
    expect(h.gateway.calls[0]!.input).toMatchObject({ preferredProvider: 'MONPASS', ttlHours: 24 });
  });

  it.each([
    ['ttlHours 0', { ttlHours: 0 }],
    ['ttlHours 169', { ttlHours: 169 }],
    ['ttlHours бутархай', { ttlHours: 1.5 }],
    ['ttlHours тэмдэгт', { ttlHours: '24' }],
    ['үл мэдэгдэх provider', { preferredProvider: 'DOCUSIGN' }],
    ['supersedeActive (ажилтан түрж цуцлах боломжгүй)', { supersedeActive: true }],
    ['өөр талбар', { signer: { phone: '1' } }],
  ])('400: %s', async (_name, body) => {
    const res = await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).send(body);
    expect(res.status).toBe(400);
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('409: идэвхтэй хүсэлт байхад дахин эхлүүлбэл', async () => {
    await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).expect(201);
    const res = await request(app.getHttpServer()).post(URL_PATH).set(OFFICER);
    expect(res.status).toBe(409);
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('409: гэрээ үүсээгүй', async () => {
    const other = createHarness({ contract: false });
    const res = await request(appFor(await moduleWith(other))).post(URL_PATH).set(OFFICER);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Гэрээ үүсээгүй байна');
  });
});

describe('толгойн контекст ба эрх', () => {
  it('401: x-user-id байхгүй; 401: x-org-id байхгүй', async () => {
    const res = await request(app.getHttpServer()).post(URL_PATH).set({ 'x-roles': 'OFFICER', 'x-org-id': 'org-1' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await request(app.getHttpServer()).post(URL_PATH).set({ ...OFFICER, 'x-org-id': '' })).status).toBe(401);
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('403: бичих эрхгүй дүр (APPROVER, BRANCH_MANAGER, ADMIN, дүргүй) start/resend/cancel хийж чадахгүй, dms-д хүрэхгүй', async () => {
    for (const roles of ['APPROVER', 'BRANCH_MANAGER', 'ADMIN', '']) {
      const headers = { ...OFFICER, 'x-roles': roles };
      expect((await request(app.getHttpServer()).post(URL_PATH).set(headers)).status).toBe(403);
      expect((await request(app.getHttpServer()).post(`${URL_PATH}/resend`).set(headers)).status).toBe(403);
      expect((await request(app.getHttpServer()).post(`${URL_PATH}/cancel`).set(headers)).status).toBe(403);
    }
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('403: өөр ЗЭЗ-ийн хүсэлт (NFR-3 OWN хүрээ)', async () => {
    const res = await request(app.getHttpServer()).post(URL_PATH).set({ ...OFFICER, 'x-user-id': 'officer-2' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'OUT_OF_SCOPE' });
  });

  it('төлөв харах (application:read): ADMIN/APPROVER бүгдийг, BRANCH_MANAGER зөвхөн өөрийн салбарыг', async () => {
    await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).expect(201);
    const read = (roles: string, branch: string) => request(app.getHttpServer()).get(URL_PATH).set({ ...OFFICER, 'x-user-id': 'u-x', 'x-roles': roles, 'x-branch-id': branch });
    expect((await read('ADMIN', 'any')).status).toBe(200);
    expect((await read('APPROVER', 'any')).status).toBe(200);
    expect((await read('BRANCH_MANAGER', 'branch-1')).status).toBe(200);
    expect((await read('BRANCH_MANAGER', 'branch-2')).status).toBe(403);
    expect((await read('', 'branch-1')).status).toBe(403);
  });

  it('404: хүсэлт олдохгүй; өөр байгууллагын хүсэлт мөн 404', async () => {
    await request(app.getHttpServer()).get('/contracts/unknown-app/esign').set(OFFICER).expect(404);
    await request(app.getHttpServer()).get(URL_PATH).set({ ...OFFICER, 'x-org-id': 'org-2' }).expect(404);
    await request(app.getHttpServer()).post(URL_PATH).set({ ...OFFICER, 'x-org-id': 'org-2' }).expect(404);
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('400: applicationId-ийн формат буруу (VALIDATION_FAILED)', async () => {
    const res = await request(app.getHttpServer()).get(`/contracts/${'a'.repeat(65)}/esign`).set(OFFICER);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    await request(app.getHttpServer()).get('/contracts/bad.id/esign').set(OFFICER).expect(400);
    await request(app.getHttpServer()).post('/contracts/bad%20id/esign').set(OFFICER).expect(400);
  });
});

describe('GET / resend / cancel', () => {
  it('GET: төлөв (signingUrl-гүй), эхлээгүй бол 404', async () => {
    await request(app.getHttpServer()).get(URL_PATH).set(OFFICER).expect(404);
    await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).expect(201);
    const res = await request(app.getHttpServer()).get(URL_PATH).set(OFFICER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'sr-1', status: 'PENDING' });
    expect(res.body).not.toHaveProperty('signingUrl');
  });

  it('GET: dms буруугаар signingUrl буцааж ч client-д гарахгүй', async () => {
    await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).expect(201);
    const real = h.gateway.get.bind(h.gateway);
    vi.spyOn(h.gateway, 'get').mockImplementation(async (...args) => ({ ...(await real(...args)), signingUrl: 'https://sign.example.test/sign/LEAK' }));
    const res = await request(app.getHttpServer()).get(URL_PATH).set(OFFICER);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('LEAK');
  });

  it('POST resend: 200, шинэ линк SMS-ээр, хариунд signingUrl-гүй', async () => {
    await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).expect(201);
    const res = await request(app.getHttpServer()).post(`${URL_PATH}/resend`).set(OFFICER);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('signingUrl');
    expect(h.notifier.sent).toHaveLength(2);
    expect(res.text).not.toContain(h.notifier.sent[1]!.signingUrl);
  });

  it('POST resend: идэвхтэй хүсэлтгүй бол 409', async () => {
    await request(app.getHttpServer()).post(`${URL_PATH}/resend`).set(OFFICER).expect(409);
  });

  it('POST cancel: 200 CANCELLED; дахин цуцлах 409', async () => {
    await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).expect(201);
    const res = await request(app.getHttpServer()).post(`${URL_PATH}/cancel`).set(OFFICER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', failureReason: 'CANCELLED' });
    expect(res.body).not.toHaveProperty('signingUrl');
    await request(app.getHttpServer()).post(`${URL_PATH}/cancel`).set(OFFICER).expect(409);
  });

  it('эрхгүй хэрэглэгч resend/cancel/status-д 403', async () => {
    await request(app.getHttpServer()).post(URL_PATH).set(OFFICER).expect(201);
    const other = { ...OFFICER, 'x-user-id': 'officer-2' };
    await request(app.getHttpServer()).post(`${URL_PATH}/resend`).set(other).expect(403);
    await request(app.getHttpServer()).post(`${URL_PATH}/cancel`).set(other).expect(403);
    await request(app.getHttpServer()).get(URL_PATH).set(other).expect(403);
  });

  it('шинэ route-ууд зөвхөн заасан method-оор', async () => {
    await request(app.getHttpServer()).get(`${URL_PATH}/resend`).set(OFFICER).expect(404);
    await request(app.getHttpServer()).delete(URL_PATH).set(OFFICER).expect(404);
  });
});

// ---- туслах: өөр harness-тай app
async function moduleWith(other: Harness) {
  const moduleRef = await Test.createTestingModule({
    imports: [CommonModule.forRoot()],
    controllers: [ContractSigningController],
    providers: [
      ContractSigningService,
      { provide: APPLICATION_SIGNING_LOOKUP, useValue: other.lookup },
      { provide: CONTRACT_REPOSITORY, useValue: other.contracts },
      { provide: ESIGN_GATEWAY, useValue: other.gateway },
      { provide: SIGNING_LINK_NOTIFIER, useValue: other.notifier },
    ],
  }).compile();
  const extra = moduleRef.createNestApplication();
  await extra.init();
  extras.push(extra);
  return extra;
}
const extras: INestApplication[] = [];
const appFor = (a: INestApplication) => a.getHttpServer();
afterEach(async () => {
  await Promise.all(extras.splice(0).map((a) => a.close()));
});
