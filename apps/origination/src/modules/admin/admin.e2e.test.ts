import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApplication, hasTestDb } from '../../test-utils/factories';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { SettingsModule } from '../settings/settings.module';
import { AdminModule } from './admin.module';

// M13 · Админ: батлах түвшин (BR-13), гэрээний дугаарын загвар (BR-11), салбарын код (BR-11), аудит лог (FR-13.5).
// Q-124: батлах түвшин, салбарын код, батлах SLA нь 4 нүдээр (Maker-Checker) — санал → өөр хэрэглэгч батлах → хэрэгжинэ.
// Тест бүр өвөрмөц org — change_request/history нь append-only (устгагдахгүй), нэг зорилтод нэг PENDING (MC-BR-5).
let ORG = 'org-m13';
let seq = 0;
const h = (roles: string, userId = 'u-1') => ({ 'x-user-id': userId, 'x-roles': roles, 'x-org-id': ORG });
const admin = () => h('ADMIN', 'admin-m13');
const checker = () => h('ADMIN', 'admin-m13-checker');
const approver = () => h('APPROVER', 'approver-m13');
const REASON = 'Q-124 тест: босго шинэчлэх';
const levels = (over: Array<Record<string, unknown>> = [], reason = REASON) => ({
  reason,
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
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { ORG = `org-m13-${process.pid}-${++seq}`; await clean(); });

  const pendingId = async (res: { status: number; body: { outcome: string; request: { id: string } } }) => { expect(res.status).toBe(202); expect(res.body.outcome).toBe('PENDING'); return res.body.request.id; };

  it('батлах түвшин (Q-124): санал илгээхэд өгөгдөл хөдлөхгүй; шалтгаан заавал; өөр хэрэглэгч батлахад л хэрэгжиж аудит (before/after) + SettingsChanged outbox', async () => {
    const noReason = await http().put('/api/approval-levels').set(admin()).send({ levels: levels().levels });
    expect(noReason.status).toBe(400);

    const id = await pendingId(await http().put('/api/approval-levels').set(admin()).set('x-correlation-id', 'corr-lv-1').send(levels()));
    expect((await http().get('/api/approval-levels').set(admin())).body).toHaveLength(0); // батлагдтал хэрэгжээгүй
    expect(await t.prisma.auditLog.count({ where: { orgId: ORG, action: 'APPROVAL_LEVELS_REPLACED' } })).toBe(0);

    // MC-BR-1: санал гаргагч өөрөө батлах боломжгүй (ADMIN ч)
    const self = await http().post(`/api/maker-checker/requests/${id}/approve`).set(admin()).send({});
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await http().get('/api/approval-levels').set(admin())).body).toHaveLength(0);

    // Өөр ADMIN батлахад нэг tx-д хэрэгжинэ
    const ok = await http().post(`/api/maker-checker/requests/${id}/approve`).set(checker()).set('x-correlation-id', 'corr-lv-1b').send({ comment: 'зөвшөөрөв' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APPLIED');
    const saved = (await http().get('/api/approval-levels').set(admin())).body;
    expect(saved.map((l: { levelNo: number }) => l.levelNo)).toEqual([1, 2, 3]);
    expect(saved[2]).toMatchObject({ amountTo: null, slaHours: 48, members: expect.arrayContaining([{ userId: 'ap-1' }, { userId: 'ap-2' }]) });

    // Хоёр дахь өөрчлөлт: APPROVER дүртэй хэрэглэгч батална; аудитад maker + checker үлдэнэ
    const next = levels([{ amountTo: 3_000_000 }, { amountFrom: 3_000_000, members: [{ userId: 'ap-9' }] }]);
    const id2 = await pendingId(await http().put('/api/approval-levels').set(admin()).send(next));
    const before = (await http().get(`/api/maker-checker/requests/${id2}`).set(approver())).body;
    expect(before.before.levels[0].amountTo).toBe(5_000_000); // diff-д өмнөх төлөв
    expect(before.payload.levels[0].amountTo).toBe(3_000_000);
    expect((await http().post(`/api/maker-checker/requests/${id2}/approve`).set(approver()).set('x-correlation-id', 'corr-lv-2').send({})).status).toBe(200);
    const after = (await http().get('/api/approval-levels').set(admin())).body;
    expect(after[0].amountTo).toBe(3_000_000);
    expect(after[1].members).toEqual([{ userId: 'ap-9' }]);

    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { orgId: ORG, action: 'APPROVAL_LEVELS_REPLACED', correlationId: 'corr-lv-1' } });
    expect(audit.actorId).toBe('admin-m13-checker');
    const audit2 = await t.prisma.auditLog.findFirstOrThrow({ where: { orgId: ORG, action: 'APPROVAL_LEVELS_REPLACED' }, orderBy: { at: 'desc' } });
    expect((audit2.beforeJson as { levels: Array<{ amountTo: number }> }).levels[0]!.amountTo).toBe(5_000_000);
    expect(audit2.afterJson).toMatchObject({ makerId: 'admin-m13', checkerId: 'approver-m13', changeRequestId: id2 });
    expect((audit2.afterJson as { levels: Array<{ amountTo: number }> }).levels[0]!.amountTo).toBe(3_000_000);
    const ev = await t.prisma.outbox.findMany({ where: { type: 'SettingsChanged' } });
    expect(ev.some((e) => (e.payload as { key?: string; correlationId?: string }).key === 'approval.levels' && (e.payload as { correlationId?: string }).correlationId === 'corr-lv-1')).toBe(true);
  });

  it('батлах түвшин (Q-124): татгалзвал / цуцалбал хэрэгжихгүй; нэг зорилтод нэг PENDING (409); эрхгүй дүр 403', async () => {
    for (const roles of ['OFFICER', 'BRANCH_MANAGER', 'APPROVER']) {
      expect((await http().get('/api/approval-levels').set(h(roles))).status).toBe(403);
      expect((await http().put('/api/approval-levels').set(h(roles)).send(levels())).status).toBe(403);
    }
    const id = await pendingId(await http().put('/api/approval-levels').set(admin()).send(levels()));
    const dup = await http().put('/api/approval-levels').set(admin()).send(levels([{ name: 'Өөр' }]));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('TARGET_HAS_PENDING_CHANGE');
    expect((await http().post(`/api/maker-checker/requests/${id}/reject`).set(checker()).send({})).status).toBe(400); // тайлбар заавал
    const rej = await http().post(`/api/maker-checker/requests/${id}/reject`).set(checker()).send({ comment: 'Босго өндөр байна' });
    expect(rej.body.status).toBe('REJECTED');
    expect(await t.prisma.approvalLevel.count({ where: { orgId: ORG } })).toBe(0);

    const id2 = await pendingId(await http().put('/api/approval-levels').set(admin()).send(levels()));
    expect((await http().post(`/api/maker-checker/requests/${id2}/cancel`).set(admin()).send({})).body.status).toBe('CANCELLED');
    expect(await t.prisma.approvalLevel.count({ where: { orgId: ORG } })).toBe(0);
  });

  it('батлах түвшин (Q-124): босго шатлал шалгагдана (завсар/давхцал/сүүлийнх хязгааргүй) — санал үүсэхгүй', async () => {
    const gap = await http().put('/api/approval-levels').set(admin()).send(levels([{}, { amountFrom: 6_000_000 }]));
    expect(gap.status).toBe(422);
    expect(gap.body.code).toBe('APPROVAL_LEVELS_INVALID');
    expect((await http().put('/api/approval-levels').set(admin()).send(levels([{}, {}, { amountTo: 99 }]))).status).toBe(422);
    expect((await http().put('/api/approval-levels').set(admin()).send(levels([{ amountFrom: 100 }]))).status).toBe(422);
    expect((await http().put('/api/approval-levels').set(admin()).send(levels([{ members: [{ userId: 'x' }, { userId: 'x' }] }]))).status).toBe(422);
    expect(await t.prisma.changeRequest.count({ where: { orgId: ORG } })).toBe(0);
  });

  it('батлах түвшин (Q-124): шийдвэр хүлээж буй батлах хүсэлт байвал санал үүсэхгүй (422); санал хүлээж байх хооронд хүсэлт гарвал батлахад FAILED', async () => {
    const product = await t.prisma.product.create({ data: { orgId: ORG, code: 'M13', name: 'M13', productType: 'CONSUMER', minAmount: 1, maxAmount: 1e9, minTerm: 1, maxTerm: 36, minRate: 0.1, maxRate: 0.4 } });
    const a = await createApplication(t.prisma, { productId: product.id, orgId: ORG, createdBy: 'o' });
    const ar = await t.prisma.approvalRequest.create({ data: { orgId: ORG, applicationId: a.id, version: 1, levelNo: 1, status: 'PENDING' } });
    const blocked = await http().put('/api/approval-levels').set(admin()).send(levels());
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('PAYLOAD_INVALID');
    expect(JSON.stringify(blocked.body)).toContain('батлах хүсэлт');

    await t.prisma.approvalRequest.delete({ where: { id: ar.id } });
    const id = await pendingId(await http().put('/api/approval-levels').set(admin()).send(levels()));
    await t.prisma.approvalRequest.create({ data: { orgId: ORG, applicationId: a.id, version: 2, levelNo: 1, status: 'PENDING' } });
    const res = await http().post(`/api/maker-checker/requests/${id}/approve`).set(checker()).send({});
    expect(res.status).toBe(409);
    expect((await http().get(`/api/maker-checker/requests/${id}`).set(admin())).body.status).toBe('FAILED');
    expect(await t.prisma.approvalLevel.count({ where: { orgId: ORG } })).toBe(0);
    await t.prisma.approvalRequest.deleteMany({ where: { orgId: ORG } });
    await t.prisma.loanApplication.deleteMany({ where: { orgId: ORG } });
    await t.prisma.product.deleteMany({ where: { orgId: ORG } });
  });

  it('батлах түвшин (Q-124): maker-ийн харсан түвшин батлахаас өмнө өөрчлөгдсөн бол FAILED (MC-BR-7); policy идэвхгүй бол DIRECT (201) ба аудитлагдана', async () => {
    const id = await pendingId(await http().put('/api/approval-levels').set(admin()).send(levels()));
    // maker үүсгэх үед түвшин байхгүй (хоосон); дундаас өөр зам (DB) түвшин нэмчихлээ
    await t.prisma.approvalLevel.create({ data: { orgId: ORG, productId: null, levelNo: 1, name: 'Гаднаас', amountFrom: 0, amountTo: null, quorumType: 'MAJORITY', slaHours: 24 } });
    expect((await http().post(`/api/maker-checker/requests/${id}/approve`).set(checker()).send({})).status).toBe(409);
    expect((await http().get(`/api/maker-checker/requests/${id}`).set(admin())).body.status).toBe('FAILED');
    expect((await t.prisma.approvalLevel.findFirstOrThrow({ where: { orgId: ORG } })).name).toBe('Гаднаас');

    await t.prisma.makerCheckerPolicy.create({ data: { orgId: ORG, targetType: 'APPROVAL_LEVELS', action: 'REPLACE', enabled: false, checkerRoles: ['ADMIN'], expiresInHours: 1, createdBy: 'test', updatedBy: 'test' } });
    const direct = await http().put('/api/approval-levels').set(admin()).send(levels());
    expect(direct.status).toBe(201);
    expect(direct.body.outcome).toBe('APPLIED_DIRECT');
    expect((await http().get('/api/approval-levels').set(admin())).body).toHaveLength(3);
    expect(await t.prisma.auditLog.count({ where: { orgId: ORG, action: 'APPROVAL_LEVELS_REPLACED' } })).toBe(1);
  });

  it('гэрээний дугаарын загвар: {SEQ} заавал, шинэчилж аудитлана, тоолуур хадгалагдана', async () => {
    expect((await http().get('/api/contract-number-template').set(admin())).body).toMatchObject({ id: null, prefix: 'B' }); // тохируулаагүй → санал болгох анхдагч
    expect((await http().put('/api/contract-number-template').set(admin()).send({ pattern: '{PREFIX}{BRANCH}', prefix: 'B', seqScope: 'DAY' })).status).toBe(400);
    expect((await http().put('/api/contract-number-template').set(h('OFFICER')).send({ pattern: '{PREFIX}{SEQ:3}', prefix: 'B', seqScope: 'DAY' })).status).toBe(403);
    const first = await http().put('/api/contract-number-template').set(admin()).send({ pattern: '{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', prefix: 'B', seqScope: 'DAY' });
    expect(first.status).toBe(200);
    const second = await http().put('/api/contract-number-template').set(admin()).send({ pattern: '{PREFIX}-{SEQ:4}', prefix: 'LN', seqScope: 'GLOBAL' });
    expect(second.body).toMatchObject({ id: first.body.id, pattern: '{PREFIX}-{SEQ:4}', prefix: 'LN', seqScope: 'GLOBAL' });
    expect(await t.prisma.contractNumberTemplate.count({ where: { orgId: ORG } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { orgId: ORG, action: 'CONTRACT_TEMPLATE_UPDATED' } })).toBe(2);
  });

  it('салбарын код (contract.branch_codes) Q-124: 4 нүдээр хадгалагдана, давхардсан код 422, шалтгаангүй 400', async () => {
    const put = (value: unknown, reason?: string, who = admin()) => http().put('/api/settings/contract.branch_codes').set(who).send({ value, ...(reason ? { reason } : {}) });
    expect((await put({ 'branch-a': '100' })).status).toBe(400); // шалтгаан заавал (MC-BR-4)
    const dup = await put({ 'branch-a': 'ab1', 'branch-b': 'AB1' }, REASON);
    expect(dup.status).toBe(422);
    expect(dup.body.code).toBe('BRANCH_CODE_DUPLICATE');
    expect((await http().put('/api/settings/contract.branch_codes').set(h('OFFICER')).send({ value: {}, reason: REASON })).status).toBe(403);

    const res = await put({ 'branch-a': '100', 'branch-b': '200' }, REASON);
    expect(res.status).toBe(202);
    expect(res.body.request).toMatchObject({ targetType: 'SETTING', targetId: 'contract.branch_codes', status: 'PENDING' });
    expect((await http().get('/api/settings/contract.branch_codes').set(admin())).body.value).toEqual({}); // батлагдтал хэрэгжээгүй
    expect((await http().post(`/api/maker-checker/requests/${res.body.request.id}/approve`).set(admin()).send({})).status).toBe(403); // өөрөө батлахгүй
    const ok = await http().post(`/api/maker-checker/requests/${res.body.request.id}/approve`).set(checker()).send({});
    expect(ok.body.status).toBe('APPLIED');
    expect((await http().get('/api/settings/contract.branch_codes').set(admin())).body.value).toEqual({ 'branch-a': '100', 'branch-b': '200' });
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { orgId: ORG, entity: 'SETTING', entityId: 'contract.branch_codes' } });
    expect(audit.afterJson).toMatchObject({ value: { 'branch-a': '100', 'branch-b': '200' }, makerId: 'admin-m13', checkerId: 'admin-m13-checker' });
  });

  it('батлах SLA (approval.default_sla_hours) Q-124: 4 нүдээр; бусад тохиргоо өмнөх шигээ шууд (200)', async () => {
    const res = await http().put('/api/settings/approval.default_sla_hours').set(admin()).send({ value: 12, reason: REASON });
    expect(res.status).toBe(202);
    expect((await http().put('/api/settings/approval.default_sla_hours').set(admin()).send({ value: 'x', reason: REASON })).status).toBe(400); // схем
    await http().post(`/api/maker-checker/requests/${res.body.request.id}/reject`).set(approver()).send({ comment: 'Богино байна' }).expect(200);
    expect((await http().get('/api/settings/approval.default_sla_hours').set(admin())).body).toMatchObject({ value: 24, isDefault: true });
    // зорилтод хүлээгдэж буй хүсэлт байхгүй болсон тул дахин санал болгож болно, батлагдвал хэрэгжинэ
    const again = await http().put('/api/settings/approval.default_sla_hours').set(admin()).send({ value: 12, reason: REASON });
    await http().post(`/api/maker-checker/requests/${again.body.request.id}/approve`).set(approver()).send({}).expect(200);
    expect((await http().get('/api/settings/approval.default_sla_hours').set(admin())).body.value).toBe(12);
    // 4 нүдгүй түлхүүр
    const direct = await http().put('/api/settings/inquiry.stale_days').set(admin()).send({ value: 40 });
    expect(direct.status).toBe(200);
    expect(direct.body.value).toBe(40);
  });

  it('аудит лог: зөвхөн audit:read (ADMIN), шүүлт + хуудаслалт, өөр org-ийн мөр харагдахгүй', async () => {
    await http().put('/api/settings/inquiry.stale_days').set(admin()).send({ value: 40 }).expect(200);
    await http().put('/api/settings/inquiry.stale_days').set(admin()).send({ value: 41 }).expect(200);
    await t.prisma.auditLog.create({ data: { orgId: 'org-other', entity: 'SETTING', entityId: 'x', action: 'SETTING_UPDATED' } });
    expect((await http().get('/api/audit-logs').set(h('OFFICER'))).status).toBe(403);
    const all = await http().get('/api/audit-logs').set(admin());
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items[0].afterJson).toEqual({ value: 41 }); // шинэ нь эхэнд
    const page = await http().get('/api/audit-logs').query({ pageSize: 1, page: 2, entity: 'SETTING', entityId: 'inquiry.stale_days' }).set(admin());
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].afterJson).toEqual({ value: 40 });
    expect((await http().get('/api/audit-logs').query({ action: 'NOPE' }).set(admin())).body.total).toBe(0);
    await t.prisma.auditLog.deleteMany({ where: { orgId: 'org-other' } });
  });
});
