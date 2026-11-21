import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DecisionView, type CannotVoteReason } from '@los/contracts';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { ApprovalModule } from './approval.module';

// F3-11: батлагч биш хүн шийдвэрийн хуудсанд товч ч, тайлбар ч харахгүй байсан. Одоо түвшин бүр хэн санал өгч болохыг (`approvers`: id / дүр),
// хэрэглэгч бүр яагаад өгч чадахгүйг (`cannotVoteReason`) сервер `canVote`-той НЭГ функцээр тооцож хэлнэ. Эрх (хэн хуудсыг нээж чадах) өөрчлөгдөөгүй.
describe.skipIf(!hasTestDb)('decision page: who may vote and why not (DB)', () => {
  let t: TestApp;
  let productId: string;
  const http = () => request(t.app.getHttpServer());
  const officer = actors.officer('officer-1');
  const bm1 = actors.branchManager('bm-1');
  const bm2 = actors.branchManager('bm-2');
  const outsiderApprover = actors.approver('ap-9'); // APPROVER дүртэй ч ямар ч түвшний гишүүн биш
  const levelTwo = actors.approver('ap-1');
  const MEMBER_IDS = ['bm-1', 'bm-2', 'ap-1'];

  beforeAll(async () => {
    process.env.NOTIFICATION_QUEUE = 'inline';
    process.env.NOTIFICATION_SWEEP = 'off';
    t = await createTestApp([ApprovalModule]);
  });
  afterAll(async () => {
    await t.prisma.approvalLevel.deleteMany({ where: { orgId: ORG } });
    await resetDb(t.prisma);
    await t.prisma.product.deleteMany({ where: { orgId: ORG } });
    await t.close();
  });
  beforeEach(async () => {
    await t.prisma.approvalLevel.deleteMany({ where: { orgId: ORG } });
    await resetDb(t.prisma);
    productId = (await t.prisma.product.create({ data: { orgId: ORG, code: 'F311', name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 500_000_000, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40 } })).id;
    const level = (levelNo: number, name: string, amountFrom: number, amountTo: number | null, members: Array<{ userId?: string; role?: string }>) =>
      t.prisma.approvalLevel.create({ data: { orgId: ORG, productId, levelNo, name, amountFrom, amountTo, slaHours: 24, members: { create: members.map((m) => ({ orgId: ORG, ...m })) } } });
    await level(1, 'Салбар', 0, 5_000_000, [{ userId: 'bm-1' }, { userId: 'bm-2' }]); // 2 гишүүн → олонхи 2: нэг санал өгсний дараа түвшин PENDING хэвээр
    await level(2, 'Төв', 5_000_000, null, [{ userId: 'ap-1' }]);
    t.clock.set(new Date('2026-11-21T02:00:00Z'));
  });

  const view = async (appId: string, actor: Record<string, string>) => {
    const res = await http().get(`/api/applications/${appId}/decision`).set(actor);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return DecisionView.parse(res.body);
  };

  /** Батлах шатанд буй хүсэлт (`approval.start`-ийн үр дүн): 1-р түвшин идэвхтэй, 2-р түвшин хүлээгдэж буй. */
  async function inApproval(o: { status?: string; officerId?: string; createdBy?: string; branchId?: string; requests?: boolean } = {}) {
    const customer = await createCustomer(t.prisma);
    const app = await createApplication(t.prisma, {
      productId, amount: 7_000_000, status: o.status ?? 'IN_APPROVAL', officerId: o.officerId ?? 'officer-1', createdBy: o.createdBy ?? o.officerId ?? 'officer-1', ...(o.branchId ? { branchId: o.branchId } : {}),
    });
    await createBorrower(t.prisma, app.id, customer.id, 'PRIMARY');
    if (o.requests !== false) {
      await t.prisma.approvalRequest.create({ data: { orgId: ORG, applicationId: app.id, version: app.version, levelNo: 1, startedAt: t.clock.now(), dueAt: new Date(t.clock.now().getTime() + 86_400_000) } });
      await t.prisma.approvalRequest.create({ data: { orgId: ORG, applicationId: app.id, version: app.version, levelNo: 2, startedAt: t.clock.now(), dueAt: null } });
    }
    return app;
  }
  const castVote = (appId: string, userId: string, decision: 'APPROVE' | 'RETURN' = 'APPROVE') =>
    t.prisma.approvalRequest.findFirstOrThrow({ where: { applicationId: appId, levelNo: 1 } }).then((r) =>
      t.prisma.approvalVote.create({ data: { orgId: ORG, approvalRequestId: r.id, approverId: userId, decision, decidedAt: t.clock.now() } }));

  describe('cannotVoteReason: яг ямар шалтгаанаар', () => {
    it('идэвхтэй түвшний гишүүн, санал өгөөгүй → canVote=true, шалтгаан null', async () => {
      const app = await inApproval();
      const v = await view(app.id, bm1);
      expect(v.canVote).toBe(true);
      expect(v.cannotVoteReason).toBeNull();
    });

    it('NOT_LEVEL_APPROVER: APPROVER дүртэй ч идэвхтэй түвшний гишүүн биш', async () => {
      const app = await inApproval();
      const v = await view(app.id, outsiderApprover);
      expect(v.canVote).toBe(false);
      expect(v.cannotVoteReason).toBe<CannotVoteReason>('NOT_LEVEL_APPROVER');
    });

    it('NOT_LEVEL_APPROVER: 2-р түвшний гишүүн 1-р түвшин идэвхтэй байхад (хүлээгдэж буй түвшний гишүүн)', async () => {
      const app = await inApproval();
      const v = await view(app.id, levelTwo);
      expect(v.approval.levels.map((l) => l.state)).toEqual(['PENDING', 'WAITING']);
      expect(v.cannotVoteReason).toBe('NOT_LEVEL_APPROVER');
    });

    it('NOT_LEVEL_APPROVER: ADMIN ч гишүүн биш бол өөрийн эрхээр санал өгч чадахгүй (хуудсыг нээнэ, санал өгөхгүй)', async () => {
      const app = await inApproval();
      const v = await view(app.id, actors.admin('admin-1'));
      expect(v.canVote).toBe(false);
      expect(v.cannotVoteReason).toBe('NOT_LEVEL_APPROVER');
    });

    it('ALREADY_VOTED: идэвхтэй түвшинд санал өгсөн; нөгөө гишүүн хэвээр санал өгч болно', async () => {
      const app = await inApproval();
      await castVote(app.id, 'bm-1');
      const voter = await view(app.id, bm1);
      expect(voter.approval.levels[0].state).toBe('PENDING'); // олонхи (2/2) бүрдээгүй
      expect(voter.canVote).toBe(false);
      expect(voter.cannotVoteReason).toBe('ALREADY_VOTED');
      const other = await view(app.id, bm2);
      expect(other.canVote).toBe(true);
      expect(other.cannotVoteReason).toBeNull();
    });

    it('OWN_APPLICATION: хариуцсан ЗЭЗ нь түвшний гишүүн байсан ч өөрийн хүсэлтийг батлахгүй', async () => {
      const app = await inApproval({ officerId: 'bm-1', createdBy: 'officer-1' });
      const v = await view(app.id, bm1);
      expect(v.canVote).toBe(false);
      expect(v.cannotVoteReason).toBe('OWN_APPLICATION');
    });

    it('OWN_APPLICATION: үүсгэгч нь түвшний гишүүн байсан ч', async () => {
      const app = await inApproval({ officerId: 'officer-1', createdBy: 'bm-2' });
      const v = await view(app.id, bm2);
      expect(v.cannotVoteReason).toBe('OWN_APPLICATION');
    });

    it('OWN_APPLICATION: ЗЭЗ өөрийн хүсэлтийн хуудсыг нээхэд (гишүүн биш ч «батлагч биш» биш, «өөрийн хүсэлт» гэж хэлнэ)', async () => {
      const app = await inApproval();
      const v = await view(app.id, officer);
      expect(v.canVote).toBe(false);
      expect(v.cannotVoteReason).toBe('OWN_APPLICATION');
    });

    it.each(['DRAFT', 'APPROVED', 'RETURNED'])('NOT_IN_APPROVAL: хүсэлтийн төлөв %s', async (status) => {
      const app = await inApproval({ status, requests: false });
      const v = await view(app.id, bm1);
      expect(v.canVote).toBe(false);
      expect(v.cannotVoteReason).toBe('NOT_IN_APPROVAL');
    });

    it('NOT_IN_APPROVAL: IN_APPROVAL боловч идэвхтэй түвшин байхгүй (approval_request алга)', async () => {
      const app = await inApproval({ requests: false });
      const v = await view(app.id, bm1);
      expect(v.canVote).toBe(false);
      expect(v.cannotVoteReason).toBe('NOT_IN_APPROVAL');
    });

    it('шалтгаан нь санал өгөх endpoint-ын татгалзсан кодтой таарна (UI хэлснийг сервер давтана)', async () => {
      const app = await inApproval({ officerId: 'bm-1', createdBy: 'officer-1' });
      const own = await http().post(`/api/applications/${app.id}/approval/vote`).set(bm1).send({ decision: 'APPROVE' });
      expect(own.body.code).toBe('SELF_APPROVAL_FORBIDDEN'); // → OWN_APPLICATION
      const stranger = await http().post(`/api/applications/${app.id}/approval/vote`).set(outsiderApprover).send({ decision: 'APPROVE' });
      expect(stranger.body.code).toBe('NOT_LEVEL_APPROVER');
      expect((await view(app.id, outsiderApprover)).cannotVoteReason).toBe('NOT_LEVEL_APPROVER');
    });

    it('дүрээр томилсон гишүүн: дүр + хүсэлтийн салбар таарвал санал өгнө, салбар зөрвөл NOT_LEVEL_APPROVER', async () => {
      await t.prisma.approvalLevel.deleteMany({ where: { orgId: ORG } });
      await t.prisma.approvalLevel.create({ data: { orgId: ORG, productId, levelNo: 1, name: 'Салбар', amountFrom: 0, amountTo: null, slaHours: 24, members: { create: [{ orgId: ORG, role: 'APPROVER' }] } } });
      const app = await inApproval({ requests: false });
      await t.prisma.approvalRequest.create({ data: { orgId: ORG, applicationId: app.id, version: app.version, levelNo: 1, startedAt: t.clock.now(), dueAt: new Date(t.clock.now().getTime() + 86_400_000) } });
      const sameBranch = { ...actors.approver('ap-7'), 'x-branch-id': app.branchId };
      const otherBranch = { ...actors.approver('ap-8'), 'x-branch-id': 'branch-2' };
      expect((await view(app.id, sameBranch)).canVote).toBe(true);
      expect((await view(app.id, otherBranch)).cannotVoteReason).toBe('NOT_LEVEL_APPROVER');
    });

    it('шилжилт: түвшин ахихад өмнөх түвшний гишүүн NOT_LEVEL_APPROVER болж, дараагийн түвшний гишүүн санал өгч чадна', async () => {
      const app = await inApproval();
      expect((await http().post(`/api/applications/${app.id}/approval/vote`).set(bm1).send({ decision: 'APPROVE' })).status).toBe(200);
      expect((await view(app.id, bm1)).cannotVoteReason).toBe('ALREADY_VOTED');
      expect((await http().post(`/api/applications/${app.id}/approval/vote`).set(bm2).send({ decision: 'APPROVE' })).status).toBe(200);
      const after = await view(app.id, levelTwo);
      expect(after.approval.currentLevel).toBe(2);
      expect(after.canVote).toBe(true);
      expect(after.cannotVoteReason).toBeNull();
      expect((await view(app.id, bm1)).cannotVoteReason).toBe('NOT_LEVEL_APPROVER'); // 1-р түвшин дууссан, одоо 2-р түвшин идэвхтэй
    });

    it('canVote ба cannotVoteReason хэзээ ч зөрөхгүй: бүх хэрэглэгч × бүх төлөв', async () => {
      const live = await inApproval();
      await castVote(live.id, 'bm-1');
      const own = await inApproval({ officerId: 'bm-2' });
      const done = await inApproval({ status: 'APPROVED', requests: false });
      const everyone = [officer, bm1, bm2, outsiderApprover, levelTwo, actors.admin('admin-1')];
      for (const app of [live, own, done]) {
        for (const actor of everyone) {
          const res = await http().get(`/api/applications/${app.id}/decision`).set(actor);
          if (res.status !== 200) continue; // нээх эрхгүй хэрэглэгч (хариуцаагүй ЗЭЗ)
          expect(res.body.canVote, `${actor['x-user-id']} @ ${app.id}`).toBe(res.body.cannotVoteReason === null);
        }
      }
    });
  });

  describe('approvers: түвшин бүрд хэн санал өгч болно', () => {
    it('түвшин бүрийн томилогдсон батлагчдыг (id) гаргана — идэвхтэй ба хүлээгдэж буй түвшинд хоёуланд нь', async () => {
      const app = await inApproval();
      const v = await view(app.id, bm1);
      const byLevel = Object.fromEntries(v.approval.levels.map((l) => [l.levelNo, l.approvers]));
      expect(byLevel[1]).toHaveLength(2);
      expect(byLevel[1]).toEqual(expect.arrayContaining([{ userId: 'bm-1', role: null }, { userId: 'bm-2', role: null }]));
      expect(byLevel[2]).toEqual([{ userId: 'ap-1', role: null }]);
    });

    it('санал өгсөн эсэхээс үл хамааран бүх томилогдсон батлагч жагсаалтад үлдэнэ (quorum.total-тэй таарна)', async () => {
      const app = await inApproval();
      await castVote(app.id, 'bm-1');
      const level = (await view(app.id, outsiderApprover)).approval.levels[0];
      expect(level.approvers.map((a) => a.userId).sort()).toEqual(['bm-1', 'bm-2']);
      expect(level.approvers).toHaveLength(level.quorum.total);
      expect(level.votes.map((x) => x.approverId)).toEqual(['bm-1']);
    });

    it('дүрээр томилсон гишүүн: userId=null, role=дүр', async () => {
      await t.prisma.approvalLevel.deleteMany({ where: { orgId: ORG } });
      await t.prisma.approvalLevel.create({ data: { orgId: ORG, productId, levelNo: 1, name: 'Салбар', amountFrom: 0, amountTo: null, slaHours: 24, members: { create: [{ orgId: ORG, role: 'APPROVER' }, { orgId: ORG, userId: 'bm-1' }] } } });
      const app = await inApproval({ requests: false });
      await t.prisma.approvalRequest.create({ data: { orgId: ORG, applicationId: app.id, version: app.version, levelNo: 1, startedAt: t.clock.now(), dueAt: new Date(t.clock.now().getTime() + 86_400_000) } });
      const level = (await view(app.id, bm1)).approval.levels[0];
      expect(level.approvers).toEqual(expect.arrayContaining([{ userId: null, role: 'APPROVER' }, { userId: 'bm-1', role: null }]));
    });

    it('идэвхтэй батлагч (APPROVER) бүх хүсэлтийн батлагчдыг харна; өөрийн салбарын захирал мөн', async () => {
      const app = await inApproval();
      for (const actor of [outsiderApprover, bm1, actors.admin('admin-1')]) {
        const level = (await view(app.id, actor)).approval.levels[0];
        expect(level.approvers.map((a) => a.userId).sort()).toEqual(['bm-1', 'bm-2']);
      }
    });
  });

  // Эрх хэвээр: батлагчдын жагсаалт зөвхөн хуудсыг одоо ч нээж чадах хэрэглэгчид. Нээж чадахгүй хүнд 403/404, ямар ч нэмэлт өгөгдөлгүй.
  describe('outsider: хуудсыг нээх эрхгүй хүнд батлагчийн мэдээлэл алдагдахгүй', () => {
    const leaks = (body: unknown) => {
      const text = JSON.stringify(body);
      return [...MEMBER_IDS, 'approvers', 'cannotVoteReason', 'canVote', 'Салбар', 'levels'].filter((needle) => text.includes(needle));
    };

    it('өөр ЗЭЗ (хариуцаагүй) → 403, батлагчийн id байхгүй', async () => {
      const app = await inApproval();
      const res = await http().get(`/api/applications/${app.id}/decision`).set(actors.officer('officer-2'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(leaks(res.body)).toEqual([]);
    });

    it('өөр салбарын захирал → 403', async () => {
      const app = await inApproval();
      const res = await http().get(`/api/applications/${app.id}/decision`).set(actors.branchManager('bm-9', 'branch-2'));
      expect(res.status).toBe(403);
      expect(leaks(res.body)).toEqual([]);
    });

    it('харилцагч (CUSTOMER) ба комплаенс → 403 (шийдвэрийн хуудас зөвхөн ЗЭЗ / захирал / батлагч / админ)', async () => {
      const app = await inApproval();
      const customer = await t.prisma.loanApplicationBorrower.findFirstOrThrow({ where: { applicationId: app.id } });
      for (const actor of [actors.customer(customer.customerId), { 'x-user-id': 'cmp-1', 'x-roles': 'COMPLIANCE', 'x-org-id': ORG }]) {
        const res = await http().get(`/api/applications/${app.id}/decision`).set(actor);
        expect(res.status).toBe(403);
        expect(leaks(res.body)).toEqual([]);
      }
    });

    it('нэвтрээгүй (дүргүй) → 4xx, ямар ч өгөгдөлгүй', async () => {
      const app = await inApproval();
      const res = await http().get(`/api/applications/${app.id}/decision`).set(actors.anonymous());
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(leaks(res.body)).toEqual([]);
    });

    it('өөр байгууллагын хэрэглэгч → 404 (өөр org-ийн хүсэлт байхгүй мэт), батлагчийн id байхгүй', async () => {
      const app = await inApproval();
      const res = await http().get(`/api/applications/${app.id}/decision`).set({ ...actors.admin('admin-x'), 'x-org-id': 'org-other' });
      expect(res.status).toBe(404);
      expect(leaks(res.body)).toEqual([]);
    });

    it('байхгүй хүсэлтийн id → 404', async () => {
      const res = await http().get('/api/applications/00000000-0000-4000-8000-00000000dead/decision').set(bm1);
      expect(res.status).toBe(404);
      expect(leaks(res.body)).toEqual([]);
    });

    it('батлагч биш гэдгийг мэдэх нь нээх эрхгүй гэсэн үг биш: нээж чадах хүн л жагсаалтыг харна (өөр ЗЭЗ нээж чадахгүй, батлагч нээнэ)', async () => {
      const app = await inApproval();
      expect((await http().get(`/api/applications/${app.id}/decision`).set(actors.officer('officer-2'))).status).toBe(403);
      expect((await http().get(`/api/applications/${app.id}/decision`).set(outsiderApprover)).status).toBe(200);
    });
  });
});
