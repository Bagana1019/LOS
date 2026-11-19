import { ForbiddenException, NotFoundException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentView, RequestContext } from '@los/contracts';
import { CommonModule, collectRoutes, routeKey } from '@los/nest-common';
import type { PrismaService } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import type { ValuationPort } from '../collateral/ports/valuation.port';
import type { DmsDocumentsPort } from '../document/dms-documents.port';
import { AppModule } from '../../app.module';
import { ApplicationFileController } from './application-file.controller';
import { ApplicationFileModule } from './application-file.module';
import { ApplicationFileService } from './application-file.service';
import type { ApplicationFileStorePort, StoredFile } from './application-file.store';

const ORG = 'org-1';
const APP = { id: 'app-1', orgId: ORG, branchId: 'branch-1', officerId: 'officer-1' };
const F = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const FILE = { contract: F(1), signed: F(2), letter: F(3), collateralDoc: F(4), dmsDoc: F(5), valuationReport: F(6), foreign: F(7) };

const ctx = (roles: string[], extra: Partial<RequestContext> = {}): RequestContext =>
  ({ userId: 'officer-1', roles, branchId: 'branch-1', orgId: ORG, customerId: null, correlationId: 'c-1', ...extra }) as RequestContext;

/** Зөвхөн APP-д холбогдсон файлууд. Бусад id (FILE.foreign) өөр хүсэлтийнх гэж үзэгдэнэ. */
function build() {
  const calls = { documents: 0, valuation: 0, fetched: [] as string[] };
  const prisma = {
    loanApplication: { findFirst: async ({ where }: { where: { id: string; orgId: string } }) => (where.id === APP.id && where.orgId === APP.orgId ? APP : null) },
    contract: {
      findFirst: async ({ where }: { where: { applicationId: string; OR: { generatedFileId?: string; signedFileId?: string }[] } }) =>
        where.applicationId === APP.id && where.OR.some((o) => o.generatedFileId === FILE.contract || o.signedFileId === FILE.signed) ? { id: 'c' } : null,
    },
    officialLetter: { findFirst: async ({ where }: { where: { applicationId: string; generatedFileId: string } }) => (where.applicationId === APP.id && where.generatedFileId === FILE.letter ? { id: 'l' } : null) },
    collateralDocument: { findFirst: async ({ where }: { where: { fileId: string; collateral: { applicationId: string } } }) => (where.collateral.applicationId === APP.id && where.fileId === FILE.collateralDoc ? { id: 'd' } : null) },
    collateral: { findMany: async ({ where }: { where: { applicationId: string } }) => (where.applicationId === APP.id ? [{ id: 'col-1' }] : []) },
  } as unknown as PrismaService;
  const documents = { list: async () => { calls.documents += 1; return [{ fileId: FILE.dmsDoc } as DocumentView]; } } as unknown as DmsDocumentsPort;
  const valuation = { history: async () => { calls.valuation += 1; return { items: [{ reportFileId: FILE.valuationReport }] }; } } as unknown as ValuationPort;
  const store: ApplicationFileStorePort = { fetch: async (_c, id) => { calls.fetched.push(id); return { name: 'f.pdf', mime: 'application/pdf', content: Buffer.from(id) } satisfies StoredFile; } };
  const service = new ApplicationFileService(prisma, new ApplicationAccessService(prisma), documents, valuation, store);
  return { service, calls };
}

