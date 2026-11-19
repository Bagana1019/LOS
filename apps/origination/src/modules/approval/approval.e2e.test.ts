import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DecisionView, MyApprovalListResponse } from '@los/contracts';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { KYC_AML_PORT } from '../aml/ports/kyc-aml.port';
import { FakeKycAml } from '../aml/testing/fake-kyc-aml.port';
import { DMS_DOCUMENTS } from '../document/dms-documents.port';
import { FakeDmsDocuments } from '../document/testing/fake-dms-documents';
import { createTestApp, OutboxRelayService, type TestApp } from '../../test-utils/test-app';
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
    // G1 (AML) + FR-9.2 (баримт) gate-ууд илгээх үед kyc/dms-ийг дууддаг — тестэд fake
    t = await createTestApp([ApprovalModule], (b) => b.overrideProvider(KYC_AML_PORT).useValue(new FakeKycAml(() => t.clock.now())).overrideProvider(DMS_DOCUMENTS).useValue(new FakeDmsDocuments()));
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
    await setBranchCodes({ 'branch-1': 'BRANCH1' }); // BR-11: {BRANCH} нь тохируулсан кодоос л (UUID-аас гаргахгүй)
    t.clock.set(new Date('2026-11-03T02:00:00Z'));
  });

  const setBranchCodes = (codes: Record<string, string>) =>
    t.prisma.setting.upsert({ where: { orgId_key: { orgId: ORG, key: 'contract.branch_codes' } }, create: { orgId: ORG, key: 'contract.branch_codes', valueJson: codes }, update: { valueJson: codes } });

  const STEP_KEYS = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score', 'document', 'decision', 'contract', 'official_documents', 'disburse'];
  /** G1 AML: үндсэн зээлдэгч; updated_at тестийн цагаас өмнө — шалгалт «хуучирсан» гэж үзэгдэхгүй */
  async function primaryBorrower(appId: string) {
    const customer = await createCustomer(t.prisma);
    await createBorrower(t.prisma, appId, customer.id, 'PRIMARY');
    await t.prisma.customer.update({ where: { id: customer.id }, data: { updatedAt: new Date(t.clock.now().getTime() - 86_400_000) } });
  }
  async function draft(amount: number, o: { officerId?: string; complete?: boolean } = {}) {
    const app = await createApplication(t.prisma, { productId, amount, officerId: o.officerId ?? 'officer-1', createdBy: o.officerId ?? 'officer-1' });
    await t.prisma.loanApplicationStep.createMany({
      data: STEP_KEYS.map((stepKey, i) => ({ orgId: ORG, applicationId: app.id, stepKey, status: i >= 9 ? 'LOCKED' : i < 8 && o.complete !== false ? 'COMPLETED' : 'PENDING' })),
    });
    await primaryBorrower(app.id);
    return app;
  }
  async function submit(appId: string, actor: Record<string, string> = officer) {
    const res = await http().post(`/api/applications/${appId}/transition`).set(actor).send({ to: 'SUBMITTED' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  /** `expected`: санал өгөгчийн харсан түвшин / хувилбар (FR-1.5 жагсаалтын мөр). Өгөөгүй бол хуучин үйлдэл. */
  const vote = (appId: string, actor: Record<string, string>, decision: 'APPROVE' | 'RETURN', comment?: string, expected: { levelNo?: number; version?: number } = {}) =>
    http().post(`/api/applications/${appId}/approval/vote`).set(actor).send({ decision, ...(comment ? { comment } : {}), ...expected });
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
    expect(row.contractNo).toBe('BBRANCH126110301'); // {PREFIX}B + {BRANCH}BRANCH1 (contract.branch_codes) + {YYMMDD}261103 + {SEQ:2}01
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

  // N1 (phase 7): ApprovalService writes the officer's bell in the decision transaction. The notification consumer (customers' SMS/EMAIL,
  // run when the outbox is relayed) must not add a second bell; the in-memory bus never delivered before, so the duplicate went unseen.
  it('N1: after the outbox is relayed the officer still has exactly one APPROVED bell; the borrower gets SMS and EMAIL', async () => {
    const app = await draft(1_200_000);
    await submit(app.id);
    await vote(app.id, bm, 'APPROVE', 'Зөвшөөрөв').expect(200);
    expect(await t.app.get(OutboxRelayService).relayOnce()).toBeGreaterThan(0);
    expect(await t.prisma.notification.findMany({ where: { applicationId: app.id, userId: 'officer-1', type: 'APPROVED' } })).toHaveLength(1);
    expect((await t.prisma.notificationDelivery.findMany({ where: { applicationId: app.id, type: 'APPROVED' } })).map((d) => d.channel).sort()).toEqual(['EMAIL', 'SMS']);
    const { contractNo } = await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    const inbox = await http().get('/api/notifications').set(officer).expect(200);
    expect(inbox.body.items.filter((n: { type: string }) => n.type === 'APPROVED')).toEqual([expect.objectContaining({ title: 'Хүсэлт батлагдлаа', body: `${app.appNo} дугаартай хүсэлт батлагдлаа. Гэрээний дугаар: ${contractNo}.` })]);
  });

  it('N1: after the outbox is relayed the officer still has exactly one RETURNED bell', async () => {
    const app = await draft(1_200_000);
    await submit(app.id);
    await vote(app.id, bm, 'RETURN', 'Орлого баталгаажаагүй').expect(200);
    await t.app.get(OutboxRelayService).relayOnce();
    expect(await t.prisma.notification.findMany({ where: { applicationId: app.id, userId: 'officer-1', type: 'RETURNED' } })).toHaveLength(1);
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
    await t.prisma.loanApplicationStep.createMany({ data: STEP_KEYS.map((stepKey, i) => ({ orgId: ORG, applicationId: app.id, stepKey, status: i >= 9 ? 'LOCKED' : i < 8 ? 'COMPLETED' : 'PENDING' })) });
    await primaryBorrower(app.id);
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
    expect((await mine(ap(1))).items[0]).toMatchObject({ applicationId: app.id, levelNo: 2, levelName: 'Төв', version: 1 });
  });

  // FR-1.5 / FR-10.2 (M3 review): жагсаалтын мөрөөс санал өгөхдөө харсан түвшин, хувилбараа дамжуулна. Хоцрогдсон бол өөр шийдвэрт санал өгөхгүй — 409 VOTE_TARGET_CHANGED.
  describe('хүлээгдэж буй levelNo / version', () => {
    const mine = async (actor: Record<string, string>) => MyApprovalListResponse.parse((await http().get('/api/approvals/mine').set(actor).expect(200)).body);
    const voteCount = (appId: string, where: { approverId?: string; levelNo?: number } = {}) =>
      t.prisma.approvalVote.count({ where: { ...(where.approverId ? { approverId: where.approverId } : {}), request: { applicationId: appId, ...(where.levelNo ? { levelNo: where.levelNo } : {}) } } });
    /** 35M → 3 түвшин; ap-1 нь 2, 3-р түвшний аль алиных нь гишүүн. Дуудахад 3-р түвшин идэвхтэй, ap-1 тэнд хараахан санал өгөөгүй. */
    async function atLevel3() {
      const app = await draft(35_000_000);
      await submit(app.id);
      await vote(app.id, bm, 'APPROVE').expect(200);
      await vote(app.id, ap(1), 'APPROVE').expect(200);
      expect((await view(app.id)).approval.currentLevel).toBe(3);
      return app;
    }

    it('таарвал 200: жагсаалтын мөрийн levelNo, version-оор санал өгч болно', async () => {
      const app = await draft(1_200_000);
      await submit(app.id);
      const row = (await mine(bm)).items[0]!;
      expect(row).toMatchObject({ applicationId: app.id, levelNo: 1, version: 1 });
      const res = await vote(app.id, bm, 'APPROVE', undefined, { levelNo: row.levelNo, version: row.version });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(DecisionView.parse(res.body).status).toBe('APPROVED');
    });

    it('түвшин ахисан (хоцрогдсон levelNo) → 409 VOTE_TARGET_CHANGED; ижил хүн дараагийн түвшний гишүүн ч санал бүртгэгдэхгүй', async () => {
      const app = await atLevel3();
      const res = await vote(app.id, ap(1), 'APPROVE', undefined, { levelNo: 2 }); // 2-р түвшнийг харж байсан
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('VOTE_TARGET_CHANGED');
      expect(res.body.message).toMatch(/өөрчлөгдсөн/);
      expect(await voteCount(app.id, { approverId: 'ap-1', levelNo: 3 })).toBe(0);
      expect((await view(app.id)).approval.currentLevel).toBe(3);
      // Шинэчилсний дараа зөв түвшнээр санал өгнө.
      await vote(app.id, ap(1), 'APPROVE', undefined, { levelNo: 3, version: 1 }).expect(200);
      expect(await voteCount(app.id, { approverId: 'ap-1', levelNo: 3 })).toBe(1);
    });

    it('буцаж дахин илгээгдсэн (хоцрогдсон version) → 409 VOTE_TARGET_CHANGED; түвшин ижил байсан ч', async () => {
      const app = await draft(1_000_000);
      await submit(app.id);
      const stale = (await mine(bm)).items[0]!;
      expect(stale).toMatchObject({ levelNo: 1, version: 1 });
      await vote(app.id, bm, 'RETURN', 'Орлого дутуу').expect(200);
      await submit(app.id); // version 2, 1-р түвшин дахин идэвхтэй
      const fresh = (await mine(bm)).items[0]!;
      expect(fresh).toMatchObject({ applicationId: app.id, levelNo: 1, version: 2 });

      const res = await vote(app.id, bm, 'APPROVE', undefined, { version: stale.version }); // levelNo өгөөгүй — зөвхөн version
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('VOTE_TARGET_CHANGED');
      expect((await view(app.id)).status).toBe('IN_APPROVAL');
      expect(await voteCount(app.id, { approverId: 'bm-1' })).toBe(1); // зөвхөн v1-ийн RETURN
      const ok = await vote(app.id, bm, 'APPROVE', undefined, { levelNo: fresh.levelNo, version: fresh.version });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(DecisionView.parse(ok.body).status).toBe('APPROVED');
    });

    it('өгөөгүй бол хуучин үйлдэл: түвшин ахисан байсан ч одоогийн түвшинд санал бүртгэгдэнэ (DecisionStep-ийн хуучин дуудлага)', async () => {
      const app = await atLevel3();
      const res = await vote(app.id, ap(1), 'APPROVE');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await voteCount(app.id, { approverId: 'ap-1', levelNo: 3 })).toBe(1);
    });

    it('буруу төрөл (0, string, бутархай) → 400, санал бүртгэгдэхгүй', async () => {
      const app = await draft(1_000_000);
      await submit(app.id);
      for (const body of [{ levelNo: 0 }, { levelNo: '1' }, { levelNo: 1.5 }, { version: 0 }, { version: '1' }, { version: -2 }]) {
        const res = await http().post(`/api/applications/${app.id}/approval/vote`).set(bm).send({ decision: 'APPROVE', ...body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(await voteCount(app.id)).toBe(0);
    });

    it('хүлээгдэж буйг зөв өгсөн ч эрхийн шалгалтыг тойроогүй: гишүүн биш 403, өөрийн хүсэлт 403 (хоцрогдсон гэсэн ч 409 биш)', async () => {
      const app = await draft(1_000_000);
      await submit(app.id);
      const outsider = await vote(app.id, ap(9), 'APPROVE', undefined, { levelNo: 1, version: 1 });
      expect(outsider.status).toBe(403);
      expect(outsider.body.code).toBe('NOT_LEVEL_APPROVER');

      const own = await draft(1_000_000, { officerId: 'bm-1' });
      await submit(own.id, actors.officer('bm-1'));
      for (const expected of [{ levelNo: 1, version: 1 }, { levelNo: 99, version: 99 }]) {
        const res = await vote(own.id, bm, 'APPROVE', undefined, expected);
        expect(res.status, JSON.stringify(expected)).toBe(403);
        expect(res.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
      }
    });

    it('батлагдсан хүсэлтэд хоцрогдсон мөрөөр санал өгвөл одоогийн NOT_IN_APPROVAL 409 хэвээр', async () => {
      const app = await draft(1_000_000);
      await submit(app.id);
      await vote(app.id, bm, 'APPROVE').expect(200);
      const res = await vote(app.id, bm, 'APPROVE', undefined, { levelNo: 1, version: 1 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_IN_APPROVAL');
    });
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

  it('{BRANCH} код тохируулаагүй салбар → 422 BRANCH_CODE_MISSING; батлалт хийгдэхгүй, UUID-аас дугаар гаргахгүй, тоолуур зарцуулахгүй', async () => {
    await setBranchCodes({ 'other-branch': '300' });
    const a = await draft(1_000_000); await submit(a.id);
    const res = await vote(a.id, bm, 'APPROVE');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('BRANCH_CODE_MISSING');
    expect(res.body.message).toMatch(/салбар/i);
    const row = await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.contractNo).toBeNull();
    expect(row.status).toBe('IN_APPROVAL');
    expect(await t.prisma.contractNumberCounter.count()).toBe(0);
    expect(await t.prisma.decisionRecord.count({ where: { applicationId: a.id } })).toBe(0);
    // Код тохируулсны дараа ижил санал амжилттай
    await setBranchCodes({ 'branch-1': '777' });
    await vote(a.id, bm, 'APPROVE').expect(200);
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: a.id } })).contractNo).toBe('B77726110301');
  });

  it('загварт {BRANCH} байхгүй бол салбарын кодгүй ч батлагдана', async () => {
    await t.prisma.setting.deleteMany({ where: { orgId: ORG, key: 'contract.branch_codes' } });
    const tpl = await t.prisma.contractNumberTemplate.findFirstOrThrow({ where: { orgId: ORG }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    await t.prisma.contractNumberTemplate.update({ where: { id: tpl.id }, data: { pattern: '{PREFIX}-{YYMMDD}-{SEQ:3}' } });
    try {
      const a = await draft(1_000_000); await submit(a.id);
      await vote(a.id, bm, 'APPROVE').expect(200);
      expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: a.id } })).contractNo).toBe('B-261103-001');
    } finally {
      await t.prisma.contractNumberTemplate.update({ where: { id: tpl.id }, data: { pattern: tpl.pattern } });
    }
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
