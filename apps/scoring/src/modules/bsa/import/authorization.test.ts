// docs/01 §3 «Харах хүрээ» + үүргийн матриц: application service-ийн БҮХ method-ийг бүх төрлийн хэрэглэгчээр шалгана.
//  - Өөр байгууллага ⇒ 404 (оршихыг задруулахгүй), эрхгүй ⇒ 403, ба эрхгүй хүн ямар ч өгөгдөл өөрчилж чадахгүй.
//  - APPROVER зөвхөн харна (бичих үйлдэл 403, APPROVER + OFFICER хоёр үүрэгтэй ч бичихдээ OFFICER-ийн хүрээнд).
// «Зөвшөөрөгдсөн» = эрхийн шалгалтад унаагүй (домэйн алдаа 409/422 гэх мэт нь зөвшөөрөгдсөнд тооцогдоно).
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '../common/infra.ports';
import { createHarness, ctxOf, OFFICER, OTHER_BRANCH, OTHER_ORG, type Harness } from './testing/harness';
import { happyFiles } from './testing/scenario';

type Verdict = 'ALLOWED' | 'FORBIDDEN' | 'NOT_FOUND';

async function verdictOf(call: () => Promise<unknown>): Promise<Verdict> {
  try {
    await call();
    return 'ALLOWED';
  } catch (e) {
    if (e instanceof ForbiddenException) return 'FORBIDDEN';
    if (e instanceof NotFoundException) return 'NOT_FOUND';
    return 'ALLOWED'; // домэйн алдаа (BsaException): эрхийн шалгалтыг давсан
  }
}

const ACTORS: ReadonlyArray<{ name: string; ctx: RequestContext }> = [
  { name: 'owner OFFICER', ctx: OFFICER },
  { name: 'peer OFFICER, same branch', ctx: ctxOf(['OFFICER'], { userId: 'u-peer' }) },
  { name: 'OFFICER, other branch', ctx: ctxOf(['OFFICER'], { branchId: OTHER_BRANCH }) },
  { name: 'BRANCH_MANAGER, same branch', ctx: ctxOf(['BRANCH_MANAGER'], { userId: 'u-bm' }) },
  { name: 'BRANCH_MANAGER, other branch', ctx: ctxOf(['BRANCH_MANAGER'], { userId: 'u-bm2', branchId: OTHER_BRANCH }) },
  { name: 'APPROVER', ctx: ctxOf(['APPROVER'], { userId: 'u-ap', branchId: null }) },
  { name: 'ADMIN', ctx: ctxOf(['ADMIN'], { userId: 'u-admin', branchId: null }) },
  { name: 'ADMIN of another org', ctx: ctxOf(['ADMIN'], { orgId: OTHER_ORG, userId: 'u-admin', branchId: null }) },
  { name: 'owner OFFICER without a branch', ctx: ctxOf(['OFFICER'], { branchId: null }) },
  { name: 'APPROVER + peer OFFICER', ctx: ctxOf(['APPROVER', 'OFFICER'], { userId: 'u-peer' }) },
];

const A = 'ALLOWED';
const F = 'FORBIDDEN';
const N = 'NOT_FOUND';
//                 owner peer otherBr  bm  bmOther appr  admin foreign noBranch apprPeer
const READ: Verdict[] = [A, F, F, A, F, A, A, N, F, A];
const WRITE: Verdict[] = [A, F, F, A, F, F, A, N, F, F];

interface Ids {
  analysis: string;
  job: string;
}

interface Method {
  name: string;
  expected: Verdict[];
  call: (h: Harness, ctx: RequestContext, ids: Ids) => Promise<unknown>;
}

const NEW_RULE = { direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'abc', categoryCode: 'OTHER_EXPENSE', priority: 1000 } as const;

