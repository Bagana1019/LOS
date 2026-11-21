import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, createApplication, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { ApplicationModule } from '../application/application.module';
import { ContractModule } from './contract.module';
import { DMS_DOCGEN } from './dms-docgen.port';
import { FakeDmsDocgen } from './testing/fake-dms-docgen';

const PDF = 'application/pdf';
const PNG = 'image/png';
const JPEG = 'image/jpeg';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const REJECTED = { code: 'SIGNED_SCAN_TYPE_NOT_ALLOWED', message: 'Гарын үсэгтэй гэрээний скан зөвхөн PDF, PNG, JPG төрөлтэй байх ёстой' };

// F4-13: the signed paper contract scan is a legal document. dms verifies at upload that the stored type matches the file's magic bytes
// (file.service.ts FILE_CONTENT_MISMATCH), so the stored `mime` is trustworthy; origination must accept only PDF / PNG / JPEG of the
// generic dms list and must refuse the rest BEFORE the contract is marked signed.
describe.skipIf(!hasTestDb)('contract signed paper scan: allowed types (F4-13, DB)', () => {
  let t: TestApp;
  let baseUrl: string;
  const dms = new FakeDmsDocgen();
  const officer = actors.officer('officer-1');

  beforeAll(async () => {
    t = await createTestApp([ApplicationModule, ContractModule], (b) => b.overrideProvider(DMS_DOCGEN).useValue(dms));
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.prisma); dms.files.clear(); dms.mimes.clear(); dms.uploaders.clear(); });

  const http = () => request(baseUrl);
  /** Approved application whose contract PDF is already generated (the state in which «Скан оруулах» is offered). */
  async function generatedContract() {
    const app = await createApplication(t.prisma, { status: 'APPROVED', contractNo: 'C-2026-0001' });
    const generatedFileId = randomUUID();
    dms.files.add(generatedFileId);
    const contract = await t.prisma.contract.create({ data: { orgId: ORG, applicationId: app.id, contractNo: 'C-2026-0001', generatedFileId, createdBy: 'officer-1', updatedBy: 'officer-1' } });
    return { appId: app.id, contractId: contract.id };
  }
  /** A file already stored in dms with the given (dms-verified) type; `null` = dms did not report a type. */
  const stored = (mime: string | null, uploader?: string) => {
    const id = randomUUID();
    dms.files.add(id);
    dms.mimes.set(id, mime);
    if (uploader) dms.uploaders.set(id, uploader);
    return id;
  };
  const attach = (appId: string, fileId: string) => http().post(`/api/applications/${appId}/contract/signed`).set(officer).send({ fileId });
  const row = (appId: string) => t.prisma.contract.findUniqueOrThrow({ where: { applicationId: appId } });
  const attachedAudits = (contractId: string) => t.prisma.auditLog.count({ where: { entityId: contractId, action: 'CONTRACT_PAPER_SIGNED_ATTACHED' } });

  it('a .txt scan (the F4-13 case) is rejected with 415 SIGNED_SCAN_TYPE_NOT_ALLOWED and the contract stays unsigned', async () => {
    const { appId, contractId } = await generatedContract();
    const res = await attach(appId, stored('text/plain'));
    expect([res.status, res.body.code, res.body.message]).toEqual([415, REJECTED.code, REJECTED.message]);
    const after = await row(appId);
    expect([after.signedFileId, after.signedAt]).toEqual([null, null]);
    expect(await attachedAudits(contractId)).toBe(0);
  });

  it.each([['docx', DOCX], ['xlsx', XLSX], ['csv', 'text/csv'], ['txt', 'text/plain']])('the rest of the generic dms list (%s) is rejected with 415', async (_name, mime) => {
    const { appId } = await generatedContract();
    const res = await attach(appId, stored(mime));
    expect([res.status, res.body.code]).toEqual([415, REJECTED.code]);
    expect((await row(appId)).signedFileId).toBeNull();
  });

  it('a file whose type dms did not report is rejected (fail closed)', async () => {
    const { appId } = await generatedContract();
    const res = await attach(appId, stored(null));
    expect([res.status, res.body.code]).toEqual([415, REJECTED.code]);
    expect((await row(appId)).signedFileId).toBeNull();
  });

  it.each([['pdf', PDF], ['png', PNG], ['jpeg', JPEG]])('a %s scan is accepted: contract becomes signed on the PAPER channel', async (_name, mime) => {
    const { appId, contractId } = await generatedContract();
    const fileId = stored(mime);
    const res = await attach(appId, fileId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await row(appId);
    expect([after.signedFileId, after.signChannel]).toEqual([fileId, 'PAPER']);
    expect(after.signedAt).not.toBeNull();
    expect(await attachedAudits(contractId)).toBe(1);
  });

  it('a rejected scan does not poison the contract: a valid scan attached afterwards is accepted', async () => {
    const { appId } = await generatedContract();
    expect((await attach(appId, stored('text/plain'))).status).toBe(415);
    const pdf = stored(PDF);
    expect((await attach(appId, pdf)).status).toBe(200);
    expect((await row(appId)).signedFileId).toBe(pdf);
  });

  it("someone else's file is refused as FILE_NOT_OWNED (403) before its type is revealed", async () => {
    const { appId } = await generatedContract();
    const res = await attach(appId, stored('text/plain', 'someone-else'));
    expect([res.status, res.body.code]).toEqual([403, 'FILE_NOT_OWNED']);
  });
});
