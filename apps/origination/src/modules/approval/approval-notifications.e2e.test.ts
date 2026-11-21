import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { KYC_AML_PORT } from '../aml/ports/kyc-aml.port';
import { FakeKycAml } from '../aml/testing/fake-kyc-aml.port';
import { DMS_DOCUMENTS } from '../document/dms-documents.port';
import { FakeDmsDocuments } from '../document/testing/fake-dms-documents';
import { createTestApp, OutboxRelayService, type TestApp } from '../../test-utils/test-app';
import { ApprovalModule } from './approval.module';

/**
 * F3-3 / F3-3b: the officer's decision bell is written by exactly ONE path (ApprovalService, in the decision transaction):
 *   approve -> exactly 1 APPROVED (contractNo), return -> exactly 1 RETURNED (with the approvers' reason), never 0, never 2.
 * The notification consumer (relayed outbox) only reaches the borrowers and must neither add a second bell nor be required for the first one.
 */
describe.skipIf(!hasTestDb)('approval decision notifications (DB)', () => {
  let t: TestApp;
  let productId: string;
  let templateId: string | null = null;
  const http = () => request(t.app.getHttpServer());
  const officer = actors.officer('officer-1');
  const bm = actors.branchManager('bm-1');
  const ap = (n: number) => actors.approver(`ap-${n}`);
  const STEP_KEYS = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score', 'document', 'decision', 'contract', 'official_documents', 'disburse'];

  beforeAll(async () => {
    process.env.NOTIFICATION_QUEUE = 'inline';
    process.env.NOTIFICATION_SWEEP = 'off';
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
    await resetDb(t.prisma);
    productId = (await t.prisma.product.create({ data: { orgId: ORG, code: 'F33', name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 500_000_000, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40 } })).id;
    const level = (levelNo: number, amountFrom: number, amountTo: number | null, members: string[]) =>
      t.prisma.approvalLevel.create({ data: { orgId: ORG, productId, levelNo, name: `L${levelNo}`, amountFrom, amountTo, slaHours: 24, members: { create: members.map((userId) => ({ orgId: ORG, userId })) } } });
    await level(1, 0, 5_000_000, ['bm-1']);
    await level(2, 5_000_000, null, ['ap-1', 'ap-2', 'ap-3']);
    await t.prisma.contractNumberCounter.deleteMany({});
    await t.prisma.setting.upsert({ where: { orgId_key: { orgId: ORG, key: 'contract.branch_codes' } }, create: { orgId: ORG, key: 'contract.branch_codes', valueJson: { 'branch-1': 'BRANCH1' } }, update: { valueJson: { 'branch-1': 'BRANCH1' } } });
    t.clock.set(new Date('2026-11-03T02:00:00Z'));
  });

  async function draft(amount: number) {
    const app = await createApplication(t.prisma, { productId, amount, officerId: 'officer-1', createdBy: 'officer-1' });
    await t.prisma.loanApplicationStep.createMany({
      data: STEP_KEYS.map((stepKey, i) => ({ orgId: ORG, applicationId: app.id, stepKey, status: i >= 9 ? 'LOCKED' : i < 8 ? 'COMPLETED' : 'PENDING' })),
    });
    const customer = await createCustomer(t.prisma);
    await createBorrower(t.prisma, app.id, customer.id, 'PRIMARY');
    await t.prisma.customer.update({ where: { id: customer.id }, data: { updatedAt: new Date(t.clock.now().getTime() - 86_400_000) } });
    return app;
  }
  async function submit(appId: string) {
    const res = await http().post(`/api/applications/${appId}/transition`).set(officer).send({ to: 'SUBMITTED' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const vote = (appId: string, actor: Record<string, string>, decision: 'APPROVE' | 'RETURN', comment?: string) =>
    http().post(`/api/applications/${appId}/approval/vote`).set(actor).send({ decision, ...(comment ? { comment } : {}) });
  const bells = (appId: string, type: string) => t.prisma.notification.findMany({ where: { applicationId: appId, userId: 'officer-1', type } });
  const relay = () => t.app.get(OutboxRelayService).relayOnce();
  const relayFirst = async () => { expect(await relay()).toBeGreaterThan(0); }; // the decision event is pending in the outbox exactly once
  const inbox = async (type: string) => (await http().get('/api/notifications').set(officer).expect(200)).body.items.filter((n: { type: string }) => n.type === type) as Array<{ title: string; body: string }>;

  describe('approve', () => {
    it('writes exactly one APPROVED bell carrying contractNo, before and after the outbox is relayed', async () => {
      const app = await draft(1_200_000);
      await submit(app.id);
      await vote(app.id, bm, 'APPROVE', 'Зөвшөөрөв').expect(200);

      const { contractNo } = await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
      expect(contractNo).toBeTruthy();
      expect(await bells(app.id, 'APPROVED')).toHaveLength(1); // no Redis/consumer needed: the bell is not zero without a relay
      await relayFirst();
      expect(await relay()).toBe(0); // nothing is re-delivered, so nothing can be added
      const rows = await bells(app.id, 'APPROVED');
      expect(rows).toHaveLength(1);
      expect(rows[0].payloadJson).toMatchObject({ applicationNo: app.appNo, contractNo });
      expect(await inbox('APPROVED')).toEqual([expect.objectContaining({ title: 'Хүсэлт батлагдлаа', body: `${app.appNo} дугаартай хүсэлт батлагдлаа. Гэрээний дугаар: ${contractNo}.` })]);
    });

    it('still notifies the borrower by SMS and EMAIL through the consumer (single path per recipient)', async () => {
      const app = await draft(1_200_000);
      await submit(app.id);
      await vote(app.id, bm, 'APPROVE', 'Зөвшөөрөв').expect(200);
      await relayFirst();
      expect((await t.prisma.notificationDelivery.findMany({ where: { applicationId: app.id, type: 'APPROVED' } })).map((d) => d.channel).sort()).toEqual(['EMAIL', 'SMS']);
    });
  });

  describe('return', () => {
    it('writes exactly one RETURNED bell with the approver reason, before and after the outbox is relayed', async () => {
      const app = await draft(1_200_000);
      await submit(app.id);
      await vote(app.id, bm, 'RETURN', 'Орлого баталгаажаагүй').expect(200);

      expect(await bells(app.id, 'RETURNED')).toHaveLength(1);
      await relayFirst();
      expect(await relay()).toBe(0);
      const rows = await bells(app.id, 'RETURNED');
      expect(rows).toHaveLength(1);
      expect(rows[0].payloadJson).toMatchObject({ applicationNo: app.appNo, comment: 'Орлого баталгаажаагүй' });
      expect(await inbox('RETURNED')).toEqual([expect.objectContaining({ title: 'Хүсэлт буцаагдлаа', body: `${app.appNo} дугаартай хүсэлт буцаагдлаа. Тайлбар: Орлого баталгаажаагүй` })]);
    });

    it('a returned multi-approver level still yields ONE RETURNED bell whose reason joins every RETURN comment', async () => {
      const app = await draft(50_000_000);
      await submit(app.id);
      await vote(app.id, bm, 'APPROVE', 'Салбар зөвшөөрөв').expect(200);
      await vote(app.id, ap(1), 'RETURN', 'Барьцаа дутуу').expect(200);
      expect(await bells(app.id, 'RETURNED')).toHaveLength(0); // 1 of 3 returns does not decide the level
      await vote(app.id, ap(2), 'RETURN', 'Орлого тодорхойгүй').expect(200);
      await relayFirst();

      const rows = await bells(app.id, 'RETURNED');
      expect(rows).toHaveLength(1);
      const comment = (rows[0].payloadJson as { comment?: string }).comment ?? '';
      expect(comment).toContain('Барьцаа дутуу');
      expect(comment).toContain('Орлого тодорхойгүй');
      expect(await inbox('RETURNED')).toHaveLength(1);
    });

    it('does not create an APPROVED bell for a returned application', async () => {
      const app = await draft(1_200_000);
      await submit(app.id);
      await vote(app.id, bm, 'RETURN', 'Баримт дутуу').expect(200);
      await relayFirst();
      expect(await bells(app.id, 'APPROVED')).toHaveLength(0);
    });
  });

  describe('untouched notifications', () => {
    it('APPROVAL_REQUESTED still reaches each member of the next level exactly once and the officer gets no decision bell yet', async () => {
      const app = await draft(50_000_000);
      await submit(app.id);
      await vote(app.id, bm, 'APPROVE', 'Салбар зөвшөөрөв').expect(200);
      await relayFirst();

      const requested = await t.prisma.notification.findMany({ where: { applicationId: app.id, type: 'APPROVAL_REQUESTED' } });
      expect(requested.map((n) => n.userId).sort()).toEqual(['ap-1', 'ap-2', 'ap-3', 'bm-1']);
      expect(await bells(app.id, 'APPROVED')).toHaveLength(0);
      expect(await bells(app.id, 'RETURNED')).toHaveLength(0);
    });
  });
});
