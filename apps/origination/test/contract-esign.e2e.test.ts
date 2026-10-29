import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SEED } from '@los/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { seedBorrower, seedContract } from '../src/modules/contract/contract-db.fixtures';
import { RecordingNotifier, signedEvent, failedEvent, silenceLogs } from '../src/modules/contract/contract-signing.fixtures';
import { ContractSigningEventHandler } from '../src/modules/contract/contract-signing.event-handler';
import { ESIGN_GATEWAY } from '../src/modules/contract/esign.gateway';
import { FakeEsignGateway } from '../src/modules/contract/fake-esign.gateway';
import { SIGNING_LINK_NOTIFIER } from '../src/modules/contract/signing-link-notifier';
import { HAS_DB, as } from './app';

silenceLogs();

// FR-11.4: бодит AppModule (global guard/filter/middleware, Prisma lookup + repository) + dms-ийг FakeEsignGateway-ээр орлуулсан.
// Гарын үсгийн event-ийг handler-д шууд өгнө (Redis шаардахгүй).
describe.skipIf(!HAS_DB)('origination e-sign: HTTP + DB (FR-11.4)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const gateway = new FakeEsignGateway();
  const notifier = new RecordingNotifier();
  const api = () => request(app.getHttpServer());
  const path = (id: string) => `/api/contracts/${id}/esign`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ESIGN_GATEWAY).useValue(gateway)
      .overrideProvider(SIGNING_LINK_NOTIFIER).useValue(notifier)
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });

  async function approvedApplication(o: { status?: string } = {}): Promise<string> {
    const id = `app-${crypto.randomUUID()}`;
    await seedContract(db, { applicationId: id, contractNo: `B${Math.floor(Math.random() * 1e9)}`, generatedFileId: 'file-generated-1', status: o.status ?? 'APPROVED' });
    await seedBorrower(db, id);
    return id;
  }

  it('gateway толгойгүй 401; ЗЭЗ-ээс бусад бичих эрхгүй 403', async () => {
    const id = await approvedApplication();
    expect((await api().post(path(id))).status).toBe(401);
    for (const u of ['manager', 'approver', 'admin'] as const) expect((await api().post(path(id)).set(as(u))).status).toBe(403);
  });

  it('start → PENDING, contract мөрөнд тусгагдаж, SMS-д линк очно (хариунд signingUrl байхгүй)', async () => {
    const id = await approvedApplication();
    const res = await api().post(path(id)).set(as('officerA')).send({ preferredProvider: 'TRIDUM' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ applicationId: id, status: 'PENDING' });
    expect(res.body).not.toHaveProperty('signingUrl');

    const contract = await db.contract.findUniqueOrThrow({ where: { applicationId: id } });
    expect(contract).toMatchObject({ signChannel: 'ESIGN', signingRequestId: res.body.id, signingStatus: 'PENDING' });
    expect(contract.signingSentAt).toBeInstanceOf(Date);
    // dms-д ажилтны контекст (X-Org-Id, роль) очсон, body-д register/phone зөвхөн signer-д
    const call = gateway.calls.filter((c) => c.op === 'createRequest').at(-1)!;
    expect(call.ctx).toMatchObject({ userId: SEED.users.officerA.id, orgId: SEED.org.id, roles: ['OFFICER'] });
    expect(notifier.sent.at(-1)).toMatchObject({ applicationId: id, phone: '99112233' });
    expect(JSON.stringify(res.body)).not.toContain(notifier.sent.at(-1)!.signingUrl);
    // аудит
    expect(await db.auditLog.count({ where: { applicationId: id, action: 'CONTRACT_SIGNING_UPDATED' } })).toBeGreaterThanOrEqual(1);
  });

  it('NFR-3: өөр салбарын ЗЭЗ 403, өөрийн салбарын захирал төлөв харна, дахин start 409', async () => {
    const id = await approvedApplication();
    await api().post(path(id)).set(as('officerA')).expect(201);
    expect((await api().get(path(id)).set(as('officerB'))).status).toBe(403);
    expect((await api().get(path(id)).set(as('manager'))).status).toBe(200);
    expect((await api().get(path(id)).set(as('admin'))).status).toBe(200);
    expect((await api().post(path(id)).set(as('officerA'))).status).toBe(409);
    expect((await api().post(path(id)).set(as('officerB'))).status).toBe(403);
  });

  it('хүсэлт батлагдаагүй (SUBMITTED) бол 409; олдохгүй 404; өөр байгууллага 404', async () => {
    const id = await approvedApplication({ status: 'SUBMITTED' });
    expect((await api().post(path(id)).set(as('officerA'))).status).toBe(409);
    expect((await api().get(path('missing-app')).set(as('officerA'))).status).toBe(404);
    const otherOrg = { ...as('officerA'), 'x-org-id': '00000000-0000-4000-8000-0000000000ff' };
    expect((await api().get(path(id)).set(otherOrg)).status).toBe(404);
  });

  it('ContractSigned event → signed_file_id тавигдаж (G4 хаалганы түлхүүр), давтан хүргэлт no-op', async () => {
    const id = await approvedApplication();
    const started = await api().post(path(id)).set(as('officerA')).expect(201);
    const contract = await db.contract.findUniqueOrThrow({ where: { applicationId: id } });
    const handler = app.get(ContractSigningEventHandler);
    const event = signedEvent(contract.id, { orgId: SEED.org.id, applicationId: id, contractNo: contract.contractNo, signingRequestId: started.body.id });

    await handler.handle(event);
    await handler.handle(event);
    expect(await db.contract.findUniqueOrThrow({ where: { applicationId: id } })).toMatchObject({ signingStatus: 'SIGNED', signedFileId: 'file-signed-1', signChannel: 'ESIGN', signingFailureReason: null });
    expect((await db.contract.findUniqueOrThrow({ where: { applicationId: id } })).signedAt).toEqual(new Date('2026-10-28T09:04:00.000Z'));

    // SIGNED болсон хойно цуцлах/дахин илгээх боломжгүй, өөр event буулгахгүй
    await handler.handle(failedEvent(contract.id, { orgId: SEED.org.id, applicationId: id, contractNo: contract.contractNo, signingRequestId: started.body.id, reason: 'DECLINED' }));
    expect(await db.contract.findUniqueOrThrow({ where: { applicationId: id } })).toMatchObject({ signingStatus: 'SIGNED' });
    expect((await api().post(`${path(id)}/resend`).set(as('officerA'))).status).toBe(409);
    expect((await api().post(path(id)).set(as('officerA'))).status).toBe(409);
  });

  it('ContractSigningFailed (татгалзсан) → DECLINED + шалтгаан; дараа нь шинэ хүсэлт үүсгэж болно', async () => {
    const id = await approvedApplication();
    const started = await api().post(path(id)).set(as('officerA')).expect(201);
    const contract = await db.contract.findUniqueOrThrow({ where: { applicationId: id } });
    await app.get(ContractSigningEventHandler).handle(failedEvent(contract.id, { orgId: SEED.org.id, applicationId: id, contractNo: contract.contractNo, signingRequestId: started.body.id, reason: 'DECLINED' }));
    expect(await db.contract.findUniqueOrThrow({ where: { applicationId: id } })).toMatchObject({ signingStatus: 'DECLINED', signingFailureReason: 'DECLINED', signedFileId: null });

    gateway.setStatus(started.body.id, { status: 'DECLINED', failureReason: 'DECLINED' });
    const again = await api().post(path(id)).set(as('officerA'));
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(started.body.id);
    expect(await db.contract.findUniqueOrThrow({ where: { applicationId: id } })).toMatchObject({ signingStatus: 'PENDING', signingFailureReason: null, signingRequestId: again.body.id });
  });
});
