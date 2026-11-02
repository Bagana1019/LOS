import 'reflect-metadata';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED } from '@los/database';
import { ApplicationDocumentMutationResponse, ApplicationDocumentsResponse, DocumentOcrCheck, StepKey, type DocumentView } from '@los/contracts';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { DMS_DOCUMENTS } from '../src/modules/document/dms-documents.port';
import { HttpDmsDocuments } from '../src/modules/document/http-dms-documents.port';
import { ApplicationDocumentService } from '../src/modules/document/document.service';
import { createApplication, createBorrower, createCustomer, hasTestDb, resetDb } from '../src/test-utils/factories';
import { as } from './app';

/**
 * Модуль 9 · production wiring: AppModule + БОДИТ HTTP порт (`HttpDmsDocuments`) + dms-ийг дуурайсан жижиг HTTP сервер.
 * Fake-гүй — DI, route, толгой (X-*), DELETE, алдааны зам, 8-р алхмын AC-г бүтнээр нь шалгана. Дэлгэрэнгүй дүрмүүд: src/modules/document/document.e2e.test.ts.
 */
const ORG = SEED.org.id;
const CHECKLIST = [
  { key: 'id_card', name: 'Иргэний үнэмлэх', required: true },
  { key: 'salary_statement', name: 'Цалингийн тодорхойлолт', required: true },
  { key: 'application_form', name: 'Зээлийн хүсэлтийн маягт', required: true },
];

interface Seen { method: string; path: string; headers: IncomingMessage['headers'] }

/** dms-ийн `/api/documents` гэрээг (DocumentView, `{items}`, 204, ocr) хангах хамгийн бага stub. Байгууллагыг X-Org-Id-аар тусгаарлана. */
function startFakeDms(): Promise<{ server: Server; url: string; docs: Map<string, { orgId: string; view: DocumentView }>; seen: Seen[]; ocr: Map<string, unknown> }> {
  const docs = new Map<string, { orgId: string; view: DocumentView }>();
  const ocr = new Map<string, unknown>();
  const seen: Seen[] = [];
  let clock = Date.UTC(2026, 9, 29, 1, 0, 0);
  const json = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const orgId = String(req.headers['x-org-id'] ?? '');
      seen.push({ method: req.method ?? '', path: url.pathname, headers: req.headers });
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, string | null | undefined>) : {};
      const m = /^\/api\/documents(?:\/([^/]+)(\/ocr)?)?$/.exec(url.pathname);
      if (!m) return json(res, 404, { code: 'NOT_FOUND', message: 'x' });
      const [, id, isOcr] = m;
      if (req.method === 'POST' && !id) {
        const view: DocumentView = {
          id: randomUUID(), applicationId: String(body.applicationId), type: String(body.type), relatedEntity: body.relatedEntity as DocumentView['relatedEntity'], relatedId: body.relatedId ?? null,
          note: body.note ?? null, fileId: String(body.fileId), fileName: 'scan.pdf', mime: 'application/pdf', size: 1024,
          checklistKey: body.checklistKey ?? null, uploadedBy: String(req.headers['x-user-id'] ?? ''), uploadedAt: new Date((clock += 1000)).toISOString(),
        };
        docs.set(view.id, { orgId, view });
        return json(res, 201, view);
      }
      if (req.method === 'GET' && !id) {
        const items = [...docs.values()].filter((d) => d.orgId === orgId && d.view.applicationId === url.searchParams.get('applicationId')).map((d) => d.view);
        return json(res, 200, { items });
      }
      const found = id ? docs.get(id) : undefined;
      if (!found || found.orgId !== orgId) return json(res, 404, { code: 'DOCUMENT_NOT_FOUND', message: 'Баримт олдсонгүй' });
      if (req.method === 'DELETE' && !isOcr) { docs.delete(found.view.id); return json(res, 204); }
      if (req.method === 'POST' && isOcr) {
        const fixture = ocr.get(found.view.id);
        return fixture ? json(res, 200, fixture) : json(res, 422, { code: 'NO_FIXTURE', message: 'Энэ баримтад mock fixture алга' }); // dms OcrErrorFilter: NO_FIXTURE → 422
      }
      return json(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'x' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, docs, seen, ocr })));
}

