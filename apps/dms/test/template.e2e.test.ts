import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ContractTemplateView, RenderTemplateResponse } from '@los/contracts';
import { SEED } from '@los/database';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { demoLoanContractDocx } from '../src/modules/template/demo-template';
import { extractTextRuns } from '../src/modules/esign/pdf/pdf-inspect';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const as = (u: keyof typeof SEED.users) => ({ 'x-user-id': SEED.users[u].id, 'x-roles': SEED.users[u].roles.join(','), 'x-org-id': SEED.org.id, 'x-correlation-id': 'corr-tpl-1' });
const schedule = Array.from({ length: 36 }, (_, i) => ({ no: i + 1, due_date: '2026-12-05', principal: '700,000', interest: '476,828', total: '1,176,828', balance: '1' }));

// FR-11.1/11.2 (M11 AC): загвараас гэрээ PDF — зээлдэгчийн нэр, дүн, ЭТХ-ийн хүснэгт орсон.
describe.skipIf(!HAS_DB)('dms templates (FR-11: /api/templates)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => { await db.contractTemplate.deleteMany({}); });

  const upload = (who: keyof typeof SEED.users, fields: Record<string, string>, buf: Buffer = demoLoanContractDocx(), name = 'gereе.docx') => {
    let r = api().post('/api/templates').set(as(who));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', buf, { filename: name, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  };

  it('admin uploads a docx template: placeholders are read, version bumps, only the latest is active', async () => {
    const a = await upload('admin', { type: 'LOAN_CONTRACT', name: 'Гэрээ' }, demoLoanContractDocx(), 'a.docx');
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const v1 = ContractTemplateView.parse(a.body);
    expect(v1).toMatchObject({ version: 1, isActive: true, productId: null, unknownPlaceholders: [] });
    expect(v1.placeholders).toEqual(expect.arrayContaining(['contract_no', 'borrower_name', 'schedule']));
    const v2 = ContractTemplateView.parse((await upload('admin', { type: 'LOAN_CONTRACT', name: 'Гэрээ' }, demoLoanContractDocx(), 'b.docx')).body);
    expect(v2.version).toBe(2);
    const list = (await api().get('/api/templates?type=LOAN_CONTRACT').set(as('officerA'))).body.items as ContractTemplateView[];
    expect(list.filter((t) => t.isActive).map((t) => t.id)).toEqual([v2.id]);
    // rollback
    const back = await api().patch(`/api/templates/${v1.id}/active`).set(as('admin')).send({ isActive: true });
    expect(back.status).toBe(200);
    expect((await db.contractTemplate.findUniqueOrThrow({ where: { id: v2.id } })).isActive).toBe(false);
  });

  it('only admin manages templates; non-docx and broken docx are rejected', async () => {
    expect((await upload('officerA', { type: 'LOAN_CONTRACT', name: 'x' })).status).toBe(403);
    expect((await upload('admin', { type: 'LOAN_CONTRACT', name: 'x' }, Buffer.from('%PDF-1.7'), 'x.pdf')).status).toBe(415);
    const broken = await upload('admin', { type: 'LOAN_CONTRACT', name: 'x' }, Buffer.from('PK\u0003\u0004 not really a docx'), 'x.docx');
    expect([415, 422]).toContain(broken.status);
    expect(await db.contractTemplate.count()).toBe(0);
  });

  it('renders the contract: PDF contains the borrower name, amount and every schedule row', async () => {
    await upload('admin', { type: 'LOAN_CONTRACT', name: 'Гэрээ' });
    const res = await api().post('/api/templates/render').set(as('officerA')).send({
      type: 'LOAN_CONTRACT', fileBaseName: 'contract-C-1',
      data: { contract_no: 'C-2026-0001', borrower_name: 'Бат-Эрдэнэ Дорж', approved_amount: '30,000,000', currency: 'MNT', schedule },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const out = RenderTemplateResponse.parse(res.body);
    const pdf = await api().get(`/api/files/${out.pdfFileId}/content`).set(as('officerA')).buffer().parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const doc = await PDFDocument.load(pdf.body as Buffer);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    const text = doc.getPages().flatMap((p) => extractTextRuns(doc, p).map((r) => r.text)).join(' ');
    expect(text).toContain('Бат-Эрдэнэ Дорж');
    expect(text).toContain('30,000,000');
    expect(text).toContain('C-2026-0001');
    expect((text.match(/1,176,828/g) ?? []).length).toBeGreaterThanOrEqual(36);
    expect((await api().get(`/api/files/${out.docxFileId}`).set(as('officerA'))).status).toBe(200);
  });

  it('no active template for the type → 422 TEMPLATE_NOT_CONFIGURED; product template wins over the generic one', async () => {
    const none = await api().post('/api/templates/render').set(as('officerA')).send({ type: 'OFFICIAL_LETTER', data: {} });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('TEMPLATE_NOT_CONFIGURED');
    await upload('admin', { type: 'LOAN_CONTRACT', name: 'Нийтлэг' });
    const prod = ContractTemplateView.parse((await upload('admin', { type: 'LOAN_CONTRACT', name: 'Бүтээгдэхүүн', productId: SEED.products.consumer })).body);
    const r1 = RenderTemplateResponse.parse((await api().post('/api/templates/render').set(as('officerA')).send({ type: 'LOAN_CONTRACT', productId: SEED.products.consumer, data: {} })).body);
    expect(r1.templateId).toBe(prod.id);
    const r2 = RenderTemplateResponse.parse((await api().post('/api/templates/render').set(as('officerA')).send({ type: 'LOAN_CONTRACT', productId: SEED.products.vehicle, data: {} })).body);
    expect(r2.templateId).not.toBe(prod.id);
  });

  it('installs DEMO templates idempotently', async () => {
    expect((await api().post('/api/templates/demo').set(as('admin'))).body.installed).toHaveLength(2);
    expect((await api().post('/api/templates/demo').set(as('admin'))).body.installed).toHaveLength(0);
    expect((await api().get('/api/templates/placeholders').set(as('officerA'))).body.items.length).toBeGreaterThan(20);
  });
});