const METHODS: Method[] = [
  // ── Унших ──
  { name: 'AnalysisService.get', expected: READ, call: (h, c, i) => h.analysis.get(c, i.analysis) },
  { name: 'AnalysisService.listJobs', expected: READ, call: (h, c, i) => h.analysis.listJobs(c, i.analysis) },
  { name: 'AnalysisService.getJob', expected: READ, call: (h, c, i) => h.analysis.getJob(c, i.analysis, i.job) },
  { name: 'AnalysisService.jobCounts', expected: READ, call: (h, c, i) => h.analysis.jobCounts(c, i.analysis) },
  { name: 'AnalysisService.listTransactions', expected: READ, call: (h, c, i) => h.analysis.listTransactions(c, i.analysis) },
  { name: 'AnalysisService.transactionCounts', expected: READ, call: (h, c, i) => h.analysis.transactionCounts(c, i.analysis) },
  { name: 'AnalysisService.listEvents', expected: READ, call: (h, c, i) => h.analysis.listEvents(c, i.analysis) },
  { name: 'RecalculationService.report', expected: READ, call: (h, c, i) => h.recalc.report(c, i.analysis) },
  { name: 'RecalculationService.scoringInput', expected: READ, call: (h, c, i) => h.recalc.scoringInput(c, i.analysis) },
  { name: 'FinalizeService.toScoringInput', expected: READ, call: (h, c, i) => h.finalize.toScoringInput(c, i.analysis) },
  { name: 'FinalizeService.scoringPreview', expected: READ, call: (h, c, i) => h.finalize.scoringPreview(c, i.analysis) },
  // ── Бичих ──
  { name: 'AnalysisService.updateParams', expected: WRITE, call: (h, c, i) => h.analysis.updateParams(c, i.analysis, { proposedMonthlyPayment: 1 }) },
  { name: 'AnalysisService.delete', expected: WRITE, call: (h, c, i) => h.analysis.delete(c, i.analysis) },
  { name: 'UploadService.upload', expected: WRITE, call: async (h, c, i) => h.upload.upload(c, i.analysis, [{ content: Buffer.from('a,b\n1,2\n'), fileName: 'x.csv', mimeType: 'text/csv' }]) },
  { name: 'UploadService.retryJob', expected: WRITE, call: (h, c, i) => h.upload.retryJob(c, i.analysis, i.job) },
  { name: 'RecalculationService.recalculate', expected: WRITE, call: (h, c, i) => h.recalc.recalculate(c, i.analysis) },
  { name: 'ReclassifyService.reclassify', expected: WRITE, call: (h, c, i) => h.reclassify.reclassify(c, i.analysis, { transactionIds: ['11111111-1111-4111-8111-111111111111'], categoryCode: 'OTHER_INCOME' }) },
  { name: 'FinalizeService.finalize', expected: WRITE, call: (h, c, i) => h.finalize.finalize(c, i.analysis) },
  // ── Дүрэм (ADMIN) · дүрмийн дараа шинжилгээнд хэрэглэх хувилбар ──
  { name: 'ReclassifyService.createRule (+analysis)', expected: [F, F, F, F, F, F, A, N, F, F], call: (h, c, i) => h.reclassify.createRule(c, NEW_RULE, { analysisId: i.analysis }) },
];

