import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DashboardSummary } from '@los/contracts';
import { actors, createApplication, hasTestDb } from '../../test-utils/factories';
import { OTHER_ORG } from './report.fixtures';
import { bootReport, resetReport, type ReportEnv } from './report.test-helpers';
import { createReturnEvent, createStatusEvent } from './test-dashboard-helpers';

type Q = Record<string, string | number>;
const at = (iso: string) => new Date(iso);

// F11-9: "Буцаасан" = энэ сард болсон БУЦААЛТЫН ҮЙЛ ЯВДАЛ (audit_log STATUS_CHANGED → RETURNED), хүсэлтийн одоогийн төлөв биш.
// Дахин илгээхэд loan_application.returned_at цэвэрлэгддэг тул өмнө нь засагдсан буцаалт тоологддоггүй, батлах хувь 100%-д ойртдог байв.
// Тодорхойлолт: үйл явдал бүр нэг удаа тоологдоно (нэг хүсэлт 2 удаа буцвал 2). asOf 2026-10-28 (UB), энэ сар = 2026-10.
describe.skipIf(!hasTestDb)('report: dashboard "Буцаасан" comes from decision history (F11-9)', () => {
  let env: ReportEnv;
  const admin = actors.admin();
  beforeAll(async () => { env = await bootReport(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetReport(env); });

  const summary = async (headers: Record<string, string> = admin, query: Q = {}): Promise<DashboardSummary> => {
    const res = await env.http().get('/api/reports/dashboard/summary').query(query).set(headers);
    if (res.status !== 200) throw new Error(`dashboard → ${res.status} ${JSON.stringify(res.body)}`);
    return DashboardSummary.parse(res.body);
  };
  const flow = async (headers?: Record<string, string>, query?: Q) => (await summary(headers, query)).applications;
  const prisma = () => env.t.prisma;

  it('an application returned once, then resubmitted and approved: 1 return, 1 approval, 50% (returned_at is NULL again)', async () => {
    const a = await createApplication(prisma(), { status: 'APPROVED', submittedAt: at('2026-10-05T02:00:00Z'), approvedAt: at('2026-10-06T02:00:00Z'), returnedAt: null });
    await createReturnEvent(prisma(), a.id, '2026-10-03T14:00:00Z');

    expect(await flow()).toMatchObject({ submittedThisMonth: 1, approvedThisMonth: 1, returnedThisMonth: 1, approvalRate: 0.5 });
  });

  it('each return event counts once: returned twice then approved = 2 returns, rate 1/3', async () => {
    const a = await createApplication(prisma(), { status: 'APPROVED', submittedAt: at('2026-10-11T02:00:00Z'), approvedAt: at('2026-10-12T02:00:00Z'), returnedAt: null });
    await createReturnEvent(prisma(), a.id, '2026-10-03T14:00:00Z');
    await createReturnEvent(prisma(), a.id, '2026-10-10T14:00:00Z');

    expect(await flow()).toMatchObject({ returnedThisMonth: 2, approvedThisMonth: 1, approvalRate: 0.333333 });
  });

  it('a currently RETURNED application with its event: 1 return and 0% approval', async () => {
    const a = await createApplication(prisma(), { status: 'RETURNED', submittedAt: at('2026-10-05T02:00:00Z'), returnedAt: at('2026-10-06T14:00:00Z') });
    await createReturnEvent(prisma(), a.id, '2026-10-06T14:00:00Z');

    expect(await flow()).toMatchObject({ returnedThisMonth: 1, approvedThisMonth: 0, approvalRate: 0 });
  });

  it('no history at all: 0 returns and no approval rate', async () => {
    await createApplication(prisma(), { status: 'DRAFT' });

    expect(await flow()).toMatchObject({ submittedThisMonth: 0, approvedThisMonth: 0, returnedThisMonth: 0, approvalRate: null });
  });

  it('month window is Ulaanbaatar time [2026-10-01 00:00, asOf day end): the boundary instants are exact', async () => {
    const a = await createApplication(prisma(), { status: 'SUBMITTED', submittedAt: at('2026-10-20T02:00:00Z') });
    await createReturnEvent(prisma(), a.id, '2026-09-30T15:59:59.999Z'); // 09-30 23:59:59.999 UB → previous month
    await createReturnEvent(prisma(), a.id, '2026-09-30T16:00:00.000Z'); // 10-01 00:00 UB → in
    await createReturnEvent(prisma(), a.id, '2026-10-28T15:59:59.999Z'); // 10-28 23:59:59.999 UB → in
    await createReturnEvent(prisma(), a.id, '2026-10-28T16:00:00.000Z'); // 10-29 00:00 UB → after asOf day

    expect((await flow()).returnedThisMonth).toBe(2);
    expect((await flow(admin, { asOf: '2026-09-30' })).returnedThisMonth).toBe(1); // September: only the 15:59:59.999Z event
  });

  it('only RETURNED transitions of a LOAN_APPLICATION count: other transitions, audit actions and entities are ignored', async () => {
    const a = await createApplication(prisma(), { status: 'APPROVED', submittedAt: at('2026-10-05T02:00:00Z'), approvedAt: at('2026-10-06T02:00:00Z') });
    await createStatusEvent(prisma(), a.id, { from: 'DRAFT', to: 'SUBMITTED', at: '2026-10-05T02:00:00Z' });
    await createStatusEvent(prisma(), a.id, { from: 'IN_APPROVAL', to: 'APPROVED', at: '2026-10-06T02:00:00Z' });
    await createStatusEvent(prisma(), a.id, { from: 'IN_APPROVAL', to: 'RETURNED', at: '2026-10-07T02:00:00Z', action: 'APPLICATION_UPDATED' });
    await createStatusEvent(prisma(), a.id, { from: 'IN_APPROVAL', to: 'RETURNED', at: '2026-10-07T03:00:00Z', entity: 'CONTRACT' });

    expect(await flow()).toMatchObject({ approvedThisMonth: 1, returnedThisMonth: 0, approvalRate: 1 });
  });

  describe('scope and currency follow the same selection as the other dashboard KPIs', () => {
    it('officer sees own returns only; ADMIN branch filter narrows; another org never leaks in', async () => {
      const mine = await createApplication(prisma(), { branchId: 'branch-1', officerId: 'officer-1' });
      const theirs = await createApplication(prisma(), { branchId: 'branch-2', officerId: 'officer-2' });
      const foreign = await createApplication(prisma(), { orgId: OTHER_ORG, branchId: 'branch-1', officerId: 'officer-1' });
      await createReturnEvent(prisma(), mine.id, '2026-10-03T14:00:00Z');
      await createReturnEvent(prisma(), theirs.id, '2026-10-04T14:00:00Z');
      await createReturnEvent(prisma(), foreign.id, '2026-10-05T14:00:00Z', { orgId: OTHER_ORG });

      expect((await flow(admin)).returnedThisMonth).toBe(2);
      expect((await flow(actors.officer('officer-1'))).returnedThisMonth).toBe(1);
      expect((await flow(actors.officer('officer-2', 'branch-2'))).returnedThisMonth).toBe(1);
      expect((await flow(admin, { branchId: 'branch-2' })).returnedThisMonth).toBe(1);
    });

    it('a USD application is counted only on the USD dashboard', async () => {
      const usd = await createApplication(prisma(), { currency: 'USD' });
      await createReturnEvent(prisma(), usd.id, '2026-10-03T14:00:00Z');

      expect((await flow()).returnedThisMonth).toBe(0);
      expect((await flow(admin, { currency: 'USD' })).returnedThisMonth).toBe(1);
    });
  });
});
