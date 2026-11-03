import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DecisionView, MyApprovalListResponse } from '@los/contracts';
import { actors, createApplication, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { ApprovalModule } from './approval.module';
import { ApprovalService } from './approval.service';

// Модуль 10 AC: 1.2M → 1 түвшин; 50M → 3 түвшин; 3 батлагчтай түвшинд 2 APPROVE → дараагийн түвшин; 1 RETURN + 2 APPROVE → үргэлжилнэ;
// 2 RETURN → RETURNED; APPROVED → contract_no загвараар, 2-р үе шат нээгдэнэ; аудит бүрэн.
describe.skipIf(!hasTestDb)('approval flow (DB)', () => {
  let t: TestApp;
  let productId: string;
  let templateId: string | null = null;
  const http = () => request(t.app.getHttpServer());
  const officer = actors.officer('officer-1');
  const bm = actors.branchManager('bm-1');
  const ap = (n: number) => actors.approver(`ap-${n}`);

  beforeAll(async () => {
    process.env.NOTIFICATION_QUEUE = 'inline';
    process.env.NOTIFICATION_SWEEP = 'off';
    t = await createTestApp([ApprovalModule]);
    if (!(await t.prisma.contractNumberTemplate.findFirst({ where: { orgId: ORG } }))) {
      templateId = (await t.prisma.contractNumberTemplate.create({ data: { orgId: ORG, pattern: '{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', prefix: 'B', seqScope: 'DAY', nextSeq: 1 } })).id;
    }
  });
  afterAll(async () => {
    await t.prisma.approvalLevel.deleteMany({ where: { orgId: ORG } });
    await resetDb(t.prisma);
    await t.prisma.product.deleteMany({ where: { orgId: ORG } });
    if (templateId) { await t.prisma.contractNumberCounter.deleteMany({ where: { templateId } }); await t.prisma.contractNumberTemplate.delete({ where: { id: templateId } }); }
    await t.close();
  });
  beforeEach(async () => {
    await t.prisma.approvalLevel.deleteMany({ where: { orgId: ORG } });
    await resetDb(t.prisma); // product-ыг ч устгана → түвшинг (FK SetNull) дахин үүсгэнэ
    const product = await t.prisma.product.create({ data: { orgId: ORG, code: 'M10', name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 500_000_000, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40 } });
    productId = product.id;
    const level = (levelNo: number, name: string, amountFrom: number, amountTo: number | null, members: string[]) =>
      t.prisma.approvalLevel.create({ data: { orgId: ORG, productId, levelNo, name, amountFrom, amountTo, slaHours: 24, members: { create: members.map((userId) => ({ orgId: ORG, userId })) } } });
    await level(1, 'Салбар', 0, 5_000_000, ['bm-1']);
    await level(2, 'Төв', 5_000_000, 30_000_000, ['ap-1']);
    await level(3, 'Зээлийн хороо', 30_000_000, null, ['ap-1', 'ap-2', 'ap-3']);
    await t.prisma.contractNumberCounter.deleteMany({});
    t.clock.set(new Date('2026-11-03T02:00:00Z'));
  });

  const STEP_KEYS = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score', 'document', 'decision', 'contract', 'official_documents', 'disburse'];
  async function draft(amount: number, o: { officerId?: string; complete?: boolean } = {}) {
    const app = await createApplication(t.prisma, { productId, amount, officerId: o.officerId ?? 'officer-1', createdBy: o.officerId ?? 'officer-1' });
    await t.prisma.loanApplicationStep.createMany({
      data: STEP_KEYS.map((stepKey, i) => ({ orgId: ORG, applicationId: app.id, stepKey, status: i >= 9 ? 'LOCKED' : i < 7 && o.complete !== false ? 'COMPLETED' : 'PENDING' })),
    });
    return app;
  }
  async function submit(appId: string, actor: Record<string, string> = officer) {
    const res = await http().post(`/api/applications/${appId}/transition`).set(actor).send({ to: 'SUBMITTED' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const vote = (appId: string, actor: Record<string, string>, decision: 'APPROVE' | 'RETURN', comment?: string) =>
    http().post(`/api/applications/${appId}/approval/vote`).set(actor).send({ decision, ...(comment ? { comment } : {}) });
  const view = async (appId: string, actor: Record<string, string> = officer) => DecisionView.parse((await http().get(`/api/applications/${appId}/decision`).set(actor).expect(200)).body);

  it('1.2M → 1 түвшин: илгээмэгц IN_APPROVAL, салбар батлахад APPROVED + гэрээний дугаар + 2-р үе шат нээгдэнэ + аудит', async () => {
    const app = await draft(1_200_000);
    await submit(app.id);
    let v = await view(app.id);
    expect(v.status).toBe('IN_APPROVAL');
    expect(v.approval.totalLevels).toBe(1);
    expect(v.approval.currentLevel).toBe(1);
    expect(v.approval.levels[0]).toMatchObject({ levelNo: 1, state: 'PENDING', quorum: { required: 1, total: 1 } });
    expect((await t.prisma.notification.findMany({ where: { applicationId: app.id } })).map((n) => [n.userId, n.type])).toEqual([['bm-1', 'APPROVAL_REQUESTED']]);
    expect((await t.prisma.loanApplicationStep.findUniqueOrThrow({ where: { applicationId_stepKey: { applicationId: app.id, stepKey: 'decision' } } })).status).toBe('COMPLETED');

    const res = await vote(app.id, bm, 'APPROVE', 'Зөвшөөрөв');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    v = DecisionView.parse(res.body);
    expect(v.status).toBe('APPROVED');
    const row = await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.contractNo).toBe('BBRANCH126110301'); // {PREFIX}B + {BRANCH}BRANCH1 + {YYMMDD}261103 + {SEQ:2}01
    expect(row.decidedAt).not.toBeNull();
    expect(v.decisionRecord).toMatchObject({ decisionNo: `${app.appNo}/V1`, contractNo: row.contractNo });
    expect(v.decisionRecord?.minutesText).toContain('bm-1');
    const steps = await t.prisma.loanApplicationStep.findMany({ where: { applicationId: app.id, stepKey: { in: ['contract', 'official_documents', 'disburse'] } } });
    expect(steps.every((s) => s.status === 'PENDING')).toBe(true); // G3
    const audit = (await t.prisma.auditLog.findMany({ where: { applicationId: app.id }, orderBy: { at: 'asc' } })).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['STATUS_CHANGED', 'APPROVAL_STARTED', 'APPROVAL_VOTE', 'APPLICATION_APPROVED']));
    expect(await t.prisma.outbox.findMany({ where: {} }).then((rows) => rows.map((r) => (r.payload as { type?: string }).type))).toEqual(expect.arrayContaining(['ApplicationSubmitted', 'ApplicationApproved']));
    expect((await t.prisma.notification.findMany({ where: { applicationId: app.id, userId: 'officer-1' } })).map((n) => n.type)).toEqual(['APPROVED']);
  });

  it('50M → 3 түвшин; 3 батлагчтай түвшинд 1 RETURN + 2 APPROVE → үргэлжилж APPROVED', async () => {
    const app = await draft(50_000_000);
    await submit(app.id);
    expect((await view(app.id)).approval.levels.map((l) => [l.levelNo, l.state])).toEqual([[1, 'PENDING'], [2, 'WAITING'], [3, 'WAITING']]);
    // Хүлээгдэж буй түвшний батлагч эрт санал өгч чадахгүй.
    expect((await vote(app.id, ap(1), 'APPROVE')).status).toBe(403);
    await vote(app.id, bm, 'APPROVE').expect(200);
    expect((await view(app.id)).status).toBe('IN_APPROVAL');
    await vote(app.id, ap(1), 'APPROVE').expect(200);
    let v = await view(app.id);
    expect(v.approval.currentLevel).toBe(3);
    expect(v.approval.levels[2]).toMatchObject({ state: 'PENDING', quorum: { required: 2, total: 3 } });
    await vote(app.id, ap(1), 'RETURN', 'Дутуу').expect(200);
    await vote(app.id, ap(2), 'APPROVE').expect(200);
    expect((await view(app.id)).status).toBe('IN_APPROVAL'); // 1 RETURN + 1 APPROVE — олонхи гараагүй
    v = DecisionView.parse((await vote(app.id, ap(3), 'APPROVE')).body);
    expect(v.status).toBe('APPROVED');
    expect(v.approval.levels.map((l) => l.state)).toEqual(['APPROVED', 'APPROVED', 'APPROVED']);
  });

  it('3 батлагчтай түвшинд 2 RETURN → RETURNED (тайлбар заавал), ЗЭЗ засаад дахин илгээхэд version+1', async () => {
    const app = await draft(35_000_000);
    await submit(app.id);
    await vote(app.id, bm, 'APPROVE').expect(200);
    await vote(app.id, ap(1), 'APPROVE').expect(200);
    expect((await vote(app.id, ap(2), 'RETURN')).status).toBe(400); // RETURN-д тайлбар заавал
    await vote(app.id, ap(2), 'RETURN', 'Орлого баталгаажаагүй').expect(200);
    const res = await vote(app.id, ap(3), 'RETURN', 'Барьцаа дутуу');
    const v = DecisionView.parse(res.body);
    expect(v.status).toBe('RETURNED');
    expect(v.versions).toEqual([{ version: 1, outcome: 'RETURNED', returnedComment: 'Орлого баталгаажаагүй' }]);
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).contractNo).toBeNull();
    expect((await t.prisma.notification.findMany({ where: { applicationId: app.id, userId: 'officer-1', type: 'RETURNED' } }))).toHaveLength(1);

    await submit(app.id); // FR-10.4
    const v2 = await view(app.id);
    expect(v2).toMatchObject({ status: 'IN_APPROVAL', version: 2 });
    expect(v2.approval.levels.map((l) => l.state)).toEqual(['PENDING', 'WAITING', 'WAITING']);
    expect(v2.versions.map((x) => [x.version, x.outcome])).toEqual([[1, 'RETURNED'], [2, 'PENDING']]);
  });

  it('батлагч өөрийн хүсэлтийг батлахгүй; гишүүн биш 403; давхар санал 409; ЗЭЗ санал өгөх эрхгүй; батлагч нөхцөл засахгүй', async () => {
    const own = await draft(1_000_000, { officerId: 'bm-1' });
    await submit(own.id, actors.officer('bm-1'));
    const r = await vote(own.id, bm, 'APPROVE');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SELF_APPROVAL_FORBIDDEN');

    const app = await draft(7_000_000);
    await submit(app.id);
    await vote(app.id, bm, 'APPROVE').expect(200);
    expect((await vote(app.id, ap(9), 'APPROVE')).body.code).toBe('NOT_LEVEL_APPROVER');
    await vote(app.id, ap(1), 'APPROVE').expect(200); // 2 түвшин дууслаа → APPROVED
    expect((await vote(app.id, ap(1), 'APPROVE')).status).toBe(409);
    expect((await vote(app.id, officer, 'APPROVE')).status).toBe(403);
    // FR-10.3: батлагч нөхцөл/төлөв өөрчлөх эрхгүй
    expect((await http().post(`/api/applications/${app.id}/transition`).set(ap(1)).send({ to: 'RETURNED' })).status).toBe(403);
  });

  it('илгээхэд түвшин тохируулаагүй бол 422 ба илгээлт буцна', async () => {
    const other = await t.prisma.product.create({ data: { orgId: ORG, code: 'M10-X', name: 'Бусад', productType: 'CONSUMER', minAmount: 1, maxAmount: 9e9, minTerm: 1, maxTerm: 36, minRate: 1, maxRate: 40 } });
    await t.prisma.approvalLevel.create({ data: { orgId: ORG, productId: other.id, levelNo: 1, name: 'Хоосон', amountFrom: 0, slaHours: 24 } });
    const app = await createApplication(t.prisma, { productId: other.id, amount: 1_000_000, officerId: 'officer-1' });
    await t.prisma.loanApplicationStep.createMany({ data: STEP_KEYS.map((stepKey, i) => ({ orgId: ORG, applicationId: app.id, stepKey, status: i >= 9 ? 'LOCKED' : i < 7 ? 'COMPLETED' : 'PENDING' })) });
    const res = await http().post(`/api/applications/${app.id}/transition`).set(officer).send({ to: 'SUBMITTED' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('APPROVAL_LEVEL_WITHOUT_MEMBERS');
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('DRAFT');
    await t.prisma.approvalLevel.deleteMany({ where: { productId: other.id } });
    await t.prisma.product.delete({ where: { id: other.id } });
  });

  it('"Миний батлах": идэвхтэй түвшний батлагчид л харагдана; жагсаалтын myApprovalCount', async () => {
    const app = await draft(7_000_000);
    await submit(app.id);
    const mine = async (actor: Record<string, string>) => MyApprovalListResponse.parse((await http().get('/api/approvals/mine').set(actor).expect(200)).body);
    expect((await mine(bm)).items.map((i) => [i.applicationId, i.levelNo, i.totalLevels])).toEqual([[app.id, 1, 2]]);
    expect((await mine(ap(1))).total).toBe(0); // 2-р түвшин хараахан эхлээгүй
    const list = await http().get('/api/applications').set(bm).expect(200);
    expect(list.body.myApprovalCount).toBe(1);
    await vote(app.id, bm, 'APPROVE').expect(200);
    expect((await mine(bm)).total).toBe(0);
    expect((await mine(ap(1))).items[0]).toMatchObject({ applicationId: app.id, levelNo: 2, levelName: 'Төв' });
  });

  it('SLA хэтэрвэл улаан (overdue) + нэг удаа SLA_BREACH мэдэгдэл', async () => {
    const app = await draft(1_000_000);
    await submit(app.id);
    expect((await view(app.id)).approval.levels[0].overdue).toBe(false);
    t.clock.advanceMs(25 * 3_600_000);
    expect((await view(app.id)).approval.levels[0].overdue).toBe(true);
    const svc = t.app.get(ApprovalService);
    expect(await svc.sweepSla(ORG)).toBe(1);
    expect(await svc.sweepSla(ORG)).toBe(0); // давхар мэдэгдэхгүй
    expect((await t.prisma.notification.findMany({ where: { applicationId: app.id, type: 'SLA_BREACH' } })).map((n) => n.userId).sort()).toEqual(['bm-1', 'officer-1']);
  });

  it('{BRANCH} код setting-ээс (admin тохируулсан) авна', async () => {
    await t.prisma.setting.upsert({ where: { orgId_key: { orgId: ORG, key: 'contract.branch_codes' } }, create: { orgId: ORG, key: 'contract.branch_codes', valueJson: { 'branch-1': '10026' } }, update: { valueJson: { 'branch-1': '10026' } } });
    const a = await draft(1_000_000); await submit(a.id); await vote(a.id, bm, 'APPROVE').expect(200);
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: a.id } })).contractNo).toBe('B1002626110301');
  });

  it('гэрээний дугаар: нэг өдөр 01, 02 дарааллаар; маргааш (DAY хүрээ) дахин 01', async () => {
    const nos: string[] = [];
    for (let i = 0; i < 2; i++) { const a = await draft(1_000_000); await submit(a.id); await vote(a.id, bm, 'APPROVE').expect(200); nos.push((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: a.id } })).contractNo!); }
    expect(nos.map((n) => n.slice(-2))).toEqual(['01', '02']);
    expect(new Set(nos).size).toBe(2);
    t.clock.advanceMs(24 * 3_600_000);
    const a = await draft(1_000_000); await submit(a.id); await vote(a.id, bm, 'APPROVE').expect(200);
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: a.id } })).contractNo!.slice(-2)).toBe('01');
  });

  it('зэрэгцээ санал: нэг түвшний 3 батлагч зэрэг санал өгөхөд түвшин нэг л удаа ахина', async () => {
    const app = await draft(40_000_000);
    await submit(app.id);
    await vote(app.id, bm, 'APPROVE').expect(200);
    await vote(app.id, ap(1), 'APPROVE').expect(200);
    const rs = await Promise.all([1, 2, 3].map((n) => vote(app.id, ap(n), 'APPROVE')));
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(2);
    expect((await view(app.id)).status).toBe('APPROVED');
    expect(await t.prisma.decisionRecord.count({ where: { applicationId: app.id } })).toBe(1);
  });
});