describe('authorization matrix: analysis-scoped methods', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });

  /** Хоёр хуулгатай, нэг алдаатай ажилтай шинэ шинжилгээ (owner үүсгэсэн) */
  async function freshAnalysis(): Promise<Ids> {
    const analysis = await h.createAnalysis({ loanApplicationId: `app-${Math.random().toString(36).slice(2)}` });
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    const [job] = await h.jobs(analysis.id);
    return { analysis: analysis.id, job: job.id };
  }

  const snapshot = async (id: string): Promise<string> =>
    JSON.stringify([
      await h.memory.analyses.getById(id),
      (await h.memory.importJobs.list({ analysisId: id })).items,
      (await h.memory.events.list(id)).items.length,
      (await h.memory.transactions.loadAll(id)).length,
    ]);

  for (const method of METHODS) {
    describe(method.name, () => {
      ACTORS.forEach((actor, index) => {
        const expected = method.expected[index];
        it(`${actor.name} → ${expected}`, async () => {
          const ids = await freshAnalysis();
          // toScoringInput/scoringPreview ANALYZED шаарддаг тул шалгалт нь эрхийн давхаргад л хамаарна (домэйн алдаа ч «зөвшөөрөгдсөн»)
          const before = await snapshot(ids.analysis);
          const got = await verdictOf(() => method.call(h, actor.ctx, ids));
          expect(got).toBe(expected);
          if (expected !== 'ALLOWED') {
            // Эрхгүй хүн юу ч өөрчилж чадахгүй
            expect(await snapshot(ids.analysis)).toBe(before);
          }
        });
      });
    });
  }

  it('a foreign org gets the SAME answer as for a missing analysis (existence is not disclosed)', async () => {
    const ids = await freshAnalysis();
    const foreign = ACTORS[7].ctx;
    const missing = '00000000-0000-0000-0000-000000000000';
    const real = (await h.analysis.get(foreign, ids.analysis).catch((e: unknown) => e)) as NotFoundException;
    const none = (await h.analysis.get(foreign, missing).catch((e: unknown) => e)) as NotFoundException;
    expect(real).toBeInstanceOf(NotFoundException);
    expect(real.message).toBe(none.message);
    expect(real.getStatus()).toBe(none.getStatus());
  });

  it('the denied APPROVER cannot change anything through any write method (state identical afterwards)', async () => {
    const ids = await freshAnalysis();
    const approver = ACTORS[5].ctx;
    const before = await snapshot(ids.analysis);
    for (const method of METHODS.filter((m) => m.expected === WRITE)) {
      expect(await verdictOf(() => method.call(h, approver, ids)), method.name).toBe('FORBIDDEN');
    }
    expect(await snapshot(ids.analysis)).toBe(before);
    expect(h.store.keys().length).toBeGreaterThan(0);
  });
});

describe('authorization matrix: methods without a target analysis', () => {
  it('create: OFFICER, BRANCH_MANAGER and ADMIN may; APPROVER and a branchless OFFICER may not', async () => {
    const h = await createHarness();
    const verdicts: Verdict[] = [];
    for (const actor of ACTORS) verdicts.push(await verdictOf(() => h.createAnalysis({ loanApplicationId: `a-${verdicts.length}` }, actor.ctx)));
    //          owner peer otherBr bm bmOther appr   admin foreign noBranch apprPeer
    expect(verdicts).toEqual([A, A, A, A, A, F, A, A, F, A]);
  });

  it('list and latestForApplication only ever return what the caller may read', async () => {
    const h = await createHarness();
    await h.createAnalysis();
    const totals: number[] = [];
    const latest: number[] = [];
    for (const actor of ACTORS) {
      totals.push((await h.analysis.list(actor.ctx)).total);
      latest.push((await h.analysis.latestForApplication(actor.ctx, 'app-1')).length);
    }
    //  owner peer otherBr bm bmOther appr admin foreign noBranch apprPeer
    expect(totals).toEqual([1, 0, 0, 1, 0, 1, 1, 0, 0, 1]);
    expect(latest).toEqual(totals);
  });

  it('createRule and listRules are ADMIN-only; categories are readable by every role', async () => {
    const h = await createHarness();
    const rules: Verdict[] = [];
    const lists: Verdict[] = [];
    const cats: Verdict[] = [];
    for (const actor of ACTORS) {
      rules.push(await verdictOf(() => h.reclassify.createRule(actor.ctx, { ...NEW_RULE, pattern: `p${rules.length}` })));
      lists.push(await verdictOf(() => h.reclassify.listRules(actor.ctx)));
      cats.push(await verdictOf(() => h.reclassify.listCategories(actor.ctx)));
    }
    expect(rules).toEqual([F, F, F, F, F, F, A, A, F, F]);
    expect(lists).toEqual(rules);
    expect(cats.every((v) => v === 'ALLOWED')).toBe(true);
  });

  it('system operations take no user context and cannot be reached with one (pipeline, retention)', async () => {
    const h = await createHarness();
    // processJob / purgeExpired: ctx-аргументгүй (queue worker, scheduler). REST-д ил гаргахгүй — энэ нь API хэлбэрийн шалгалт
    expect(h.pipeline.processJob.length).toBe(2);
    expect(h.retention.purgeExpired.length).toBeLessThanOrEqual(2);
  });
});
