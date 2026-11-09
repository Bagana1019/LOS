import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApplication, hasTestDb } from '../../test-utils/factories';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { LoanTermsModule } from '../loan-terms/loan-terms.module';
import { ProductModule } from './product.module';

// Бүтээгдэхүүний админ (Q-124 хэв маяг): санал → өөр хэрэглэгч батлах → хэрэгжинэ; устгахгүй, идэвхгүй болгоно; хүсэлтүүд эвдрэхгүй.
// Тест бүр өвөрмөц org (change_request append-only, нэг зорилтод нэг PENDING).
let ORG = 'org-prod';
let seq = 0;
const h = (roles: string, userId = 'u-1') => ({ 'x-user-id': userId, 'x-roles': roles, 'x-org-id': ORG });
const admin = () => h('ADMIN', 'admin-prod');
const checker = () => h('ADMIN', 'admin-prod-checker');
const REASON = 'Шинэ бүтээгдэхүүний тест';
const product = (over: Record<string, unknown> = {}) => ({
  code: 'SME_PLUS', productType: 'BUSINESS', currency: 'MNT', name: 'ЖДҮ+ зээл',
  minAmount: 1_000_000, maxAmount: 80_000_000, minTerm: 3, maxTerm: 36, minRate: 20, maxRate: 38, defaultFeeRate: 0.0125,
  requiresCollateral: true, maxLtv: 0.65, maxDti: 0.5, minDscr: 1.2, calcWeightThreshold: 0.7,
  documentChecklist: [{ key: 'application_form', name: 'Хүсэлтийн маягт', required: true }],
  haircut: { VEHICLE: 0.7, LAND: 0.6 }, externalValuationThreshold: 50_000_000, ...over,
});
const { code: _c, productType: _t, currency: _cur, ...editable } = product();

