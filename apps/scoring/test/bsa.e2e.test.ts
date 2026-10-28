// BSA REST — жинхэнэ scoring AppModule дээр (nest-common guard / алдааны filter / context middleware + EventsModule + PrismaModule): gateway-ийн X-* толгойгоор.
// Дэлгэрэнгүй урсгалыг src/modules/bsa/import/e2e/ тестүүд хариуцна; энд зөвхөн Module 0-ийн суурьтай зэрэг ажиллах эсэхийг шалгана.
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SEED } from '@los/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBsaCatalog } from '../prisma/seed';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { configureBsaApp } from '../src/modules/bsa/import/http';

const officer = { 'x-user-id': SEED.users.officerA.id, 'x-roles': 'OFFICER', 'x-branch-id': SEED.branches.head.id, 'x-org-id': SEED.org.id };
const approver = { 'x-user-id': SEED.users.approver.id, 'x-roles': 'APPROVER', 'x-branch-id': SEED.branches.head.id, 'x-org-id': SEED.org.id };
const body = {
  loanApplicationId: 'app-e2e-1',
  customerId: 'cust-e2e-1',
  borrowerId: 'bor-e2e-1',
  branchId: SEED.branches.head.id,
  customer: { registerNo: 'УБ90010203', lastName: 'Бат-Эрдэнэ', firstName: 'Болд' },
  periodMonths: 3,
  proposedMonthlyPayment: 500_000,
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('BSA on the real scoring AppModule (Module 0 foundation)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureBsaApp(app); // main.ts-тэй ижил: bootstrapService({ configure })
    await app.init();
    // Бусад integration тест нэг DB-г TRUNCATE хийдэг тул (файлууд дарааллаар ажиллана) өөрийн org-ийн каталогийг идемпотентоор дахин суулгана
    await seedBsaCatalog(app.get(PrismaService), SEED.org.id);
  });
  afterAll(async () => {
    await app.close();
  });

  it('the global guard rejects requests without an identity (UNAUTHENTICATED, foundation error shape with code + correlationId)', async () => {
    const res = await request(app.getHttpServer()).get('/api/bsa/analyses');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(typeof res.body.correlationId).toBe('string');
  });

  it('an officer creates and then reads back an analysis; the correlation id is echoed', async () => {
    const created = await request(app.getHttpServer()).post('/api/bsa/analyses').set({ ...officer, 'x-correlation-id': 'corr-e2e-1' }).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.headers['x-correlation-id']).toBe('corr-e2e-1');
    const id = created.body.id as string;
    expect(id).toBeTruthy();
    const read = await request(app.getHttpServer()).get(`/api/bsa/analyses/${id}`).set(officer);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain('УБ90010203'); // регистр ил гарахгүй (NFR-3)
  });

  it('route roles are enforced inside the app: an approver may read but not create (FORBIDDEN)', async () => {
    const res = await request(app.getHttpServer()).post('/api/bsa/analyses').set(approver).send(body);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await request(app.getHttpServer()).get('/api/bsa/analyses').set(approver)).status).toBe(200);
  });

  it('request validation errors use the same error shape (VALIDATION_FAILED with issues, no echoed values)', async () => {
    const res = await request(app.getHttpServer()).post('/api/bsa/analyses').set(officer).send({ ...body, proposedMonthlyPayment: 'zxq-secret' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(res.body)).not.toContain('zxq-secret');
  });
});
