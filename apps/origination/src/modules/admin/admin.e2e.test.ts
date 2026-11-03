import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApplication, hasTestDb } from '../../test-utils/factories';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { SettingsModule } from '../settings/settings.module';
import { AdminModule } from './admin.module';

// M13 · Админ: батлах түвшин (BR-13), гэрээний дугаарын загвар (BR-11), салбарын код (BR-11), аудит лог (FR-13.5).
// Тусдаа org ('org-m13') — бусад тестийн approval_level / setting-тэй зөрчилдөхгүй.
const ORG = 'org-m13';
const h = (roles: string, userId = 'u-1') => ({ 'x-user-id': userId, 'x-roles': roles, 'x-org-id': ORG });
const admin = h('ADMIN', 'admin-m13');
const levels = (over: Array<Record<string, unknown>> = []) => ({
  levels: [
    { levelNo: 1, name: 'Салбар', amountFrom: 0, amountTo: 5_000_000, slaHours: 24, members: [{ userId: 'bm-1' }], ...over[0] },
    { levelNo: 2, name: 'Төв', amountFrom: 5_000_000, amountTo: 30_000_000, slaHours: 24, members: [{ userId: 'ap-1' }], ...over[1] },
    { levelNo: 3, name: 'Хороо', amountFrom: 30_000_000, amountTo: null, slaHours: 48, members: [{ userId: 'ap-1' }, { userId: 'ap-2' }], ...over[2] },
  ],
});