describe('ApplicationFileService.open — файл тэр хүсэлтэд холбогдсон байх ёстой (NFR-3)', () => {
  it.each([
    ['үүсгэсэн гэрээ', FILE.contract],
    ['гарын үсэгтэй гэрээ', FILE.signed],
    ['албан бичиг', FILE.letter],
    ['барьцааны баримт', FILE.collateralDoc],
    ['dms баримт', FILE.dmsDoc],
    ['үнэлгээний тайлан', FILE.valuationReport],
  ])('%s: хүсэлтийн эзэнд файлыг өгнө', async (_name, fileId) => {
    const { service, calls } = build();
    const file = await service.open(ctx(['OFFICER']), APP.id, fileId);
    expect(file.content.toString()).toBe(fileId);
    expect(calls.fetched).toEqual([fileId]);
  });

  it('өөр хүсэлтийн (холбоогүй) файлын id → 404 FILE_NOT_FOUND, dms-ээс татахгүй', async () => {
    const { service, calls } = build();
    await expect(service.open(ctx(['ADMIN']), APP.id, FILE.foreign)).rejects.toMatchObject({ response: { code: 'FILE_NOT_FOUND' } });
    await expect(service.open(ctx(['ADMIN']), APP.id, FILE.foreign)).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.fetched).toEqual([]);
  });

  it('буруу хэлбэрийн id → 404, ямар ч дуудлага хийхгүй', async () => {
    const { service, calls } = build();
    for (const bad of ['../etc/passwd', 'x', '', `${FILE.contract}/../${FILE.signed}`]) {
      await expect(service.open(ctx(['ADMIN']), APP.id, bad)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(calls).toEqual({ documents: 0, valuation: 0, fetched: [] });
  });

  it('өөрийн DB-ээс олдвол dms/valuation-ийг дуудахгүй; dms баримтаар олдвол valuation-ийг дуудахгүй', async () => {
    const own = build();
    await own.service.open(ctx(['OFFICER']), APP.id, FILE.contract);
    expect(own.calls).toMatchObject({ documents: 0, valuation: 0 });
    const dms = build();
    await dms.service.open(ctx(['OFFICER']), APP.id, FILE.dmsDoc);
    expect(dms.calls).toMatchObject({ documents: 1, valuation: 0 });
  });
});

describe('ApplicationFileService.open — хүсэлтэд хандах эрх (салбар/хариуцагч)', () => {
  it('өөр ЗЭЗ → 403, файлын холбоо шалгахгүй, татахгүй', async () => {
    const { service, calls } = build();
    await expect(service.open(ctx(['OFFICER'], { userId: 'officer-2' }), APP.id, FILE.contract)).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toEqual({ documents: 0, valuation: 0, fetched: [] });
  });

  it('өөр салбарын захирал → 403; өөрийн салбарын захирал, батлагч, админ → зөвшөөрнө', async () => {
    const { service } = build();
    await expect(service.open(ctx(['BRANCH_MANAGER'], { userId: 'm-2', branchId: 'branch-2' }), APP.id, FILE.contract)).rejects.toBeInstanceOf(ForbiddenException);
    for (const c of [ctx(['BRANCH_MANAGER'], { userId: 'm-1', branchId: 'branch-1' }), ctx(['APPROVER'], { userId: 'a-1' }), ctx(['ADMIN'], { userId: 'x' })]) {
      await expect(service.open(c, APP.id, FILE.contract)).resolves.toMatchObject({ name: 'f.pdf' });
    }
  });

  it('өөр байгууллага эсвэл байхгүй хүсэлт → 404 APPLICATION_NOT_FOUND', async () => {
    const { service } = build();
    await expect(service.open(ctx(['ADMIN'], { orgId: 'org-2' }), APP.id, FILE.contract)).rejects.toMatchObject({ response: { code: 'APPLICATION_NOT_FOUND' } });
    await expect(service.open(ctx(['ADMIN']), 'missing', FILE.contract)).rejects.toMatchObject({ response: { code: 'APPLICATION_NOT_FOUND' } });
  });
});

describe('ApplicationFileController route', () => {
  it('AppModule-д залгагдсан: жинхэнэ DI граф ApplicationFileService-ийг шийднэ (DB шаардахгүй)', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(mod.get(ApplicationFileService)).toBeInstanceOf(ApplicationFileService);
    await mod.close();
  }, 60_000);

  it('харилцагчийн контекстийг зөвшөөрөөгүй (глобал guard CUSTOMER_CONTEXT_FORBIDDEN), application:read шаардана, нийтийн биш', async () => {
    const routes = await collectRoutes(ApplicationFileModule);
    expect(routes.map((r) => ({ key: routeKey(r), customerContext: r.customerContext, permissions: r.permissions, isPublic: r.isPublic }))).toEqual([
      { key: 'GET /api/applications/:applicationId/files/:fileId/content', customerContext: false, permissions: ['application:read'], isPublic: false },
    ]);
  });
});

describe('GET /api/applications/:applicationId/files/:fileId/content (HTTP)', () => {
  let app: INestApplication;
  const H = (userId: string, roles: string, extra: Record<string, string> = {}) => ({ 'X-User-Id': userId, 'X-Roles': roles, 'X-Branch-Id': 'branch-1', 'X-Org-Id': ORG, ...extra });
  const url = (fileId: string) => `/api/applications/${APP.id}/files/${fileId}/content`;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [CommonModule.forRoot()],
      controllers: [ApplicationFileController],
      providers: [{ provide: ApplicationFileService, useFactory: () => build().service }],
    }).compile();
    app = mod.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(() => app.close());

  it('401 without identity', async () => {
    expect((await http().get(url(FILE.contract))).status).toBe(401);
  });

  it('200: байт + аюулгүй толгой (attachment, nosniff, no-store)', async () => {
    const res = await http().get(url(FILE.contract)).set(H('officer-1', 'OFFICER')).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe(FILE.contract);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''f.pdf");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('холбоогүй файл → 404 FILE_NOT_FOUND; өөр ЗЭЗ → 403; харилцагчийн контекст → 403 CUSTOMER_CONTEXT_FORBIDDEN', async () => {
    const foreign = await http().get(url(FILE.foreign)).set(H('officer-1', 'OFFICER'));
    expect([foreign.status, foreign.body.code]).toEqual([404, 'FILE_NOT_FOUND']);
    expect((await http().get(url(FILE.contract)).set(H('officer-2', 'OFFICER'))).status).toBe(403);
    const customer = await http().get(url(FILE.contract)).set(H('cust', 'CUSTOMER', { 'X-Customer-Id': 'cust-1' }));
    expect([customer.status, customer.body.code]).toEqual([403, 'CUSTOMER_CONTEXT_FORBIDDEN']);
  });
});
