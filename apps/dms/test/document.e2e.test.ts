import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentListResponse, DocumentRemoved, DocumentUploaded, DocumentView } from '@los/contracts';
import { SEED } from '@los/database';
import { MockOcrProvider, SYNTHETIC_REGISTER_NO } from '@los/ocr';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { OBJECT_STORAGE, type MemoryStorage } from '../src/modules/file/storage';
import { OCR_PROVIDER } from '../src/modules/ocr/ocr.module';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const OTHER_ORG = 'other-org';
const as = (u: keyof typeof SEED.users, org: string = SEED.org.id) => ({ 'x-user-id': SEED.users[u].id, 'x-roles': SEED.users[u].roles.join(','), 'x-org-id': org, 'x-correlation-id': 'corr-doc-1' });
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe.skipIf(!HAS_DB)('dms documents (FR-9.1: /api/documents)', () => {
  let app: INestApplication;
  let db: PrismaService;
  let storage: MemoryStorage;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    // DEMO: OCR нь mock provider (INTEGRATION_MODE=mock) — file name-ээр fixture сонгоно; env-ээс хамаарахгүйн тулд тодорхой өгнө
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(OCR_PROVIDER).useValue(new MockOcrProvider()).compile()).createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(PrismaService);
    storage = app.get(OBJECT_STORAGE);
  });
  afterAll(async () => { await app.close(); });

  async function upload(name: string, body: Buffer = PDF, contentType = 'application/pdf', who: keyof typeof SEED.users = 'officerA', org: string = SEED.org.id) {
    const res = await api().post('/api/files').set(as(who, org)).attach('file', body, { filename: name, contentType });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; name: string; mime: string; size: number };
  }
  const create = (body: Record<string, unknown>, who: keyof typeof SEED.users = 'officerA', org: string = SEED.org.id) => api().post('/api/documents').set(as(who, org)).send(body);
  async function createOk(applicationId: string, fileId: string, extra: Record<string, unknown> = {}, who: keyof typeof SEED.users = 'officerA') {
    const res = await create({ applicationId, type: 'id_card', fileId, ...extra }, who);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return DocumentView.parse(res.body);
  }
  const events = (documentId: string, type: string) => db.outbox.findMany({ where: { type, payload: { path: ['documentId'], equals: documentId } } });

  describe('POST /api/documents', () => {
    it('creates a document: file facts from dms.file, uploader and time automatic, type and key normalised', async () => {
      const applicationId = randomUUID();
      const file = await upload('tsalin.pdf');
      const res = await create({ applicationId, type: ' Salary Statement ', checklistKey: ' SALARY_STATEMENT ', note: 'Сүүлийн 6 сар', fileId: file.id });
      expect(res.status).toBe(201);
      const view = DocumentView.parse(res.body);
      expect(view).toMatchObject({
        applicationId, type: 'salary_statement', checklistKey: 'salary_statement', relatedEntity: 'APPLICATION', relatedId: null, note: 'Сүүлийн 6 сар',
        fileId: file.id, fileName: 'tsalin.pdf', mime: 'application/pdf', size: PDF.length, uploadedBy: SEED.users.officerA.id,
      });
      expect(Math.abs(Date.now() - new Date(view.uploadedAt).getTime())).toBeLessThan(60_000);
      const row = await db.document.findUniqueOrThrow({ where: { id: view.id } });
      expect(row).toMatchObject({ orgId: SEED.org.id, createdBy: SEED.users.officerA.id, checklistKey: 'salary_statement' });
    });

    it('writes DocumentUploaded to the outbox with the related facts (same transaction as the row)', async () => {
      const applicationId = randomUUID();
      const file = await upload('a.pdf');
      const doc = await createOk(applicationId, file.id, { relatedEntity: 'BORROWER', relatedId: 'cust-1', checklistKey: 'id_card' });
      const rows = await events(doc.id, 'DocumentUploaded');
      expect(rows).toHaveLength(1);
      const event = DocumentUploaded.parse(rows[0]!.payload);
      expect(event).toMatchObject({
        type: 'DocumentUploaded', documentId: doc.id, applicationId, kind: 'id_card', relatedEntity: 'BORROWER', relatedId: 'cust-1', checklistKey: 'id_card', fileId: file.id,
        orgId: SEED.org.id, actorId: SEED.users.officerA.id, correlationId: 'corr-doc-1', version: 1,
      });
      expect(rows[0]!.id).toBe(event.eventId);
      expect(rows[0]!.publishedAt).toBeNull();
    });

    it('accepts BORROWER and COLLATERAL links with a relatedId; the same file may back several documents', async () => {
      const applicationId = randomUUID();
      const file = await upload('a.pdf');
      const a = await createOk(applicationId, file.id, { relatedEntity: 'COLLATERAL', relatedId: 'col-1', type: 'ownership_certificate' });
      const b = await createOk(applicationId, file.id, { relatedEntity: 'BORROWER', relatedId: 'cust-2' });
      expect(a).toMatchObject({ relatedEntity: 'COLLATERAL', relatedId: 'col-1', checklistKey: null });
      expect(b).toMatchObject({ relatedEntity: 'BORROWER', relatedId: 'cust-2' });
      expect(a.id).not.toBe(b.id);
    });

    it('rejects: BORROWER/COLLATERAL without relatedId, APPLICATION with relatedId (422, nothing written)', async () => {
      const applicationId = randomUUID();
      const file = await upload('a.pdf');
      const before = await db.outbox.count();
      for (const relatedEntity of ['BORROWER', 'COLLATERAL']) {
        const res = await create({ applicationId, type: 'id_card', fileId: file.id, relatedEntity });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('RELATED_ID_REQUIRED');
      }
      const res = await create({ applicationId, type: 'id_card', fileId: file.id, relatedId: 'x' });
      expect([res.status, res.body.code]).toEqual([422, 'RELATED_ID_NOT_ALLOWED']);
      expect(await db.document.count({ where: { applicationId } })).toBe(0);
      expect(await db.outbox.count()).toBe(before);
    });

    it('validates the body: 400 VALIDATION_FAILED for a bad id, missing type, empty or unknown fields', async () => {
      const file = await upload('a.pdf');
      const good = { applicationId: randomUUID(), type: 'id_card', fileId: file.id };
      for (const bad of [{ ...good, applicationId: 'not-a-uuid' }, { ...good, fileId: 'nope' }, { ...good, type: '  ' }, { applicationId: good.applicationId, fileId: file.id }, { ...good, relatedEntity: 'NOPE' }, { ...good, checklistKey: 'x'.repeat(61) }, { ...good, note: '' }]) {
        const res = await create(bad);
        expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
    });

    it('unknown file, purged file and another organization file are all the same 404 FILE_NOT_FOUND', async () => {
      const applicationId = randomUUID();
      const purged = await upload('purged.pdf');
      await db.file.update({ where: { id: purged.id }, data: { purgedAt: new Date() } });
      const foreign = await upload('foreign.pdf', PDF, 'application/pdf', 'admin', OTHER_ORG);
      const before = await db.outbox.count();
      for (const fileId of [randomUUID(), purged.id, foreign.id]) {
        const res = await create({ applicationId, type: 'id_card', fileId });
        expect([res.status, res.body.code]).toEqual([404, 'FILE_NOT_FOUND']);
      }
      expect(await db.document.count({ where: { applicationId } })).toBe(0);
      expect(await db.outbox.count()).toBe(before); // rolled back: no DocumentUploaded for a missing file
    });

    it('needs the application:read permission and the gateway identity', async () => {
      const file = await upload('a.pdf');
      const body = { applicationId: randomUUID(), type: 'id_card', fileId: file.id };
      expect((await api().post('/api/documents').send(body)).status).toBe(401);
      expect((await api().post('/api/documents').set({ 'x-org-id': SEED.org.id, 'x-customer-id': 'c-1', 'x-roles': 'CUSTOMER' }).send(body)).status).toBe(403);
      expect((await api().post('/api/documents').set({ ...as('officerA'), 'x-roles': 'NOBODY' }).send(body)).status).toBe(403);
      // ADMIN lacks application:write: the read permission is what lets origination call on its behalf
      for (const who of ['admin', 'manager', 'approver', 'officerB'] as const) expect((await create(body, who)).status, who).toBe(201);
    });
  });

  describe('GET /api/documents', () => {
    it('lists by application ordered by creation time ascending; filters by related entity / id', async () => {
      const applicationId = randomUUID();
      const file = await upload('a.pdf');
      const first = await createOk(applicationId, file.id, { type: 'other' });
      const second = await createOk(applicationId, file.id, { relatedEntity: 'BORROWER', relatedId: 'cust-1' });
      const third = await createOk(applicationId, file.id, { relatedEntity: 'BORROWER', relatedId: 'cust-2' });
      await createOk(randomUUID(), file.id); // өөр хүсэлт
      const all = await api().get('/api/documents').query({ applicationId }).set(as('manager'));
      expect(all.status).toBe(200);
      expect(DocumentListResponse.parse(all.body).items.map((d) => d.id)).toEqual([first.id, second.id, third.id]);
      const borrowers = await api().get('/api/documents').query({ applicationId, relatedEntity: 'BORROWER' }).set(as('officerA'));
      expect(borrowers.body.items.map((d: { id: string }) => d.id)).toEqual([second.id, third.id]);
      const one = await api().get('/api/documents').query({ applicationId, relatedEntity: 'BORROWER', relatedId: 'cust-2' }).set(as('officerA'));
      expect(one.body.items.map((d: { id: string }) => d.id)).toEqual([third.id]);
    });

    it('is ordered by creation time even when rows are inserted out of order', async () => {
      const applicationId = randomUUID();
      const file = await upload('a.pdf');
      const newest = await createOk(applicationId, file.id, { type: 'b' });
      const oldest = await createOk(applicationId, file.id, { type: 'a' });
      await db.document.update({ where: { id: oldest.id }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } });
      const res = await api().get('/api/documents').query({ applicationId }).set(as('officerA'));
      expect(res.body.items.map((d: { id: string }) => d.id)).toEqual([oldest.id, newest.id]);
    });

    it('requires a UUID applicationId; unknown application → empty list', async () => {
      expect((await api().get('/api/documents').set(as('officerA'))).body.code).toBe('VALIDATION_FAILED');
      expect((await api().get('/api/documents').query({ applicationId: 'x' }).set(as('officerA'))).status).toBe(400);
      const empty = await api().get('/api/documents').query({ applicationId: randomUUID() }).set(as('officerA'));
      expect([empty.status, empty.body]).toEqual([200, { items: [] }]);
    });

    it('is organization scoped: another organization sees nothing', async () => {
      const applicationId = randomUUID();
      const file = await upload('a.pdf');
      await createOk(applicationId, file.id);
      const other = await api().get('/api/documents').query({ applicationId }).set(as('admin', OTHER_ORG));
      expect(other.body).toEqual({ items: [] });
    });

    it('hides documents whose file was purged', async () => {
      const applicationId = randomUUID();
      const keep = await upload('keep.pdf');
      const gone = await upload('gone.pdf');
      const a = await createOk(applicationId, keep.id);
      const b = await createOk(applicationId, gone.id, { type: 'other' });
      await db.file.update({ where: { id: gone.id }, data: { purgedAt: new Date() } });
      const res = await api().get('/api/documents').query({ applicationId }).set(as('officerA'));
      expect(res.body.items.map((d: { id: string }) => d.id)).toEqual([a.id]);
      expect((await api().get(`/api/documents/${b.id}`).set(as('officerA'))).status).toBe(404);
    });
  });

  describe('GET /api/documents/:id', () => {
    it('returns the document; another organization, unknown and malformed ids are 404 DOCUMENT_NOT_FOUND', async () => {
      const file = await upload('a.pdf');
      const doc = await createOk(randomUUID(), file.id);
      const ok = await api().get(`/api/documents/${doc.id}`).set(as('approver'));
      expect(ok.status).toBe(200);
      expect(DocumentView.parse(ok.body)).toEqual(doc);
      for (const id of [doc.id, randomUUID(), 'not-an-id']) {
        const res = await api().get(`/api/documents/${id}`).set(as('admin', OTHER_ORG));
        expect([id, res.status, res.body.code]).toEqual([id, 404, 'DOCUMENT_NOT_FOUND']);
      }
      expect((await api().get(`/api/documents/${randomUUID()}`).set(as('admin'))).body.code).toBe('DOCUMENT_NOT_FOUND');
      expect((await api().get('/api/documents/not-an-id').set(as('admin'))).status).toBe(404);
    });
  });

  describe('DELETE /api/documents/:id', () => {
    it('removes the document (204), keeps the file, and writes DocumentRemoved in the same transaction', async () => {
      const applicationId = randomUUID();
      const file = await upload('a.pdf');
      const doc = await createOk(applicationId, file.id, { relatedEntity: 'BORROWER', relatedId: 'cust-1', checklistKey: 'id_card' });
      const res = await api().delete(`/api/documents/${doc.id}`).set(as('officerA'));
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(await db.document.count({ where: { id: doc.id } })).toBe(0);
      expect(await db.file.count({ where: { id: file.id, purgedAt: null } })).toBe(1);
      const rows = await events(doc.id, 'DocumentRemoved');
      expect(rows).toHaveLength(1);
      expect(DocumentRemoved.parse(rows[0]!.payload)).toMatchObject({
        documentId: doc.id, applicationId, kind: 'id_card', relatedEntity: 'BORROWER', relatedId: 'cust-1', checklistKey: 'id_card', orgId: SEED.org.id, actorId: SEED.users.officerA.id,
      });
      expect((await api().get(`/api/documents/${doc.id}`).set(as('officerA'))).status).toBe(404);
    });

    it('second delete, unknown id and malformed id → 404 and no extra event', async () => {
      const file = await upload('a.pdf');
      const doc = await createOk(randomUUID(), file.id);
      expect((await api().delete(`/api/documents/${doc.id}`).set(as('officerA'))).status).toBe(204);
      for (const id of [doc.id, randomUUID(), 'zzz']) {
        const res = await api().delete(`/api/documents/${id}`).set(as('officerA'));
        expect([res.status, res.body.code]).toEqual([404, 'DOCUMENT_NOT_FOUND']);
      }
      expect(await events(doc.id, 'DocumentRemoved')).toHaveLength(1);
    });

    it("another organization cannot delete (404, the document stays, no event)", async () => {
      const file = await upload('a.pdf');
      const doc = await createOk(randomUUID(), file.id);
      expect((await api().delete(`/api/documents/${doc.id}`).set(as('admin', OTHER_ORG))).status).toBe(404);
      expect(await db.document.count({ where: { id: doc.id } })).toBe(1);
      expect(await events(doc.id, 'DocumentRemoved')).toHaveLength(0);
    });

    it('concurrent deletes: exactly one wins and exactly one DocumentRemoved is written', async () => {
      const file = await upload('a.pdf');
      const doc = await createOk(randomUUID(), file.id);
      const results = await Promise.all([1, 2, 3, 4].map(() => api().delete(`/api/documents/${doc.id}`).set(as('officerA'))));
      expect(results.map((r) => r.status).sort()).toEqual([204, 404, 404, 404]);
      expect(await events(doc.id, 'DocumentRemoved')).toHaveLength(1);
    });
  });

  describe('POST /api/documents/:id/ocr (mock provider fixtures)', () => {
    let log: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { log = vi.spyOn(Logger.prototype, 'log'); });
    afterEach(() => { vi.restoreAllMocks(); });
    const ocr = (id: string, who: keyof typeof SEED.users = 'officerA', org: string = SEED.org.id) => api().post(`/api/documents/${id}/ocr`).set(as(who, org));

    it('id_card → ID_CARD extraction without text; no-store; nothing persisted', async () => {
      const file = await upload('id-card.png', PNG, 'image/png');
      const doc = await createOk(randomUUID(), file.id, { relatedEntity: 'BORROWER', relatedId: 'cust-1', checklistKey: 'id_card' });
      const documentsBefore = await db.document.count();
      const res = await ocr(doc.id);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({ documentId: doc.id, docType: 'ID_CARD', detectedDocType: 'ID_CARD' });
      expect(res.body.fields.registerNo.value).toBe(SYNTHETIC_REGISTER_NO);
      expect(res.body.fields.birthDate.value).toBe('1985-06-15');
      expect(res.body.ocr).toMatchObject({ engine: 'mock', pageCount: 1 });
      expect('text' in res.body.ocr).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain('МОНГОЛ УЛС'); // түүхий текстийн мөр хариунд орохгүй
      expect(await db.document.count()).toBe(documentsBefore);
    });

    it('salary_statement → SALARY_CERTIFICATE; any other key or no key → GENERIC', async () => {
      const salaryFile = await upload('salary.png', PNG, 'image/png');
      const salary = await createOk(randomUUID(), salaryFile.id, { type: 'salary_statement', checklistKey: 'salary_statement' });
      const salaryRes = await ocr(salary.id);
      expect(salaryRes.status).toBe(200);
      expect(salaryRes.body.docType).toBe('SALARY_CERTIFICATE');
      expect(salaryRes.body.fields.monthlySalary.value).toBe(1_800_000);

      const idFile = await upload('id-card.png', PNG, 'image/png');
      for (const extra of [{ checklistKey: 'business_license', type: 'business_license' }, { type: 'other' }]) {
        const doc = await createOk(randomUUID(), idFile.id, extra);
        const res = await ocr(doc.id);
        expect(res.status).toBe(200);
        expect(res.body.docType).toBe('GENERIC');
        expect(res.body.fields.registerNos.value).toContain(SYNTHETIC_REGISTER_NO);
      }
    });

    it('type alone never selects a parser: only the checklist key does (type id_card without a key → GENERIC)', async () => {
      const file = await upload('id-card.png', PNG, 'image/png');
      const doc = await createOk(randomUUID(), file.id, { type: 'id_card' });
      expect(doc.checklistKey).toBeNull();
      expect((await ocr(doc.id)).body.docType).toBe('GENERIC');
    });

    it('an uppercase key from the caller still selects the ID card parser (keys are normalised)', async () => {
      const file = await upload('id-card.png', PNG, 'image/png');
      const doc = await createOk(randomUUID(), file.id, { checklistKey: 'ID_CARD' });
      expect(doc.checklistKey).toBe('id_card');
      expect((await ocr(doc.id)).body.docType).toBe('ID_CARD');
    });

    it('no fixture for this file name → 422 NO_FIXTURE (mock behaviour kept)', async () => {
      const file = await upload('photo.png', PNG, 'image/png');
      const doc = await createOk(randomUUID(), file.id);
      const res = await ocr(doc.id);
      expect([res.status, res.body.code]).toEqual([422, 'NO_FIXTURE']);
      expect(JSON.stringify(res.body)).not.toContain('photo'); // файлын нэр хариунд орохгүй
    });

    it('a file type OCR cannot read (text) → 415 UNSUPPORTED_MIME', async () => {
      const file = await upload('notes.txt', Buffer.from('hello'), 'text/plain');
      const doc = await createOk(randomUUID(), file.id, { type: 'other' });
      const res = await ocr(doc.id);
      expect([res.status, res.body.code]).toEqual([415, 'UNSUPPORTED_MIME']);
    });

    it('a PDF is readable (fixture by name)', async () => {
      const file = await upload('id-card.pdf');
      const doc = await createOk(randomUUID(), file.id, { checklistKey: 'id_card' });
      const res = await ocr(doc.id);
      expect([res.status, res.body.docType]).toEqual([200, 'ID_CARD']);
    });

    it('object missing from storage → 502 FILE_CONTENT_UNAVAILABLE without internals', async () => {
      const file = await upload('id-card.png', PNG, 'image/png');
      const doc = await createOk(randomUUID(), file.id);
      const row = await db.file.findUniqueOrThrow({ where: { id: file.id } });
      storage.objects.delete(row.storageKey);
      const res = await ocr(doc.id);
      expect([res.status, res.body.code]).toEqual([502, 'FILE_CONTENT_UNAVAILABLE']);
      expect(JSON.stringify(res.body)).not.toMatch(/NoSuchKey|storageKey|memory/);
    });

    it('another organization, unknown and malformed ids → 404; purged file → 404', async () => {
      const file = await upload('id-card.png', PNG, 'image/png');
      const doc = await createOk(randomUUID(), file.id);
      for (const [id, org] of [[doc.id, OTHER_ORG], [randomUUID(), SEED.org.id], ['nope', SEED.org.id]] as const) {
        const res = await ocr(id, 'admin', org);
        expect([id, res.status, res.body.code]).toEqual([id, 404, 'DOCUMENT_NOT_FOUND']);
      }
      await db.file.update({ where: { id: file.id }, data: { purgedAt: new Date() } });
      expect((await ocr(doc.id)).status).toBe(404);
    });

    it('requires identity and application:read', async () => {
      const file = await upload('id-card.png', PNG, 'image/png');
      const doc = await createOk(randomUUID(), file.id);
      expect((await api().post(`/api/documents/${doc.id}/ocr`)).status).toBe(401);
      expect((await api().post(`/api/documents/${doc.id}/ocr`).set({ 'x-org-id': SEED.org.id, 'x-customer-id': 'c', 'x-roles': 'CUSTOMER' })).status).toBe(403);
      expect((await ocr(doc.id, 'admin')).status).toBe(200);
    });

    it('logs no register number, file name, or document text', async () => {
      const file = await upload('id-card.png', PNG, 'image/png');
      const doc = await createOk(randomUUID(), file.id);
      expect((await ocr(doc.id)).status).toBe(200);
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('ocr.extract'); // OcrService логлосон
      for (const secret of [SYNTHETIC_REGISTER_NO, 'id-card', 'Дорж', 'Болд', 'МОНГОЛ']) expect(logged).not.toContain(secret);
    });
  });
});