describe.skipIf(!hasTestDb)('admin API (DB)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());
  const clean = async () => {
    await t.prisma.approvalRequest.deleteMany({ where: { orgId: ORG } });
    await t.prisma.approvalLevel.deleteMany({ where: { orgId: ORG } });
    await t.prisma.contractNumberTemplate.deleteMany({ where: { orgId: ORG } });
    await t.prisma.setting.deleteMany({ where: { orgId: ORG } });
    await t.prisma.auditLog.deleteMany({ where: { orgId: ORG } });
  };
  beforeAll(async () => { t = await createTestApp([AdminModule, SettingsModule]); });
  afterAll(async () => { await clean(); await t.close(); });
  beforeEach(clean);

  it('батлах түвшин: зөвхөн ADMIN, босго шатлал шалгагдана (завсар/давхцал/сүүлийнх хязгааргүй)', async () => {
    for (const roles of ['OFFICER', 'BRANCH_MANAGER', 'APPROVER']) {
      expect((await http().get('/api/approval-levels').set(h(roles))).status).toBe(403);
      expect((await http().put('/api/approval-levels').set(h(roles)).send(levels())).status).toBe(403);
    }
    const gap = await http().put('/api/approval-levels').set(admin).send(levels([{}, { amountFrom: 6_000_000 }]));
    expect(gap.status).toBe(422);
    expect(gap.body.code).toBe('APPROVAL_LEVELS_INVALID');
    expect((await http().put('/api/approval-levels').set(admin).send(levels([{}, {}, { amountTo: 99 }]))).status).toBe(422);
    expect((await http().put('/api/approval-levels').set(admin).send(levels([{ amountFrom: 100 }]))).status).toBe(422);
    expect((await http().put('/api/approval-levels').set(admin).send(levels([{ members: [{ userId: 'x' }, { userId: 'x' }] }]))).status).toBe(422);
    expect(await t.prisma.approvalLevel.count({ where: { orgId: ORG } })).toBe(0);
  });

  it('батлах түвшин: бүхэлд нь солигдож, аудит (before/after) + SettingsChanged outbox нэг транзакцид', async () => {
    const saved = await http().put('/api/approval-levels').set(admin).set('x-correlation-id', 'corr-lv-1').send(levels());
    expect(saved.status).toBe(200);
    expect(saved.body.map((l: { levelNo: number }) => l.levelNo)).toEqual([1, 2, 3]);
    expect(saved.body[2]).toMatchObject({ amountTo: null, slaHours: 48, members: [{ userId: 'ap-1' }, { userId: 'ap-2' }] });

    const next = levels([{ amountTo: 3_000_000 }, { amountFrom: 3_000_000, members: [{ userId: 'ap-9' }] }]);
    const res = await http().put('/api/approval-levels').set(admin).set('x-correlation-id', 'corr-lv-2').send(next);
    expect(res.status).toBe(200);
    expect(res.body[0].amountTo).toBe(3_000_000);
    expect(res.body[1].members).toEqual([{ userId: 'ap-9' }]);
    expect((await http().get('/api/approval-levels').set(admin)).body).toHaveLength(3);

    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { orgId: ORG, correlationId: 'corr-lv-2' } });
    expect(audit.action).toBe('APPROVAL_LEVELS_REPLACED');
    expect((audit.beforeJson as { levels: Array<{ amountTo: number }> }).levels[0]!.amountTo).toBe(5_000_000);
    expect((audit.afterJson as { levels: Array<{ amountTo: number }> }).levels[0]!.amountTo).toBe(3_000_000);
    const ev = await t.prisma.outbox.findMany({ where: { type: 'SettingsChanged' } });
    expect(ev.some((e) => (e.payload as { key?: string; correlationId?: string }).key === 'approval.levels' && (e.payload as { correlationId?: string }).correlationId === 'corr-lv-2')).toBe(true);
  });

  it('шийдвэр хүлээж буй батлах хүсэлт байвал солихгүй (409), өмнөх түвшин хэвээр', async () => {
    await http().put('/api/approval-levels').set(admin).send(levels()).expect(200);
    const product = await t.prisma.product.create({ data: { orgId: ORG, code: 'M13', name: 'M13', productType: 'CONSUMER', minAmount: 1, maxAmount: 1e9, minTerm: 1, maxTerm: 36, minRate: 0.1, maxRate: 0.4 } });
    const a = await createApplication(t.prisma, { productId: product.id, orgId: ORG, createdBy: 'o' });
    await t.prisma.approvalRequest.create({ data: { orgId: ORG, applicationId: a.id, version: 1, levelNo: 1, status: 'PENDING' } });
    const res = await http().put('/api/approval-levels').set(admin).send(levels([{ name: 'Шинэ' }]));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('APPROVALS_IN_FLIGHT');
    expect((await http().get('/api/approval-levels').set(admin)).body[0].name).toBe('Салбар');
    await t.prisma.approvalRequest.deleteMany({ where: { orgId: ORG } });
    await t.prisma.loanApplication.deleteMany({ where: { orgId: ORG } });
    await t.prisma.product.deleteMany({ where: { orgId: ORG } });
  });

  it('гэрээний дугаарын загвар: {SEQ} заавал, шинэчилж аудитлана, тоолуур хадгалагдана', async () => {
    expect((await http().get('/api/contract-number-template').set(admin)).body).toMatchObject({ id: null, prefix: 'B' }); // тохируулаагүй → санал болгох анхдагч
    expect((await http().put('/api/contract-number-template').set(admin).send({ pattern: '{PREFIX}{BRANCH}', prefix: 'B', seqScope: 'DAY' })).status).toBe(400);
    expect((await http().put('/api/contract-number-template').set(h('OFFICER')).send({ pattern: '{PREFIX}{SEQ:3}', prefix: 'B', seqScope: 'DAY' })).status).toBe(403);
    const first = await http().put('/api/contract-number-template').set(admin).send({ pattern: '{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', prefix: 'B', seqScope: 'DAY' });
    expect(first.status).toBe(200);
    const second = await http().put('/api/contract-number-template').set(admin).send({ pattern: '{PREFIX}-{SEQ:4}', prefix: 'LN', seqScope: 'GLOBAL' });
    expect(second.body).toMatchObject({ id: first.body.id, pattern: '{PREFIX}-{SEQ:4}', prefix: 'LN', seqScope: 'GLOBAL' });
    expect(await t.prisma.contractNumberTemplate.count({ where: { orgId: ORG } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { orgId: ORG, action: 'CONTRACT_TEMPLATE_UPDATED' } })).toBe(2);
  });

  it('салбарын код (contract.branch_codes): хадгалагдана, давхардсан код 422', async () => {
    const ok = await http().put('/api/settings/contract.branch_codes').set(admin).send({ value: { 'branch-a': '100', 'branch-b': '200' } });
    expect(ok.status).toBe(200);
    expect(ok.body.value).toEqual({ 'branch-a': '100', 'branch-b': '200' });
    const dup = await http().put('/api/settings/contract.branch_codes').set(admin).send({ value: { 'branch-a': 'ab1', 'branch-b': 'AB1' } });
    expect(dup.status).toBe(422);
    expect(dup.body.code).toBe('BRANCH_CODE_DUPLICATE');
    expect((await http().get('/api/settings/contract.branch_codes').set(admin)).body.value).toEqual({ 'branch-a': '100', 'branch-b': '200' });
  });

  it('аудит лог: зөвхөн audit:read (ADMIN), шүүлт + хуудаслалт, өөр org-ийн мөр харагдахгүй', async () => {
    await http().put('/api/settings/inquiry.stale_days').set(admin).send({ value: 40 }).expect(200);
    await http().put('/api/settings/inquiry.stale_days').set(admin).send({ value: 41 }).expect(200);
    await t.prisma.auditLog.create({ data: { orgId: 'org-other', entity: 'SETTING', entityId: 'x', action: 'SETTING_UPDATED' } });
    expect((await http().get('/api/audit-logs').set(h('OFFICER'))).status).toBe(403);
    const all = await http().get('/api/audit-logs').set(admin);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items[0].afterJson).toEqual({ value: 41 }); // шинэ нь эхэнд
    const page = await http().get('/api/audit-logs').query({ pageSize: 1, page: 2, entity: 'SETTING', entityId: 'inquiry.stale_days' }).set(admin);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].afterJson).toEqual({ value: 40 });
    expect((await http().get('/api/audit-logs').query({ action: 'NOPE' }).set(admin)).body.total).toBe(0);
    await t.prisma.auditLog.deleteMany({ where: { orgId: 'org-other' } });
  });
});
