import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SEED } from '@los/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { OBJECT_STORAGE, type MemoryStorage } from '../src/modules/file/storage';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const as = (u: keyof typeof SEED.users, org: string = SEED.org.id) => ({ 'x-user-id': SEED.users[u].id, 'x-roles': SEED.users[u].roles.join(','), 'x-org-id': org });
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe.skipIf(!HAS_DB)('dms files (Module 0: MinIO file upload)', () => {
  let app: INestApplication;
  let db: PrismaService;
  let storage: MemoryStorage;
  const api = () => request(app.getHttpServer());
  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(PrismaService);
    storage = app.get(OBJECT_STORAGE);
  });
  afterAll(async () => { await app.close(); });

  it('uploads a PDF: stores bytes, a sha256, and metadata', async () => {
    const res = await api().post('/api/files').set(as('officerA')).attach('file', PDF, { filename: 'tsalin.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'tsalin.pdf', mime: 'application/pdf', size: PDF.length, uploadedBy: SEED.users.officerA.id });
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    const row = await db.file.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.orgId).toBe(SEED.org.id);
    expect(row.storageKey).toMatch(new RegExp(`^${SEED.org.id}/\\d{4}/\\d{2}/[0-9a-f-]{36}$`)); // хэрэглэгчийн нэр түлхүүрт орохгүй
    expect(storage.objects.get(row.storageKey)).toEqual(PDF);
  });

  it('keeps Mongolian file names intact', async () => {
    const res = await api().post('/api/files').set(as('officerA')).attach('file', PNG, { filename: 'иргэний үнэмлэх.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('иргэний үнэмлэх.png');
  });

  it('downloads the exact bytes with safe headers', async () => {
    const up = await api().post('/api/files').set(as('officerA')).attach('file', PDF, { filename: 'гэрээ.pdf', contentType: 'application/pdf' });
    const res = await api().get(`/api/files/${up.body.id}/content`).set(as('manager')).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(PDF);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('гэрээ.pdf')}`);
    expect((await api().get(`/api/files/${up.body.id}`).set(as('manager'))).body).toMatchObject({ id: up.body.id, name: 'гэрээ.pdf' });
  });

  it('rejects: no file, bad type, content that does not match the extension, oversize', async () => {
    const post = () => api().post('/api/files').set(as('officerA'));
    expect((await post()).body.code).toBe('FILE_REQUIRED');
    expect((await post().attach('file', Buffer.from('MZ....'), { filename: 'virus.exe', contentType: 'application/x-msdownload' })).status).toBe(415);
    const fake = await post().attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(fake.status).toBe(415);
    expect(fake.body.code).toBe('FILE_CONTENT_MISMATCH');
    const mimeExt = await post().attach('file', PNG, { filename: 'x.pdf', contentType: 'image/png' });
    expect(mimeExt.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const big = await post().attach('file', Buffer.concat([PDF, Buffer.alloc(1_100_000)]), { filename: 'big.pdf', contentType: 'application/pdf' });
    expect(big.status).toBe(413);
  });

  it('strips path components from the name', async () => {
    const res = await api().post('/api/files').set(as('officerA')).attach('file', PDF, { filename: '../../etc/passwd.pdf', contentType: 'application/pdf' });
    expect(res.body.name).toBe('passwd.pdf');
  });

  it("another organization cannot see the file (404, not 403), and unknown ids are 404", async () => {
    const up = await api().post('/api/files').set(as('officerA')).attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' });
    expect((await api().get(`/api/files/${up.body.id}`).set(as('admin', 'other-org'))).status).toBe(404);
    expect((await api().get(`/api/files/${up.body.id}/content`).set(as('admin', 'other-org'))).status).toBe(404);
    expect((await api().get('/api/files/not-an-id').set(as('admin'))).status).toBe(404);
  });

  it('needs the gateway identity', async () => {
    expect((await api().post('/api/files').attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })).status).toBe(401);
  });

  it('leaves no orphan object when the DB write fails', async () => {
    const before = storage.objects.size;
    const spy = db.file.create;
    (db.file as { create: unknown }).create = () => { throw new Error('db down'); };
    try {
      const res = await api().post('/api/files').set(as('officerA')).attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(500);
    } finally { (db.file as { create: unknown }).create = spy; }
    expect(storage.objects.size).toBe(before);
  });
});