describe.skipIf(!hasTestDb)('product admin API (DB)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());
  beforeAll(async () => { t = await createTestApp([ProductModule, LoanTermsModule]); });
  afterAll(async () => { await t.close(); });
  beforeEach(() => { ORG = `org-prod-${process.pid}-${++seq}`; });

  const pending = (res: { status: number; body: { outcome: string; request: { id: string } } }) => { expect(res.status).toBe(202); expect(res.body.outcome).toBe('PENDING'); return res.body.request.id; };
  const approve = async (id: string, who = checker()) => { const r = await http().post(`/api/maker-checker/requests/${id}/approve`).set(who).send({}); expect(r.status).toBe(200); return r.body; };
  const create = async () => {
    const id = pending(await http().post('/api/products').set(admin()).send({ reason: REASON, product: product() }));
    await approve(id);
    return (await http().get('/api/products').set(admin())).body.find((p: { code: string }) => p.code === 'SME_PLUS') as { id: string; isActive: boolean; maxAmount: number; updatedAt: string };
  };

  it('үүсгэх: санал илгээхэд бүтээгдэхүүн үүсэхгүй; өөрөө батлахыг хориглоно; өөр ADMIN батлахад үүсч аудит + SettingsChanged', async () => {
    const id = pending(await http().post('/api/products').set(admin()).set('x-correlation-id', 'corr-pr-1').send({ reason: REASON, product: product() }));
    expect((await http().get('/api/products').set(admin())).body).toHaveLength(0);
    const self = await http().post(`/api/maker-checker/requests/${id}/approve`).set(admin()).send({});
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await approve(id)).status).toBe('APPLIED');

    const list = (await http().get('/api/products').set(admin())).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: 'SME_PLUS', isActive: true, maxLtv: 0.65, defaultFeeRate: 0.0125, applicationCount: 0, haircut: { VEHICLE: 0.7, LAND: 0.6 } });
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { orgId: ORG, action: 'PRODUCT_CREATED' } });
    expect(audit.actorId).toBe('admin-prod-checker');
    expect(audit.afterJson).toMatchObject({ code: 'SME_PLUS', makerId: 'admin-prod', checkerId: 'admin-prod-checker', changeRequestId: id });
    const ev = await t.prisma.outbox.findMany({ where: { type: 'SettingsChanged' } });
    expect(ev.some((e) => (e.payload as { key?: string; correlationId?: string }).key === 'product' && (e.payload as { correlationId?: string }).correlationId === 'corr-pr-1')).toBe(true);
    // зээлийн хүсэлтийн сонгох жагсаалтад гарна
    expect((await http().get('/api/loan-terms/products').set(h('OFFICER'))).body.items.map((p: { code: string }) => p.code)).toContain('SME_PLUS');
  });

  it('үүсгэх: хүрээ/нэгж шалгагдана (400), давхар код 422, ADMIN биш 403, шалтгаан заавал', async () => {
    for (const bad of [{ minAmount: 90_000_000 }, { minTerm: 40 }, { minRate: 50 }, { maxLtv: 1.5 }, { maxLtv: null }, { code: 'bad code' }, { haircut: { BOAT: 0.5 } }, { documentChecklist: [{ key: 'a', name: 'A' }, { key: 'A', name: 'B' }] }]) {
      expect((await http().post('/api/products').set(admin()).send({ reason: REASON, product: product(bad) })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await http().post('/api/products').set(admin()).send({ product: product() })).status).toBe(400);
    for (const roles of ['OFFICER', 'BRANCH_MANAGER', 'APPROVER']) {
      expect((await http().get('/api/products').set(h(roles))).status).toBe(403);
      expect((await http().post('/api/products').set(h(roles)).send({ reason: REASON, product: product() })).status).toBe(403);
    }
    await create();
    const dup = await http().post('/api/products').set(admin()).send({ reason: REASON, product: product() });
    expect(dup.status).toBe(422);
    expect(await t.prisma.changeRequest.count({ where: { orgId: ORG, status: 'PENDING' } })).toBe(0);
  });

  it('засах: батлагдтал хуучин утга хэвээр; батлахад шинэчлэгдэж before/after аудит; код/төрөл өөрчлөгдөхгүй; хуучирсан санал FAILED', async () => {
    const p = await create();
    const body = { reason: 'Дээд дүнг нэмэгдүүлэх', product: { ...editable, maxAmount: 120_000_000, maxLtv: 0.6 } };
    const id = pending(await http().put(`/api/products/${p.id}`).set(admin()).send(body));
    expect((await http().get(`/api/products/${p.id}`).set(admin())).body.maxAmount).toBe(80_000_000);
    const detail = (await http().get(`/api/maker-checker/requests/${id}`).set(checker())).body;
    expect(detail.before.maxAmount).toBe(80_000_000);
    await approve(id);
    const after = (await http().get(`/api/products/${p.id}`).set(admin())).body;
    expect(after).toMatchObject({ maxAmount: 120_000_000, maxLtv: 0.6, code: 'SME_PLUS', productType: 'BUSINESS' });
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { orgId: ORG, action: 'PRODUCT_UPDATED' } });
    expect((audit.beforeJson as { maxAmount: number }).maxAmount).toBe(80_000_000);
    expect((audit.afterJson as { maxAmount: number }).maxAmount).toBe(120_000_000);

    // Санал хүлээж байхад өөр зүйл засагдвал батлахад FAILED (MC-BR-7)
    const id2 = pending(await http().put(`/api/products/${p.id}`).set(admin()).send({ reason: 'Хугацаа', product: { ...editable, maxTerm: 48 } }));
    await t.prisma.product.update({ where: { id: p.id }, data: { name: 'Гараар өөрчилсөн' } });
    const stale = await http().post(`/api/maker-checker/requests/${id2}/approve`).set(checker()).send({});
    expect(stale.body.status ?? stale.body.code).toMatch(/FAILED|STALE_TARGET/);
    expect((await http().get(`/api/products/${p.id}`).set(admin())).body.maxTerm).toBe(36);
    expect((await http().put('/api/products/nope').set(admin()).send({ reason: REASON, product: editable })).status).toBe(404);
  });

  it('идэвхгүй болгох: устгахгүй — хүсэлт хэвээр, шинэ нөхцөл сонгох жагсаалтаас гарна; дахин идэвхжүүлнэ; сүүлчийн идэвхтэйг хориглоно', async () => {
    const p = await create();
    const other = await t.prisma.product.create({ data: { orgId: ORG, code: 'OTHER', name: 'Бусад', productType: 'CONSUMER', minAmount: 1, maxAmount: 1e9, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40 } });
    const app = await createApplication(t.prisma, { orgId: ORG, productId: p.id, createdBy: 'o' });
    const id = pending(await http().post(`/api/products/${p.id}/active`).set(admin()).send({ reason: 'Зогсоох', isActive: false }));
    expect((await http().get('/api/loan-terms/products').set(h('OFFICER'))).body.items).toHaveLength(2);
    await approve(id);
    expect((await http().get('/api/loan-terms/products').set(h('OFFICER'))).body.items.map((x: { code: string }) => x.code)).toEqual(['OTHER']);
    const listed = (await http().get('/api/products').set(admin())).body.find((x: { code: string }) => x.code === 'SME_PLUS');
    expect(listed).toMatchObject({ isActive: false, applicationCount: 1 }); // жагсаалтад үлдэнэ
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).productId).toBe(p.id);
    expect(await t.prisma.auditLog.count({ where: { orgId: ORG, action: 'PRODUCT_DEACTIVATED' } })).toBe(1);
    expect((await http().delete(`/api/products/${p.id}`).set(admin())).status).toBe(404); // устгах endpoint байхгүй

    const already = await http().post(`/api/products/${p.id}/active`).set(admin()).send({ reason: 'Дахин', isActive: false });
    expect(already.status).toBe(422);
    await approve(pending(await http().post(`/api/products/${p.id}/active`).set(admin()).send({ reason: 'Дахин нээх', isActive: true })));
    expect((await http().get('/api/loan-terms/products').set(h('OFFICER'))).body.items).toHaveLength(2);

    await t.prisma.product.update({ where: { id: other.id }, data: { isActive: false } });
    const last = await http().post(`/api/products/${p.id}/active`).set(admin()).send({ reason: 'Зогсоох', isActive: false });
    expect(last.status).toBe(422); // энэ org-д сүүлчийн идэвхтэй бүтээгдэхүүн
  });
});