describe.skipIf(!hasTestDb)('documents in AppModule (DB, real HTTP port, stub dms)', () => {
  let app: INestApplication;
  let db: PrismaService;
  let dms: Awaited<ReturnType<typeof startFakeDms>>;
  let savedDmsUrl: string | undefined;
  const createdProducts: string[] = [];
  const http = () => request(app.getHttpServer());
  const officerA = SEED.users.officerA;

  beforeAll(async () => {
    savedDmsUrl = process.env.DMS_URL;
    dms = await startFakeDms();
    process.env.DMS_URL = dms.url;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(PrismaService);
  });
  afterAll(async () => {
    await resetDb(db);
    await app.close();
    await new Promise((r) => dms.server.close(r));
    if (savedDmsUrl === undefined) delete process.env.DMS_URL; else process.env.DMS_URL = savedDmsUrl;
  });
  beforeEach(async () => {
    await resetDb(db);
    process.env.DMS_URL = dms.url;
    dms.docs.clear();
    dms.ocr.clear();
    dms.seen.length = 0;
  });
  afterEach(async () => {
    // Seed-ийн бүтээгдэхүүнд хүрэхгүй — зөвхөн энэ тестийн үүсгэснийг устгана
    if (createdProducts.length) await db.product.deleteMany({ where: { id: { in: createdProducts.splice(0) } } });
  });

  async function scenario() {
    const product = await db.product.create({
      data: { orgId: ORG, code: `DOC-${randomUUID().slice(0, 8)}`, name: 'Баримтын тест', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 18, maxRate: 42, documentChecklistJson: CHECKLIST },
    });
    createdProducts.push(product.id);
    const application = await createApplication(db, { orgId: ORG, branchId: SEED.branches.head.id, officerId: officerA.id, productId: product.id });
    await db.loanApplicationStep.createMany({ data: StepKey.map((stepKey) => ({ orgId: ORG, applicationId: application.id, stepKey, status: 'PENDING' })) });
    return application;
  }
  const url = (appId: string, ...rest: string[]) => ['/api/applications', appId, 'documents', ...rest].join('/');
  const step = (appId: string) => db.loanApplicationStep.findUniqueOrThrow({ where: { applicationId_stepKey: { applicationId: appId, stepKey: 'document' } } });
  const fileId = () => randomUUID();

  it('DI: DMS_DOCUMENTS нь бодит HTTP порт; ApplicationDocumentService бүртгэгдсэн', () => {
    expect(app.get(DMS_DOCUMENTS)).toBeInstanceOf(HttpDmsDocuments);
    expect(app.get(ApplicationDocumentService, { strict: false })).toBeInstanceOf(ApplicationDocumentService);
  });

  it('нэвтрээгүй -> 401; өөр ЗЭЗ -> 403; хүсэлт олдохгүй -> 404; буруу body -> 400 (dms-д хүрэхгүй)', async () => {
    const a = await scenario();
    expect((await http().get(url(a.id))).status).toBe(401);
    expect((await http().get(url(a.id)).set(as('officerB'))).status).toBe(403);
    expect((await http().post(url(a.id)).set(as('officerB')).send({ fileId: fileId(), type: 'other' })).status).toBe(403);
    const missing = await http().get(url(randomUUID())).set(as('officerA'));
    expect([missing.status, missing.body.code]).toEqual([404, 'APPLICATION_NOT_FOUND']);
    const bad = await http().post(url(a.id)).set(as('officerA')).send({ fileId: 'x' });
    expect([bad.status, bad.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(dms.seen).toEqual([]);
  });

  it('AC: 3 төрөл — 2 оруулахад PENDING, 3-р нь COMPLETED, нэгийг хасахад дахин PENDING (бодит HTTP: POST, GET, DELETE)', async () => {
    const a = await scenario();
    const post = (key: string) => http().post(url(a.id)).set(as('officerA')).send({ fileId: fileId(), checklistKey: key });
    const first = await post('id_card');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await post('salary_statement');
    expect(ApplicationDocumentMutationResponse.parse(second.body).documents.summary).toMatchObject({ satisfied: 2, complete: false, missing: ['application_form'] });
    expect((await step(a.id)).status).toBe('PENDING');

    const third = ApplicationDocumentMutationResponse.parse((await post('application_form')).body);
    expect(third.documents.summary.complete).toBe(true);
    const done = await step(a.id);
    expect([done.status, done.completedAt === null]).toEqual(['COMPLETED', false]);

    const removed = await http().delete(url(a.id, third.document!.id)).set(as('officerA'));
    expect(removed.status).toBe(200);
    expect(ApplicationDocumentMutationResponse.parse(removed.body).documents.summary).toMatchObject({ complete: false, missing: ['application_form'] });
    const back = await step(a.id);
    expect([back.status, back.completedAt]).toEqual(['PENDING', null]);

    const listed = ApplicationDocumentsResponse.parse((await http().get(url(a.id)).set(as('officerA'))).body);
    expect(listed.items).toHaveLength(2);
    expect(dms.docs.size).toBe(2);

    // Нэг хүсэлтийн аудит: хэн, юуг (тайлбар, файлын нэргүй)
    const audit = await db.auditLog.findMany({ where: { applicationId: a.id, entity: 'DOCUMENT' }, orderBy: { at: 'asc' } });
    expect(audit.map((r) => [r.action, r.actorId])).toEqual([['DOCUMENT_ATTACHED', officerA.id], ['DOCUMENT_ATTACHED', officerA.id], ['DOCUMENT_ATTACHED', officerA.id], ['DOCUMENT_REMOVED', officerA.id]]);
  });

  it('dms руу ctx-ийн толгой дамжина (X-Org-Id, X-User-Id, X-Roles, X-Branch-Id, X-Correlation-Id); DELETE замаар устгана', async () => {
    const a = await scenario();
    const res = await http().post(url(a.id)).set(as('officerA')).set('x-correlation-id', 'corr-wire-1').send({ fileId: fileId(), checklistKey: 'id_card' });
    expect(res.status).toBe(201);
    await http().delete(url(a.id, ApplicationDocumentMutationResponse.parse(res.body).document!.id)).set(as('officerA')).set('x-correlation-id', 'corr-wire-2');
    const create = dms.seen.find((s) => s.method === 'POST')!;
    expect(create.path).toBe('/api/documents');
    expect(create.headers).toMatchObject({ 'x-org-id': ORG, 'x-user-id': officerA.id, 'x-roles': 'OFFICER', 'x-branch-id': SEED.branches.head.id, 'x-correlation-id': 'corr-wire-1' });
    expect(dms.seen.some((s) => s.method === 'DELETE' && /^\/api\/documents\/[0-9a-f-]{36}$/.test(s.path))).toBe(true);
    // Хасалтын дараа дахин тооцоолол: жагсаалтыг үйлчилгээний хэрэглэгчээр биш, дуудагчийн ctx-ээр уншина
    expect(dms.seen.filter((s) => s.method === 'GET').every((s) => s.headers['x-org-id'] === ORG)).toBe(true);
  });

  it('dms унасан/хүрэх боломжгүй бол 502 (монгол мессеж); хавсралт үлдэхгүй, аудит бичигдэхгүй, алхам өөрчлөгдөхгүй', async () => {
    const a = await scenario();
    process.env.DMS_URL = 'http://127.0.0.1:9'; // discard порт: холболт татгалзана
    const list = await http().get(url(a.id)).set(as('officerA'));
    expect([list.status, list.body.code]).toEqual([502, 'UPSTREAM_ERROR']);
    expect(list.body.message).toMatch(/[а-яө]/i);
    const attach = await http().post(url(a.id)).set(as('officerA')).send({ fileId: fileId(), checklistKey: 'id_card' });
    expect(attach.status).toBe(502);
    expect(await db.auditLog.count({ where: { applicationId: a.id, entity: 'DOCUMENT' } })).toBe(0);
    expect((await step(a.id)).status).toBe('PENDING');
  });

  it('dms-ийн 404/422 → тогтвортой кодууд: үл мэдэгдэх түлхүүр 422 (dms-д хүрэхгүй); хүсэлтийн баримт биш docId 404', async () => {
    const a = await scenario();
    const unknown = await http().post(url(a.id)).set(as('officerA')).send({ fileId: fileId(), checklistKey: 'passport' });
    expect([unknown.status, unknown.body.code]).toEqual([422, 'UNKNOWN_CHECKLIST_KEY']);
    expect(dms.seen).toEqual([]);
    const gone = await http().delete(url(a.id, randomUUID())).set(as('officerA'));
    expect([gone.status, gone.body.code]).toEqual([404, 'DOCUMENT_NOT_FOUND']);
    expect(dms.seen.every((s) => s.method === 'GET')).toBe(true); // DELETE хэзээ ч очоогүй
  });

  it('OCR тулгалт бодит порт дамжин: dms-ийн хариуг (талбар, итгэл) уншиж MATCH/MISMATCH; текст, регистр хариунд гарахгүй', async () => {
    const a = await scenario();
    const customer = await createCustomer(db, { orgId: ORG, registerNo: 'УБ90000001' });
    await createBorrower(db, a.id, customer.id, 'PRIMARY', { orgId: ORG });
    const res = await http().post(url(a.id)).set(as('officerA')).send({ fileId: fileId(), checklistKey: 'id_card' });
    const docId = ApplicationDocumentMutationResponse.parse(res.body).document!.id;
    const ocrBody = (registerNo: string) => ({
      documentId: docId, docType: 'ID_CARD', warnings: [], fields: { registerNo: { value: registerNo, confidence: 0.9 }, lastName: { value: 'Бат', confidence: 0.8 } },
      ocr: { meanConfidence: 0.88, text: 'УБ90000001 Бат-Эрдэнэ' },
    });
    dms.ocr.set(docId, ocrBody('УБ90000001'));
    const match = await http().post(url(a.id, docId, 'ocr')).set(as('officerA')).send({});
    expect(match.status, JSON.stringify(match.body)).toBe(200);
    expect(match.headers['cache-control']).toBe('no-store');
    expect(DocumentOcrCheck.parse(match.body)).toMatchObject({ verdict: 'MATCH', docType: 'ID_CARD', registerMasked: 'УБ****0001', confidence: 0.9 });
    expect(JSON.stringify(match.body)).not.toMatch(/УБ90000001|Бат-Эрдэнэ/);

    dms.ocr.set(docId, ocrBody('ЖЮ85061512'));
    expect(DocumentOcrCheck.parse((await http().post(url(a.id, docId, 'ocr')).set(as('officerA')).send({})).body).verdict).toBe('MISMATCH');

    // fixture олдохгүй (dms 422 NO_FIXTURE) → алдаа биш UNREADABLE
    dms.ocr.delete(docId);
    const unreadable = await http().post(url(a.id, docId, 'ocr')).set(as('officerA')).send({});
    expect(unreadable.status).toBe(200);
    expect(DocumentOcrCheck.parse(unreadable.body)).toMatchObject({ verdict: 'UNREADABLE', registerMasked: null });
  });

  it('CUSTOMER дүр, батлагч, салбарын захирал хавсаргаж чадахгүй (403); админ чадна', async () => {
    const a = await scenario();
    const body = { fileId: fileId(), type: 'other' };
    for (const who of ['approver', 'manager'] as const) expect((await http().post(url(a.id)).set(as(who)).send(body)).status).toBe(403);
    expect((await http().post(url(a.id)).set({ 'x-customer-id': randomUUID(), 'x-roles': 'CUSTOMER', 'x-org-id': ORG }).send(body)).status).toBe(403);
    expect((await http().post(url(a.id)).set(as('admin')).send(body)).status).toBe(201);
    expect((await http().get(url(a.id)).set(as('manager'))).status).toBe(200);
  });
});
