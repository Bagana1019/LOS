// BsaRepository-ийн ГЭРЭЭНИЙ ТЕСТ: нэг багц, хоёр хэрэгжүүлэлт (InMemoryBsaRepository үргэлж, PrismaBsaRepository TEST_DATABASE_URL өгөгдвөл).
// Хоёр хэрэгжүүлэлт ижил эрэмбэ, хувилбар олголт, dedupe, хуудаслалт, бөөрөнхийлөл, алдааны кодтой байх ёстой.
// БҮХ ӨГӨГДӨЛ СИНТЕТИК (зохиомол): жинхэнэ регистр, данс, нэр, гүйлгээний утга байхгүй.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BsaCategoryDef, BsaRuleDef } from '../../classify/classify.types';
import {
  BsaDuplicateError, BsaInvalidError, BsaNotFoundError, MANUAL_OVERRIDE_CONFIDENCE, MAX_PAGE_SIZE,
  type BsaRepository, type NewBsaAnalysis, type NewBsaTransaction,
} from './bsa.repository';

export interface RepositoryHarness {
  /** Одоогийн (reset-ийн дараа хоосон) repository */
  readonly repo: BsaRepository;
  reset(): Promise<void>;
  seedConfig(orgId: string, cfg: { categories?: BsaCategoryDef[]; rules?: Array<Omit<BsaRuleDef, 'id'>> }): Promise<void>;
  /** Repository-ийн цагийг тогтооно (createdAt/updatedAt/at) */
  setNow(d: Date): void;
  /** Зөвхөн DB: BSA хүснэгтүүдийн бүх мөрийн текст (PII-г шифрлэж хадгалсныг шалгахад) */
  rawDump?(): Promise<string>;
  close(): Promise<void>;
}

const ORG = 'org-1';
const BRANCH = 'branch-1';
const T0 = new Date('2026-01-01T00:00:00.000Z');

const CATEGORIES: BsaCategoryDef[] = [
  { code: 'SALARY', direction: 'INCOME', groupCode: 'A', name: 'Цалин', weight: 1, dtiRole: 'INCOME', isActive: true },
  { code: 'BUSINESS_INCOME', direction: 'INCOME', groupCode: 'B', name: 'Бизнес', weight: 0.85, dtiRole: 'INCOME', isActive: true },
  { code: 'OWN_TRANSFER_IN', direction: 'INCOME', groupCode: '—', name: 'Өөрийн данс', weight: 0, dtiRole: 'EXCLUDE', isActive: true },
  { code: 'LOAN_PAYMENT', direction: 'EXPENSE', groupCode: 'A', name: 'Зээлийн төлбөр', weight: 1, dtiRole: 'DEBT_SERVICE', isActive: true },
  { code: 'OTHER_EXPENSE', direction: 'EXPENSE', groupCode: '?', name: 'Бусад зардал', weight: 1, dtiRole: 'INFO', isActive: true },
  { code: 'RETIRED_EXPENSE', direction: 'EXPENSE', groupCode: 'D', name: 'Идэвхгүй', weight: 1, dtiRole: 'INFO', isActive: false },
];

const newAnalysis = (o: Partial<NewBsaAnalysis> = {}): NewBsaAnalysis => ({ orgId: ORG, branchId: BRANCH, applicationId: 'app-1', customerId: 'cust-1', ...o });
const sha = (n: number): string => n.toString(16).padStart(64, '0');
const txn = (seq: number, o: Partial<NewBsaTransaction> = {}): NewBsaTransaction => ({
  seq, txnDate: '2026-03-10', txnTime: null, direction: 'INCOME', amount: 100, balanceAfter: null, description: `Synthetic row ${seq}`,
  counterpartyAccount: null, counterpartyName: null, statementKey: 'stmt-1', dedupeKey: `k${seq}`, ...o,
});
const SNAPSHOT = {
  registerNo: 'ЦП99887766', lastName: 'Тестов', firstName: 'Синтетик', phone: '99001234', gender: null, note: null,
  declaredAccounts: [{ bankCode: 'KHAN', accountNo: '9900123456', iban: null, holderName: 'Тестов Синтетик', source: 'MANUAL' as const }],
};

export function describeRepositoryContract(name: string, factory: () => Promise<RepositoryHarness>): void {
  describe(`BsaRepository contract: ${name}`, () => {
    let h: RepositoryHarness;
    beforeAll(async () => {
      h = await factory();
    });
    afterAll(async () => {
      await h.close();
    });
    beforeEach(async () => {
      await h.reset();
      h.setNow(T0);
      await h.seedConfig(ORG, { categories: CATEGORIES });
    });

    const repo = (): BsaRepository => h.repo;
    const seedAnalysis = (o: Partial<NewBsaAnalysis> = {}) => repo().analyses.create(newAnalysis(o));
    const seedJob = (analysisId: string, n = 1) =>
      repo().importJobs.create({ analysisId, fileId: `files/${n}`, fileName: `statement-${n}.pdf`, mimeType: 'application/pdf', sizeBytes: 1000 + n, sha256: sha(n), format: 'PDF', bankCode: 'KHAN' });
    const seedBase = async () => {
      const analysis = await seedAnalysis();
      const job = await seedJob(analysis.id);
      return { analysis, job };
    };

    // ───────────────────────── analyses ─────────────────────────
    describe('analyses', () => {
      it('assigns versions per (org, application, customer) starting at 1 (INT-7)', async () => {
        const a1 = await seedAnalysis();
        expect(a1).toMatchObject({ version: 1, status: 'DRAFT', orgId: ORG, branchId: BRANCH, ownAccounts: [], summary: null, customer: null });
        expect((await seedAnalysis()).version).toBe(2);
        expect((await seedAnalysis({ customerId: 'cust-2' })).version).toBe(1);
        expect((await seedAnalysis({ applicationId: 'app-2' })).version).toBe(1);
        expect((await seedAnalysis({ orgId: 'org-2' })).version).toBe(1);
        expect((await seedAnalysis()).version).toBe(3);
        expect((await repo().analyses.findLatest(ORG, 'app-1', 'cust-1'))?.version).toBe(3);
        expect(await repo().analyses.findLatest(ORG, 'app-1', 'nobody')).toBeNull();
      });

      it('never hands out the same version to concurrent creates', async () => {
        const created = await Promise.all(Array.from({ length: 8 }, () => seedAnalysis()));
        expect(created.map((a) => a.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(new Set(created.map((a) => a.id)).size).toBe(8);
      });

      it('round-trips periods, decimals, customer snapshot and own accounts', async () => {
        const created = await seedAnalysis({
          borrowerId: 'b-1', periodFrom: '2026-03-10', periodTo: '2026-09-10', periodMonths: 6, proposedMonthlyPayment: 1234567.89, costOfGoodsRate: 0.1,
          customer: SNAPSHOT, ownAccounts: ['5000 0000 01', 'mn12 0000 0002', '5000000001'], createdBy: 'u-1',
        });
        const got = await repo().analyses.getById(created.id);
        expect(got).toEqual(created);
        expect(got).toMatchObject({
          borrowerId: 'b-1', periodFrom: '2026-03-10', periodTo: '2026-09-10', periodMonths: 6, proposedMonthlyPayment: 1234567.89, costOfGoodsRate: 0.1,
          customer: SNAPSHOT, ownAccounts: ['5000000001', 'MN1200000002'], createdBy: 'u-1', updatedBy: 'u-1',
        });
        expect(got?.registerNoHash).toMatch(/^[0-9a-f]{64}$/);
        expect(got?.registerNoHash).not.toContain(SNAPSHOT.registerNo);
        expect((await seedAnalysis({ proposedMonthlyPayment: 0.01 })).proposedMonthlyPayment).toBe(0.01);
      });

      it('rounds money half away from zero and rejects out-of-range numbers', async () => {
        expect((await seedAnalysis({ proposedMonthlyPayment: 1.005 })).proposedMonthlyPayment).toBe(1.01);
        expect((await seedAnalysis({ proposedMonthlyPayment: 0.1 + 0.2 })).proposedMonthlyPayment).toBe(0.3);
        await expect(seedAnalysis({ costOfGoodsRate: 1.5 })).rejects.toBeInstanceOf(BsaInvalidError);
        await expect(seedAnalysis({ proposedMonthlyPayment: -1 })).rejects.toBeInstanceOf(BsaInvalidError);
        await expect(seedAnalysis({ proposedMonthlyPayment: Number.NaN })).rejects.toBeInstanceOf(BsaInvalidError);
        await expect(seedAnalysis({ proposedMonthlyPayment: 1e20 })).rejects.toBeInstanceOf(BsaInvalidError);
      });

      it('rejects bad input with the field name only (never the value)', async () => {
        const secret = 'SECRET-VALUE-XYZ';
        const a = await seedAnalysis();
        const err = await repo().analyses.update(a.id, { status: secret as never }).catch((e) => e);
        expect(err).toBeInstanceOf(BsaInvalidError);
        expect(err.field).toBe('patch.status');
        expect(String(err.message)).not.toContain(secret);
        await expect(seedAnalysis({ periodFrom: '2026-02-30' })).rejects.toMatchObject({ code: 'INVALID' });
        await expect(seedAnalysis({ periodFrom: '2026-09-10', periodTo: '2026-03-10' })).rejects.toMatchObject({ code: 'INVALID' });
        await expect(seedAnalysis({ orgId: '' })).rejects.toMatchObject({ code: 'INVALID' });
      });

      it('update: undefined keeps, null clears, bumps updatedAt/updatedBy; unknown id is NOT_FOUND', async () => {
        const a = await seedAnalysis({ borrowerId: 'b-1', periodFrom: '2026-03-10', periodTo: '2026-09-10', customer: SNAPSHOT });
        h.setNow(new Date('2026-02-01T10:00:00.000Z'));
        const summary = {
          analysisId: a.id, loanApplicationId: 'app-1', borrowerId: 'b-1', status: 'ANALYZED' as const, version: 1, periodMonths: 6, periodFrom: '2026-03-10',
          periodTo: '2026-09-10', transactionCount: 10, totalMonthlyIncome: 1, verifiedMonthlyIncome: 1, dtiIncome: 1, businessIncomeMonthly: 1, businessExpenseMonthly: 0,
          netCashFlowMonthly: 1, existingDebtServiceMonthly: 0, incomeReliability: 100, dtiPercent: 6.8, dtiLevel: 'LOW' as const, pendingSuspiciousCount: 0, reportPdfUrl: null,
        };
        const analyzedAt = new Date('2026-02-01T09:59:00.000Z');
        const u = await repo().analyses.update(a.id, { status: 'ANALYZED', summary, analyzedAt, borrowerId: null, periodMonths: 6 }, 'u-9');
        expect(u).toMatchObject({ status: 'ANALYZED', summary, analyzedAt, borrowerId: null, periodMonths: 6, updatedBy: 'u-9', periodFrom: '2026-03-10', customer: SNAPSHOT });
        expect(u.updatedAt).toEqual(new Date('2026-02-01T10:00:00.000Z'));
        expect(u.createdAt).toEqual(T0);
        // customer: null → snapshot ба hash хоёулаа арилна
        const cleared = await repo().analyses.update(a.id, { customer: null, summary: null, analyzedAt: null });
        expect(cleared).toMatchObject({ customer: null, registerNoHash: null, summary: null, analyzedAt: null });
        await expect(repo().analyses.update('00000000-0000-4000-8000-000000000000', { status: 'DRAFT' })).rejects.toBeInstanceOf(BsaNotFoundError);
      });

      it('getById respects tenant and branch scope (not found, not forbidden)', async () => {
        const a = await seedAnalysis();
        expect(await repo().analyses.getById(a.id)).not.toBeNull();
        expect(await repo().analyses.getById(a.id, { orgId: ORG })).not.toBeNull();
        expect(await repo().analyses.getById(a.id, { orgId: ORG, branchId: BRANCH })).not.toBeNull();
        expect(await repo().analyses.getById(a.id, { orgId: 'org-2' })).toBeNull();
        expect(await repo().analyses.getById(a.id, { orgId: ORG, branchId: 'branch-2' })).toBeNull();
        expect(await repo().analyses.getById('00000000-0000-4000-8000-000000000000')).toBeNull();
      });

      it('list: filters, newest-first order, pagination and branch scoping', async () => {
        const created = [];
        for (let i = 0; i < 6; i += 1) {
          h.setNow(new Date(T0.getTime() + i * 1000));
          created.push(await seedAnalysis({ applicationId: `app-${i % 2}`, customerId: `c-${i}`, branchId: i < 4 ? 'branch-1' : 'branch-2', createdBy: i % 3 === 0 ? 'u-a' : 'u-b' }));
        }
        await repo().analyses.update(created[1].id, { status: 'ANALYZED' });
        await seedAnalysis({ orgId: 'org-2' });

        const all = await repo().analyses.list({ orgId: ORG });
        expect(all.total).toBe(6);
        expect(all.items.map((a) => a.id)).toEqual([...created].reverse().map((a) => a.id));
        expect((await repo().analyses.list({ orgId: ORG, branchId: 'branch-2' })).items.map((a) => a.customerId)).toEqual(['c-5', 'c-4']);
        expect((await repo().analyses.list({ orgId: ORG, branchId: 'branch-3' })).total).toBe(0);
        expect((await repo().analyses.list({ orgId: ORG, status: 'ANALYZED' })).items.map((a) => a.customerId)).toEqual(['c-1']);
        expect((await repo().analyses.list({ orgId: ORG, status: ['ANALYZED', 'DRAFT'] })).total).toBe(6);
        expect((await repo().analyses.list({ orgId: ORG, applicationId: 'app-0' })).total).toBe(3);
        expect((await repo().analyses.list({ orgId: ORG, createdBy: 'u-a' })).items.map((a) => a.customerId)).toEqual(['c-3', 'c-0']);
        expect((await repo().analyses.list({ orgId: ORG, createdFrom: new Date(T0.getTime() + 2000), createdTo: new Date(T0.getTime() + 4000) })).items.map((a) => a.customerId)).toEqual(['c-3', 'c-2']);
        const p2 = await repo().analyses.list({ orgId: ORG }, { limit: 2, offset: 2 });
        expect(p2).toMatchObject({ total: 6, limit: 2, offset: 2 });
        expect(p2.items.map((a) => a.customerId)).toEqual(['c-3', 'c-2']);
      });

      it('orders versions of the same customer newest first even when created in the same instant', async () => {
        for (let i = 0; i < 4; i += 1) await seedAnalysis();
        const { items } = await repo().analyses.list({ orgId: ORG, applicationId: 'app-1', customerId: 'cust-1' });
        expect(items.map((a) => a.version)).toEqual([4, 3, 2, 1]);
      });

      it('finds analyses by register number without storing it in clear (BSA-FR-1.2)', async () => {
        const a = await seedAnalysis({ customer: SNAPSHOT });
        await seedAnalysis({ customerId: 'c-2', customer: { ...SNAPSHOT, registerNo: 'ЦП11223344' } });
        for (const variant of ['ЦП99887766', ' цп 9988 7766 ', 'цп99887766']) {
          expect((await repo().analyses.list({ orgId: ORG, registerNo: variant })).items.map((x) => x.id)).toEqual([a.id]);
        }
        expect((await repo().analyses.list({ orgId: ORG, registerNo: 'ЦП00000000' })).total).toBe(0);
        expect((await repo().analyses.list({ orgId: 'org-2', registerNo: 'ЦП99887766' })).total).toBe(0);
      });

      it('listLatestByApplication returns the newest version per customer', async () => {
        await seedAnalysis({ customerId: 'b' });
        await seedAnalysis({ customerId: 'b' });
        const a1 = await seedAnalysis({ customerId: 'a' });
        await seedAnalysis({ applicationId: 'other', customerId: 'z' });
        const latest = await repo().analyses.listLatestByApplication(ORG, 'app-1');
        expect(latest.map((x) => [x.customerId, x.version])).toEqual([['a', 1], ['b', 2]]);
        expect(latest[0].id).toBe(a1.id);
        expect(await repo().analyses.listLatestByApplication('org-2', 'app-1')).toEqual([]);
      });

      it('moving an analysis to another branch moves its jobs with it (branch scoping stays consistent)', async () => {
        const { analysis, job } = await seedBase();
        await repo().transactions.bulkInsert(job.id, [txn(1)]);
        await repo().events.append({ analysisId: analysis.id, action: 'A' });
        await repo().analyses.update(analysis.id, { branchId: 'branch-2' });
        expect(await repo().importJobs.getById(job.id, { orgId: ORG, branchId: 'branch-2' })).not.toBeNull();
        expect(await repo().importJobs.getById(job.id, { orgId: ORG, branchId: BRANCH })).toBeNull();
        expect((await repo().importJobs.list({ orgId: ORG, branchId: 'branch-2' })).total).toBe(1);
        expect((await repo().analyses.list({ orgId: ORG, branchId: BRANCH })).total).toBe(0);
        await repo().analyses.update(analysis.id, { branchId: null });
        expect((await repo().importJobs.getById(job.id))?.branchId).toBeNull();
      });

      it('addOwnAccounts normalizes, de-duplicates and is atomic under concurrency (BSA-BR-5)', async () => {
        const a = await seedAnalysis({ ownAccounts: ['5000000001'] });
        h.setNow(new Date('2026-02-01T00:00:00.000Z'));
        expect(await repo().analyses.addOwnAccounts(a.id, [' 5000 0000 01', 'mn12 3'], 'u-1')).toEqual(['5000000001', 'MN123']);
        const unchanged = await repo().analyses.getById(a.id);
        h.setNow(new Date('2026-03-01T00:00:00.000Z'));
        expect(await repo().analyses.addOwnAccounts(a.id, ['mn123', ''])).toEqual(['5000000001', 'MN123']);
        expect((await repo().analyses.getById(a.id))?.updatedAt).toEqual(unchanged?.updatedAt);

        const accounts = Array.from({ length: 12 }, (_, i) => `ACC${String(i).padStart(3, '0')}`);
        await Promise.all(accounts.map((acc) => repo().analyses.addOwnAccounts(a.id, [acc])));
        const final = (await repo().analyses.getById(a.id))?.ownAccounts ?? [];
        expect([...final].sort()).toEqual([...accounts, '5000000001', 'MN123'].sort());
        await expect(repo().analyses.addOwnAccounts('00000000-0000-4000-8000-000000000000', ['x'])).rejects.toBeInstanceOf(BsaNotFoundError);
      });
    });

    // ───────────────────────── importJobs ─────────────────────────
    describe('importJobs', () => {
      it('creates a PENDING job with defaults and the analysis org/branch', async () => {
        const a = await seedAnalysis();
        const j = await seedJob(a.id);
        expect(j).toMatchObject({
          orgId: ORG, branchId: BRANCH, analysisId: a.id, fileId: 'files/1', fileName: 'statement-1.pdf', mimeType: 'application/pdf', sizeBytes: 1001, sha256: sha(1),
          bankCode: 'KHAN', format: 'PDF', status: 'PENDING', rowsTotal: 0, rowsDone: 0, errors: [], warnings: [], parserOk: null, verifierOk: null, qrVerified: null,
          attempts: 0, startedAt: null, finishedAt: null, accountNo: null, iban: null, holderName: null, periodFrom: null, periodTo: null,
        });
        expect(await repo().importJobs.getById(j.id)).toEqual(j);
        expect(await repo().importJobs.getById(j.id, { orgId: 'org-2' })).toBeNull();
        expect(await repo().importJobs.getById(j.id, { orgId: ORG, branchId: 'branch-9' })).toBeNull();
        await expect(seedJob('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(BsaNotFoundError);
      });

      it('maps a duplicate (analysis, sha256) to BsaDuplicateError with the existing job id', async () => {
        const a = await seedAnalysis();
        const first = await seedJob(a.id);
        const err = await repo().importJobs
          .create({ analysisId: a.id, fileId: 'files/other', fileName: 'again.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: sha(1).toUpperCase(), format: 'PDF' })
          .catch((e) => e);
        expect(err).toBeInstanceOf(BsaDuplicateError);
        expect(err).toMatchObject({ code: 'DUPLICATE', constraint: 'IMPORT_FILE', existingId: first.id });
        // Өөр шинжилгээнд ижил файл зөвшөөрөгдөнө
        const other = await seedAnalysis({ customerId: 'c-2' });
        await expect(seedJob(other.id)).resolves.toMatchObject({ analysisId: other.id });
        expect((await repo().importJobs.findBySha256(a.id, sha(1).toUpperCase()))?.id).toBe(first.id);
        expect(await repo().importJobs.findBySha256(a.id, sha(7))).toBeNull();
      });

      it('lets exactly one of several concurrent identical uploads win', async () => {
        const a = await seedAnalysis();
        const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => seedJob(a.id, 1).then((j) => ({ ...j, attempt: i }))));
        const won = attempts.filter((r) => r.status === 'fulfilled');
        const lost = attempts.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(4);
        for (const l of lost) expect(l.reason).toBeInstanceOf(BsaDuplicateError);
        expect((await repo().importJobs.list({ analysisId: a.id })).total).toBe(1);
      });

      it('rejects malformed jobs', async () => {
        const a = await seedAnalysis();
        const base = { analysisId: a.id, fileId: 'f', fileName: 'n.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: sha(5), format: 'PDF' as const };
        await expect(repo().importJobs.create({ ...base, sha256: 'xyz' })).rejects.toMatchObject({ code: 'INVALID', field: 'job.sha256' });
        await expect(repo().importJobs.create({ ...base, format: 'DOCX' as never })).rejects.toMatchObject({ code: 'INVALID', field: 'job.format' });
        await expect(repo().importJobs.create({ ...base, sizeBytes: -1 })).rejects.toMatchObject({ code: 'INVALID' });
      });

      it('update round-trips parse results, PII fields and tri-state flags', async () => {
        const a = await seedAnalysis();
        const j = await seedJob(a.id);
        h.setNow(new Date('2026-02-02T00:00:00.000Z'));
        const startedAt = new Date('2026-02-02T00:00:00.000Z');
        const u = await repo().importJobs.update(
          j.id,
          {
            status: 'COMPLETED', bankCode: 'GOLOMT', accountNo: '9900123456', iban: 'MN129900123456789', holderName: 'Тестов Синтетик', periodFrom: '2026-03-01', periodTo: '2026-08-31',
            rowsTotal: 2483, rowsDone: 2483, errors: [{ code: 'UNPARSED_ROW', message: 'row skipped', severity: 'WARNING', page: 2, line: 14 }],
            warnings: [{ code: 'UNVERIFIED_PARSER', message: 'heuristic parser' }], parserOk: true, verifierOk: false, qrVerified: null, attempts: 2, startedAt, finishedAt: startedAt,
          },
          'worker',
        );
        expect(u).toMatchObject({
          status: 'COMPLETED', bankCode: 'GOLOMT', accountNo: '9900123456', iban: 'MN129900123456789', holderName: 'Тестов Синтетик', periodFrom: '2026-03-01', periodTo: '2026-08-31',
          rowsTotal: 2483, rowsDone: 2483, parserOk: true, verifierOk: false, qrVerified: null, attempts: 2, startedAt, finishedAt: startedAt, updatedBy: 'worker',
          errors: [{ code: 'UNPARSED_ROW', message: 'row skipped', severity: 'WARNING', page: 2, line: 14 }], warnings: [{ code: 'UNVERIFIED_PARSER', message: 'heuristic parser' }],
        });
        expect(await repo().importJobs.getById(j.id)).toEqual(u);
        const cleared = await repo().importJobs.update(j.id, { accountNo: null, iban: null, holderName: null, qrVerified: true, bankCode: null, startedAt: null });
        expect(cleared).toMatchObject({ accountNo: null, iban: null, holderName: null, qrVerified: true, bankCode: null, startedAt: null, rowsTotal: 2483 });
        await expect(repo().importJobs.update(j.id, { status: 'DONE' as never })).rejects.toMatchObject({ code: 'INVALID' });
        await expect(repo().importJobs.update('00000000-0000-4000-8000-000000000000', { attempts: 1 })).rejects.toBeInstanceOf(BsaNotFoundError);
      });

      it('incrementRowsDone is an atomic increment (no lost updates)', async () => {
        const j = (await seedBase()).job;
        const results = await Promise.all(Array.from({ length: 25 }, () => repo().importJobs.incrementRowsDone(j.id, 2)));
        expect(results.every((r) => r.rowsDone >= 2 && r.rowsDone <= 50)).toBe(true);
        expect((await repo().importJobs.getById(j.id))?.rowsDone).toBe(50);
        await expect(repo().importJobs.incrementRowsDone(j.id, -1)).rejects.toMatchObject({ code: 'INVALID' });
        await expect(repo().importJobs.incrementRowsDone('00000000-0000-4000-8000-000000000000', 1)).rejects.toBeInstanceOf(BsaNotFoundError);
      });

      it('lists newest first with filters, pagination and status counts', async () => {
        const a = await seedAnalysis();
        const b = await seedAnalysis({ customerId: 'c-2', branchId: 'branch-2' });
        const jobs = [];
        for (let i = 1; i <= 5; i += 1) {
          h.setNow(new Date(T0.getTime() + i * 1000));
          jobs.push(await seedJob(i <= 3 ? a.id : b.id, i));
        }
        await repo().importJobs.update(jobs[0].id, { status: 'COMPLETED' });
        await repo().importJobs.update(jobs[1].id, { status: 'FAILED' });
        await repo().importJobs.update(jobs[4].id, { status: 'PROCESSING', bankCode: 'TDB' });

        expect((await repo().importJobs.list({ orgId: ORG })).items.map((j) => j.id)).toEqual([...jobs].reverse().map((j) => j.id));
        expect((await repo().importJobs.list({ analysisId: a.id })).total).toBe(3);
        expect((await repo().importJobs.list({ orgId: ORG, branchId: 'branch-2' })).total).toBe(2);
        expect((await repo().importJobs.list({ orgId: ORG, status: ['COMPLETED', 'FAILED'] })).total).toBe(2);
        expect((await repo().importJobs.list({ orgId: ORG, bankCode: 'TDB' })).items.map((j) => j.id)).toEqual([jobs[4].id]);
        expect((await repo().importJobs.list({ orgId: 'org-2' })).total).toBe(0);
        expect((await repo().importJobs.list({}, { limit: 2, offset: 3 })).items.map((j) => j.id)).toEqual([jobs[1].id, jobs[0].id]);
        expect(await repo().importJobs.countByStatus({ orgId: ORG })).toEqual({ PENDING: 2, PROCESSING: 1, COMPLETED: 1, FAILED: 1 });
        expect(await repo().importJobs.countByStatus({ analysisId: a.id })).toEqual({ PENDING: 1, PROCESSING: 0, COMPLETED: 1, FAILED: 1 });
        expect(await repo().importJobs.countByStatus({ orgId: 'org-2' })).toEqual({ PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 });
      });
    });

    // ───────────────────────── transactions ─────────────────────────
    describe('transactions', () => {
      const MIXED: NewBsaTransaction[] = [
        txn(1, { txnDate: '2026-03-01', txnTime: '09:00', amount: 1000, description: 'Цалин 3-р сар', counterpartyName: 'Бат Эрдэнэ', counterpartyAccount: '1111', channel: 'TRANSFER', categoryCode: 'SALARY', categoryGroup: 'A', confidence: 85 }),
        txn(2, { txnDate: '2026-03-01', direction: 'EXPENSE', amount: 250.5, description: 'QPay дэлгүүр', channel: 'QPAY', categoryCode: 'OTHER_EXPENSE', categoryGroup: '?', confidence: 60 }),
        txn(3, { txnDate: '2026-03-15', txnTime: '10:30:15', direction: 'EXPENSE', amount: 300, description: 'ATM бэлэн', channel: 'ATM' }),
        txn(4, { txnDate: '2026-04-01', amount: 5000, description: 'Өөрийн данс шилжүүлэг', isOwnTransfer: true, categoryCode: 'OWN_TRANSFER_IN', categoryGroup: '—', confidence: 95 }),
        txn(5, { txnDate: '2026-04-20', txnTime: '12:00', direction: 'EXPENSE', amount: 0.01, description: 'POS terminal', channel: 'POS' }),
        txn(6, { txnDate: '2026-04-20', amount: 1234567.89, balanceAfter: -0.01, description: 'Борлуулалт ORDER-7', categoryCode: 'BUSINESS_INCOME', categoryGroup: 'B', confidence: 85 }),
      ];
      const seedMixed = async () => {
        const base = await seedBase();
        const res = await repo().transactions.bulkInsert(base.job.id, MIXED);
        expect(res).toEqual({ inserted: 6, skipped: 0 });
        return base;
      };
      const seqs = (items: Array<{ seq: number }>): number[] => items.map((t) => t.seq);

      it('bulkInsert round-trips every field (decimals, nulls, Cyrillic, defaults)', async () => {
        const { analysis, job } = await seedBase();
        const row = txn(1, {
          txnDate: '2026-03-10', txnTime: '23:59:59', amount: 1234567.89, balanceAfter: 0.01, description: 'Цалин ✓ — "quoted" \\ backé', counterpartyAccount: '5011 22',
          counterpartyName: 'Бат-Эрдэнэ Ө.', channel: 'QPAY', categoryCode: 'SALARY', categoryGroup: 'A', confidence: 85.5, isOwnTransfer: false,
        });
        await repo().transactions.bulkInsert(job.id, [row, txn(2)]);
        const loaded = await repo().transactions.loadAll(analysis.id);
        const first = loaded.find((t) => t.seq === 1)!;
        const second = loaded.find((t) => t.seq === 2)!;
        expect(first).toMatchObject({ ...row, analysisId: analysis.id, importJobId: job.id, manualOverride: false, overrideBy: null });
        expect(first.id).toEqual(expect.any(String));
        expect(second).toMatchObject({ channel: 'OTHER', categoryCode: null, categoryGroup: null, confidence: 0, isOwnTransfer: false, txnTime: null, balanceAfter: null, counterpartyAccount: null, counterpartyName: null, description: 'Synthetic row 2' });
        expect(first.amount).toBe(1234567.89);
        expect(first.balanceAfter).toBe(0.01);
      });

      it('skips rows whose dedupe_key already exists (overlapping uploads) and rows duplicated inside the batch', async () => {
        const { analysis, job } = await seedBase();
        const job2 = await seedJob(analysis.id, 2);
        expect(await repo().transactions.bulkInsert(job.id, Array.from({ length: 10 }, (_, i) => txn(i + 1)))).toEqual({ inserted: 10, skipped: 0 });
        // 2-р хуулга 6–15 мөр: 6–10 давхцана
        const overlap = Array.from({ length: 10 }, (_, i) => txn(i + 1, { dedupeKey: `k${i + 6}`, description: `second file ${i}` }));
        expect(await repo().transactions.bulkInsert(job2.id, overlap)).toEqual({ inserted: 5, skipped: 5 });
        // багц доторх давхардал: эхнийх ялна
        const dupInBatch = [txn(1, { dedupeKey: 'new-a', description: 'first' }), txn(2, { dedupeKey: 'new-a', description: 'second' }), txn(3, { dedupeKey: 'new-b' })];
        expect(await repo().transactions.bulkInsert(job2.id, dupInBatch)).toEqual({ inserted: 2, skipped: 1 });
        expect(await repo().transactions.bulkInsert(job2.id, dupInBatch)).toEqual({ inserted: 0, skipped: 3 });
        const all = await repo().transactions.loadAll(analysis.id);
        expect(all).toHaveLength(17);
        expect(all.find((t) => t.dedupeKey === 'k7')?.importJobId).toBe(job.id);
        expect(all.find((t) => t.dedupeKey === 'new-a')?.description).toBe('first');
        // Өөр шинжилгээнд ижил dedupe_key давхардал биш
        const other = await seedAnalysis({ customerId: 'c-2' });
        const otherJob = await seedJob(other.id, 3);
        expect(await repo().transactions.bulkInsert(otherJob.id, [txn(1)])).toEqual({ inserted: 1, skipped: 0 });
        expect(await repo().transactions.bulkInsert(job.id, [])).toEqual({ inserted: 0, skipped: 0 });
      });

      it('bulkInsert is all-or-nothing: an invalid row stores nothing and the error names the row, not the value', async () => {
        const { analysis, job } = await seedBase();
        const err = await repo().transactions
          .bulkInsert(job.id, [txn(1), txn(2), txn(3, { amount: -5, description: 'LEAKY-DESCRIPTION' })])
          .catch((e) => e);
        expect(err).toBeInstanceOf(BsaInvalidError);
        expect(err.field).toBe('rows.2.amount');
        expect(String(err.message)).not.toContain('LEAKY');
        expect((await repo().transactions.counts(analysis.id)).total).toBe(0);
        for (const bad of [{ txnDate: '2026-13-01' }, { direction: 'SIDEWAYS' }, { channel: 'FAX' }, { confidence: 101 }, { txnTime: '25:00' }, { seq: 0 }, { dedupeKey: '' }]) {
          await expect(repo().transactions.bulkInsert(job.id, [txn(1, bad as never)])).rejects.toMatchObject({ code: 'INVALID' });
        }
        await expect(repo().transactions.bulkInsert('00000000-0000-4000-8000-000000000000', [txn(1)])).rejects.toBeInstanceOf(BsaNotFoundError);
      });

      it('list filters: job, date range, direction, category, channel, own transfer, manual, amount range', async () => {
        const { analysis, job } = await seedMixed();
        const q = (f: object) => repo().transactions.list({ analysisId: analysis.id, ...f });
        expect(seqs((await q({})).items)).toEqual([2, 1, 3, 4, 6, 5]);
        expect(seqs((await q({ importJobId: job.id })).items)).toHaveLength(6);
        expect((await q({ importJobId: '00000000-0000-4000-8000-000000000000' })).total).toBe(0);
        expect(seqs((await q({ dateFrom: '2026-03-15', dateTo: '2026-04-01' })).items)).toEqual([3, 4]);
        expect(seqs((await q({ dateFrom: '2026-04-20' })).items)).toEqual([6, 5]);
        expect(seqs((await q({ dateTo: '2026-03-01' })).items)).toEqual([2, 1]);
        expect(seqs((await q({ direction: 'EXPENSE' })).items)).toEqual([2, 3, 5]);
        expect(seqs((await q({ categoryCodes: ['SALARY', 'BUSINESS_INCOME'] })).items)).toEqual([1, 6]);
        expect(seqs((await q({ channel: 'QPAY' })).items)).toEqual([2]);
        expect(seqs((await q({ channel: ['ATM', 'POS'] })).items)).toEqual([3, 5]);
        expect(seqs((await q({ ownTransfer: true })).items)).toEqual([4]);
        expect((await q({ ownTransfer: false })).total).toBe(5);
        expect((await q({ manualOverride: true })).total).toBe(0);
        expect(seqs((await q({ amountMin: 300, amountMax: 1000 })).items)).toEqual([1, 3]);
        expect(seqs((await q({ amountMax: 0.01 })).items)).toEqual([5]);
        expect(seqs((await q({ direction: 'INCOME', dateFrom: '2026-03-02', amountMin: 5000 })).items)).toEqual([4, 6]);
        expect((await repo().transactions.list({ analysisId: '00000000-0000-4000-8000-000000000000' })).total).toBe(0);
      });

      it('list text filter matches description, counterparty name and account, case-insensitively (Cyrillic too)', async () => {
        const { analysis } = await seedMixed();
        const q = (text: string) => repo().transactions.list({ analysisId: analysis.id, text });
        expect(seqs((await q('цалин')).items)).toEqual([1]);
        expect(seqs((await q('ЦАЛИН')).items)).toEqual([1]);
        expect(seqs((await q('qpay')).items)).toEqual([2]);
        expect(seqs((await q('order-7')).items)).toEqual([6]);
        expect(seqs((await q('бат эрдэнэ')).items)).toEqual([1]);
        expect(seqs((await q('1111')).items)).toEqual([1]);
        expect((await q('нэг ч таарахгүй')).total).toBe(0);
        const paged = await repo().transactions.list({ analysisId: analysis.id, text: 'a', direction: 'EXPENSE' }, { limit: 1, offset: 1 });
        expect(paged.total).toBe(3);
        expect(seqs(paged.items)).toEqual([3]);
      });

      it('sorts by date (empty time first), amount, and the exact reverse for DESC', async () => {
        const { analysis } = await seedMixed();
        const order = async (sort: 'DATE_ASC' | 'DATE_DESC' | 'AMOUNT_ASC' | 'AMOUNT_DESC') => seqs((await repo().transactions.list({ analysisId: analysis.id, sort })).items);
        expect(await order('DATE_ASC')).toEqual([2, 1, 3, 4, 6, 5]);
        expect(await order('DATE_DESC')).toEqual([5, 6, 4, 3, 1, 2]);
        expect(await order('AMOUNT_DESC')).toEqual([6, 4, 1, 3, 2, 5]);
        expect(await order('AMOUNT_ASC')).toEqual([5, 2, 3, 1, 4, 6]);
        expect(seqs(await repo().transactions.loadAll(analysis.id))).toEqual([2, 1, 3, 4, 6, 5]);
      });

      it('paginates stably even when every row ties on date, time and seq', async () => {
        const { analysis, job } = await seedBase();
        await repo().transactions.bulkInsert(job.id, Array.from({ length: 250 }, (_, i) => txn(1, { dedupeKey: `tie-${i}`, description: `row ${i}` })));
        const full = (await repo().transactions.loadAll(analysis.id)).map((t) => t.id);
        expect(new Set(full).size).toBe(250);
        for (const sort of ['DATE_ASC', 'DATE_DESC'] as const) {
          const walked: string[] = [];
          for (let offset = 0; offset < 250; offset += 37) {
            const page = await repo().transactions.list({ analysisId: analysis.id, sort }, { limit: 37, offset });
            expect(page.total).toBe(250);
            walked.push(...page.items.map((t) => t.id));
          }
          expect(walked).toEqual(sort === 'DATE_ASC' ? full : [...full].reverse());
        }
        const beyond = await repo().transactions.list({ analysisId: analysis.id }, { limit: 10, offset: 1000 });
        expect(beyond).toMatchObject({ items: [], total: 250, offset: 1000 });
      });

      it('clamps the page size to MAX_PAGE_SIZE and rejects nonsense paging', async () => {
        const { analysis } = await seedMixed();
        expect((await repo().transactions.list({ analysisId: analysis.id }, { limit: MAX_PAGE_SIZE * 10 })).limit).toBe(MAX_PAGE_SIZE);
        expect((await repo().transactions.list({ analysisId: analysis.id })).limit).toBeGreaterThan(0);
        await expect(repo().transactions.list({ analysisId: analysis.id }, { limit: 0 })).rejects.toMatchObject({ code: 'INVALID' });
        await expect(repo().transactions.list({ analysisId: analysis.id }, { limit: 1.5 })).rejects.toMatchObject({ code: 'INVALID' });
        await expect(repo().transactions.list({ analysisId: analysis.id }, { offset: -1 })).rejects.toMatchObject({ code: 'INVALID' });
        await expect(repo().transactions.list({ analysisId: analysis.id, direction: 'UP' as never })).rejects.toMatchObject({ code: 'INVALID' });
      });

      it('updateClassifications stores results, never touches manual rows and ignores foreign or repeated ids', async () => {
        const { analysis } = await seedMixed();
        const other = await seedAnalysis({ customerId: 'c-2' });
        const otherJob = await seedJob(other.id, 9);
        await repo().transactions.bulkInsert(otherJob.id, [txn(1)]);
        const foreign = (await repo().transactions.loadAll(other.id))[0];
        const rows = await repo().transactions.loadAll(analysis.id);
        const bySeq = (s: number) => rows.find((r) => r.seq === s)!;
        await repo().transactions.setManualCategory(analysis.id, [bySeq(3).id], 'LOAN_PAYMENT', 'u-1');

        const upd = (id: string, o: object = {}) => ({ id, categoryCode: 'OTHER_EXPENSE', categoryGroup: '?', confidence: 30.456, channel: 'POS' as const, isOwnTransfer: false, ...o });
        h.setNow(new Date('2026-05-05T00:00:00.000Z'));
        const res = await repo().transactions.updateClassifications(
          analysis.id,
          [upd(bySeq(2).id), upd(bySeq(3).id), upd(foreign.id), upd(bySeq(5).id, { categoryCode: 'LOAN_PAYMENT', categoryGroup: 'A' }), upd(bySeq(5).id, { categoryCode: 'OTHER_EXPENSE', confidence: 99 }), upd('00000000-0000-4000-8000-000000000000')],
          'u-2',
        );
        expect(res).toEqual({ updated: 2, skipped: 3 });
        const after = await repo().transactions.loadAll(analysis.id);
        expect(after.find((r) => r.seq === 2)).toMatchObject({ categoryCode: 'OTHER_EXPENSE', categoryGroup: '?', confidence: 30.46, channel: 'POS', isOwnTransfer: false });
        expect(after.find((r) => r.seq === 5)).toMatchObject({ categoryCode: 'OTHER_EXPENSE', confidence: 99 }); // сүүлийнх ялна
        expect(after.find((r) => r.seq === 3)).toMatchObject({ categoryCode: 'LOAN_PAYMENT', manualOverride: true, confidence: MANUAL_OVERRIDE_CONFIDENCE, channel: 'ATM' });
        expect((await repo().transactions.loadAll(other.id))[0]).toEqual(foreign);
        expect(after.find((r) => r.seq === 1)).toEqual(bySeq(1));
        await expect(repo().transactions.updateClassifications(analysis.id, [upd(bySeq(1).id, { confidence: 120 })])).rejects.toMatchObject({ code: 'INVALID' });
        expect(await repo().transactions.updateClassifications(analysis.id, [])).toEqual({ updated: 0, skipped: 0 });
      });

      it('setManualCategory sets category, group, manual flags and clears own-transfer (BSA-FR-3.3)', async () => {
        const { analysis } = await seedMixed();
        const rows = await repo().transactions.loadAll(analysis.id);
        const own = rows.find((r) => r.seq === 4)!;
        const salaryRow = rows.find((r) => r.seq === 6)!;
        expect(own.isOwnTransfer).toBe(true);
        expect(await repo().transactions.setManualCategory(analysis.id, [own.id, salaryRow.id], 'SALARY', 'u-7')).toBe(2);
        const after = await repo().transactions.loadAll(analysis.id);
        for (const seq of [4, 6]) {
          expect(after.find((r) => r.seq === seq)).toMatchObject({
            categoryCode: 'SALARY', categoryGroup: 'A', manualOverride: true, overrideBy: 'u-7', confidence: MANUAL_OVERRIDE_CONFIDENCE, isOwnTransfer: false,
          });
        }
        expect((await repo().transactions.list({ analysisId: analysis.id, manualOverride: true })).total).toBe(2);
        expect(await repo().transactions.setManualCategory(analysis.id, [], 'SALARY', 'u-7')).toBe(0);
        // Өөр шинжилгээний id-г хөндөхгүй
        const other = await seedAnalysis({ customerId: 'c-2' });
        expect(await repo().transactions.setManualCategory(other.id, [own.id], 'SALARY', 'u-7')).toBe(0);
      });

      it('setManualCategory rejects unknown, inactive and wrong-direction categories without changing anything', async () => {
        const { analysis } = await seedMixed();
        const rows = await repo().transactions.loadAll(analysis.id);
        const income = rows.find((r) => r.seq === 1)!;
        const expense = rows.find((r) => r.seq === 2)!;
        await expect(repo().transactions.setManualCategory(analysis.id, [income.id], 'NO_SUCH', 'u')).rejects.toMatchObject({ code: 'INVALID', field: 'categoryCode' });
        await expect(repo().transactions.setManualCategory(analysis.id, [income.id], 'RETIRED_EXPENSE', 'u')).rejects.toMatchObject({ code: 'INVALID' });
        // 2 гүйлгээний нэг нь чиглэл таарахгүй → бүгд буцна (атомар)
        await expect(repo().transactions.setManualCategory(analysis.id, [income.id, expense.id], 'LOAN_PAYMENT', 'u')).rejects.toMatchObject({ code: 'INVALID' });
        expect((await repo().transactions.list({ analysisId: analysis.id, manualOverride: true })).total).toBe(0);
        await expect(repo().transactions.setManualCategory('00000000-0000-4000-8000-000000000000', [income.id], 'SALARY', 'u')).rejects.toBeInstanceOf(BsaNotFoundError);
      });

      it('deleteByJob removes only that job rows and keeps the job (re-import)', async () => {
        const { analysis, job } = await seedBase();
        const job2 = await seedJob(analysis.id, 2);
        await repo().transactions.bulkInsert(job.id, [txn(1), txn(2), txn(3)]);
        await repo().transactions.bulkInsert(job2.id, [txn(1, { dedupeKey: 'j2-1' }), txn(2, { dedupeKey: 'j2-2' })]);
        expect(await repo().transactions.deleteByJob(job.id)).toBe(3);
        expect(await repo().transactions.deleteByJob(job.id)).toBe(0);
        expect((await repo().transactions.loadAll(analysis.id)).map((t) => t.dedupeKey)).toEqual(['j2-1', 'j2-2']);
        expect(await repo().importJobs.getById(job.id)).not.toBeNull();
        // устгасны дараа ижил dedupe_key-тэй мөр дахин орно
        expect(await repo().transactions.bulkInsert(job.id, [txn(1)])).toEqual({ inserted: 1, skipped: 0 });
      });

      it('counts totals, directions, own transfers, manual overrides, unclassified, per category and per job', async () => {
        const { analysis, job } = await seedMixed();
        const job2 = await seedJob(analysis.id, 2);
        await repo().transactions.bulkInsert(job2.id, [txn(1, { dedupeKey: 'x1', categoryCode: 'SALARY', categoryGroup: 'A' })]);
        const rows = await repo().transactions.loadAll(analysis.id);
        await repo().transactions.setManualCategory(analysis.id, [rows.find((r) => r.seq === 3)!.id], 'LOAN_PAYMENT', 'u');
        const c = await repo().transactions.counts(analysis.id);
        expect(c).toMatchObject({ total: 7, income: 4, expense: 3, ownTransfers: 1, manualOverrides: 1, unclassified: 1 });
        expect(c.byCategory).toEqual([
          { categoryCode: 'BUSINESS_INCOME', direction: 'INCOME', count: 1 },
          { categoryCode: 'LOAN_PAYMENT', direction: 'EXPENSE', count: 1 },
          { categoryCode: 'OTHER_EXPENSE', direction: 'EXPENSE', count: 1 },
          { categoryCode: 'OWN_TRANSFER_IN', direction: 'INCOME', count: 1 },
          { categoryCode: 'SALARY', direction: 'INCOME', count: 2 },
        ]);
        expect(c.byImportJob).toEqual([{ importJobId: job.id, count: 6 }, { importJobId: job2.id, count: 1 }].sort((a, b) => (a.importJobId < b.importJobId ? -1 : 1)));
        expect(await repo().transactions.counts('00000000-0000-4000-8000-000000000000')).toMatchObject({ total: 0, byCategory: [], byImportJob: [] });
      });

      it('handles a 5,000-row batch (insert, classify, load) well inside 5 seconds', async () => {
        const { analysis, job } = await seedBase();
        const rows = Array.from({ length: 5000 }, (_, i) =>
          txn(i + 1, {
            txnDate: `2026-0${(i % 6) + 1}-${String((i % 27) + 1).padStart(2, '0')}`, direction: i % 3 === 0 ? 'EXPENSE' : 'INCOME', amount: 1000 + (i % 977) + 0.55,
            balanceAfter: 10_000_000 + i, description: `Synthetic bulk row ${i} with some longer free text to be encrypted`, counterpartyAccount: `ACC${i % 50}`, counterpartyName: `Name ${i % 40}`,
          }),
        );
        const t0 = performance.now();
        expect(await repo().transactions.bulkInsert(job.id, rows)).toEqual({ inserted: 5000, skipped: 0 });
        const tInsert = performance.now() - t0;
        const t1 = performance.now();
        const all = await repo().transactions.loadAll(analysis.id);
        const tLoad = performance.now() - t1;
        expect(all).toHaveLength(5000);
        const t2 = performance.now();
        const res = await repo().transactions.updateClassifications(
          analysis.id,
          all.map((t) => ({ id: t.id, categoryCode: t.direction === 'INCOME' ? 'SALARY' : 'OTHER_EXPENSE', categoryGroup: 'A', confidence: 85, channel: 'TRANSFER' as const, isOwnTransfer: false })),
        );
        const tClassify = performance.now() - t2;
        expect(res).toEqual({ updated: 5000, skipped: 0 });
        expect(tInsert).toBeLessThan(5000);
        expect(tLoad).toBeLessThan(5000);
        expect(tClassify).toBeLessThan(5000);
        expect((await repo().transactions.counts(analysis.id)).unclassified).toBe(0);
        expect(await repo().transactions.bulkInsert(job.id, rows)).toEqual({ inserted: 0, skipped: 5000 });
      }, 30_000);
    });

    // ───────────────────────── events ─────────────────────────
    describe('events', () => {
      it('appends and lists newest first with stable pagination and JSON-clean details', async () => {
        const a = await seedAnalysis();
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          h.setNow(new Date(T0.getTime() + Math.floor(i / 2) * 1000)); // хос хос нэг мөчид
          ids.push((await repo().events.append({ analysisId: a.id, action: `STEP_${i}`, actorId: i % 2 ? 'u-1' : null, detail: { n: i, when: new Date('2026-02-02T00:00:00.000Z'), skip: undefined } })).id);
        }
        const first = await repo().events.list(a.id);
        expect(first.total).toBe(5);
        const actions = first.items.map((e) => e.action);
        expect(actions[0]).toBe('STEP_4');
        expect(actions.slice(1, 3).sort()).toEqual(['STEP_2', 'STEP_3']); // нэг мөчийн хос: id-аар тогтвортой
        expect(actions.slice(3).sort()).toEqual(['STEP_0', 'STEP_1']);
        expect(first.items.map((e) => e.at.getTime())).toEqual([...first.items.map((e) => e.at.getTime())].sort((x, y) => y - x));
        expect(first.items[0].detail).toEqual({ n: 4, when: '2026-02-02T00:00:00.000Z' });
        const walked: string[] = [];
        for (let offset = 0; offset < 5; offset += 2) walked.push(...(await repo().events.list(a.id, { limit: 2, offset })).items.map((e) => e.id));
        expect(walked).toEqual(first.items.map((e) => e.id));
        expect(new Set(walked)).toEqual(new Set(ids));
      });

      it('supports explicit timestamps, null detail, and rejects unknown analyses and bad actions', async () => {
        const a = await seedAnalysis();
        const at = new Date('2025-12-31T23:59:59.000Z');
        const e = await repo().events.append({ analysisId: a.id, action: 'PUSHED_TO_LOS', at });
        expect(e).toMatchObject({ analysisId: a.id, action: 'PUSHED_TO_LOS', actorId: null, detail: null, at });
        await expect(repo().events.append({ analysisId: '00000000-0000-4000-8000-000000000000', action: 'X' })).rejects.toBeInstanceOf(BsaNotFoundError);
        await expect(repo().events.append({ analysisId: a.id, action: '' })).rejects.toMatchObject({ code: 'INVALID' });
        expect((await repo().events.list('00000000-0000-4000-8000-000000000000')).total).toBe(0);
      });
    });

    // ───────────────────────── config ─────────────────────────
    describe('config', () => {
      it('lists all categories (active and inactive) of the org ordered by code', async () => {
        await h.seedConfig('org-2', { categories: [{ ...CATEGORIES[0], name: 'Өөр байгууллага' }] });
        const cats = await repo().config.listCategories(ORG);
        expect(cats.map((c) => c.code)).toEqual(['BUSINESS_INCOME', 'LOAN_PAYMENT', 'OTHER_EXPENSE', 'OWN_TRANSFER_IN', 'RETIRED_EXPENSE', 'SALARY']);
        expect(cats.find((c) => c.code === 'BUSINESS_INCOME')).toEqual(CATEGORIES[1]);
        expect(cats.find((c) => c.code === 'RETIRED_EXPENSE')?.isActive).toBe(false);
        expect((await repo().config.listCategories('org-2')).map((c) => c.name)).toEqual(['Өөр байгууллага']);
        expect(await repo().config.listCategories('org-3')).toEqual([]);
      });

      it('creates rules (ids, priority order, duplicates, validation) and hides deactivated ones', async () => {
        const base = { direction: 'INCOME' as const, matchType: 'KEYWORD' as const, categoryCode: 'SALARY', source: 'ADMIN' as const };
        h.setNow(new Date(T0.getTime() + 1000));
        const low = await repo().config.createRule(ORG, { ...base, pattern: 'цалин', priority: 200 }, 'admin');
        h.setNow(new Date(T0.getTime() + 2000));
        const high = await repo().config.createRule(ORG, { ...base, pattern: 'урамшуулал', priority: 300 });
        h.setNow(new Date(T0.getTime() + 3000));
        const tie = await repo().config.createRule(ORG, { ...base, pattern: 'бонус', priority: 200, source: 'FEEDBACK' });
        expect(low.id).toEqual(expect.any(String));
        expect(low).toMatchObject({ ...base, pattern: 'цалин', priority: 200 });
        expect((await repo().config.listRules(ORG)).map((r) => r.id)).toEqual([high.id, low.id, tie.id]);
        expect(await repo().config.listRules('org-2')).toEqual([]);

        const err = await repo().config.createRule(ORG, { ...base, pattern: 'цалин', priority: 999 }).catch((e) => e);
        expect(err).toBeInstanceOf(BsaDuplicateError);
        expect(err).toMatchObject({ code: 'DUPLICATE', constraint: 'RULE' });
        // ижил хэв, өөр source/ангилал бол өөр дүрэм (дарах дүрэм)
        await expect(repo().config.createRule(ORG, { ...base, pattern: 'цалин', priority: 1000, source: 'FEEDBACK' })).resolves.toMatchObject({ source: 'FEEDBACK' });
        await expect(repo().config.createRule(ORG, { ...base, pattern: 'x', priority: 1, categoryCode: 'NO_SUCH' })).rejects.toMatchObject({ code: 'INVALID', field: 'categoryCode' });
        await expect(repo().config.createRule(ORG, { ...base, pattern: 'x', priority: 1, categoryCode: 'LOAN_PAYMENT' })).rejects.toMatchObject({ code: 'INVALID' });
        await expect(repo().config.createRule(ORG, { ...base, pattern: '', priority: 1 })).rejects.toMatchObject({ code: 'INVALID' });
        await expect(repo().config.createRule(ORG, { ...base, pattern: 'x', priority: 1.5 })).rejects.toMatchObject({ code: 'INVALID' });

        await repo().config.setRuleActive(ORG, high.id, false, 'admin');
        expect((await repo().config.listRules(ORG)).map((r) => r.id)).not.toContain(high.id);
        await repo().config.setRuleActive(ORG, high.id, true);
        expect((await repo().config.listRules(ORG)).map((r) => r.id)).toContain(high.id);
        await expect(repo().config.setRuleActive('org-2', high.id, false)).rejects.toBeInstanceOf(BsaNotFoundError);
        await expect(repo().config.setRuleActive(ORG, '00000000-0000-4000-8000-000000000000', false)).rejects.toBeInstanceOf(BsaNotFoundError);
      });
    });

    // ───────────────────────── retention ─────────────────────────
    describe('retention', () => {
      it('findExpired returns analyses created before the cutoff, oldest first, limited and org-scoped (BSA-BR-8)', async () => {
        const made = [];
        for (let i = 0; i < 4; i += 1) {
          h.setNow(new Date(T0.getTime() + i * 86_400_000));
          made.push(await seedAnalysis({ customerId: `c-${i}`, orgId: i === 3 ? 'org-2' : ORG }));
        }
        const cutoff = new Date(T0.getTime() + 3 * 86_400_000);
        const found = await repo().retention.findExpired(cutoff, 10);
        expect(found.map((f) => f.id)).toEqual([made[0].id, made[1].id, made[2].id]);
        expect(found[0]).toEqual({ id: made[0].id, orgId: ORG, applicationId: 'app-1', createdAt: T0 });
        expect((await repo().retention.findExpired(cutoff, 2)).map((f) => f.id)).toEqual([made[0].id, made[1].id]);
        expect((await repo().retention.findExpired(new Date(T0.getTime() + 10 * 86_400_000), 10, 'org-2')).map((f) => f.id)).toEqual([made[3].id]);
        expect(await repo().retention.findExpired(T0, 10)).toEqual([]); // cutoff нь exclusive
        await expect(repo().retention.findExpired(cutoff, 0)).rejects.toMatchObject({ code: 'INVALID' });
      });

      it('purge removes the analysis with jobs, transactions and events, returns object keys, leaves others', async () => {
        const { analysis, job } = await seedBase();
        const job2 = await seedJob(analysis.id, 2);
        await repo().transactions.bulkInsert(job.id, [txn(1), txn(2)]);
        await repo().transactions.bulkInsert(job2.id, [txn(1, { dedupeKey: 'b1' })]);
        await repo().events.append({ analysisId: analysis.id, action: 'A' });
        await repo().events.append({ analysisId: analysis.id, action: 'B' });
        const keep = await seedAnalysis({ customerId: 'c-2' });
        const keepJob = await seedJob(keep.id, 3);
        await repo().transactions.bulkInsert(keepJob.id, [txn(1)]);
        await repo().events.append({ analysisId: keep.id, action: 'A' });

        const purged = await repo().retention.purge(analysis.id);
        expect({ ...purged, objectKeys: [...purged.objectKeys].sort() }).toEqual({
          analysisId: analysis.id, objectKeys: ['files/1', 'files/2'], counts: { importJobs: 2, transactions: 3, events: 2 },
        });
        expect(await repo().analyses.getById(analysis.id)).toBeNull();
        expect(await repo().importJobs.getById(job.id)).toBeNull();
        expect(await repo().transactions.loadAll(analysis.id)).toEqual([]);
        expect((await repo().events.list(analysis.id)).total).toBe(0);
        expect((await repo().transactions.loadAll(keep.id))).toHaveLength(1);
        expect((await repo().events.list(keep.id)).total).toBe(1);
        expect(await repo().importJobs.getById(keepJob.id)).not.toBeNull();
        await expect(repo().retention.purge(analysis.id)).rejects.toBeInstanceOf(BsaNotFoundError);
        // dedupe_key-үүд чөлөөлөгдсөн: шинэ хувилбар дээр дахин импортлож болно
        const again = await seedAnalysis();
        expect(again.version).toBe(1);
      });
    });

    // ───────────────────────── runInTransaction ─────────────────────────
    describe('runInTransaction', () => {
      it('commits every write made through the transactional repo', async () => {
        const out = await repo().runInTransaction(async (tx, token) => {
          expect(token).toBeTruthy();
          const a = await tx.analyses.create(newAnalysis());
          const j = await tx.importJobs.create({ analysisId: a.id, fileId: 'files/tx', fileName: 'tx.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: sha(42), format: 'PDF' });
          await tx.transactions.bulkInsert(j.id, [txn(1), txn(2)]);
          await tx.events.append({ analysisId: a.id, action: 'CREATED' });
          // read-your-own-writes
          expect((await tx.transactions.counts(a.id)).total).toBe(2);
          return a.id;
        });
        expect(await repo().analyses.getById(out)).not.toBeNull();
        expect((await repo().transactions.counts(out)).total).toBe(2);
        expect((await repo().events.list(out)).total).toBe(1);
      });

      it('rolls everything back when the callback throws and rethrows the original error', async () => {
        const boom = new Error('boom');
        let analysisId = '';
        await expect(
          repo().runInTransaction(async (tx) => {
            const a = await tx.analyses.create(newAnalysis());
            analysisId = a.id;
            const j = await tx.importJobs.create({ analysisId: a.id, fileId: 'files/tx', fileName: 'tx.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: sha(42), format: 'PDF' });
            await tx.transactions.bulkInsert(j.id, [txn(1), txn(2)]);
            await tx.events.append({ analysisId: a.id, action: 'CREATED' });
            await tx.analyses.addOwnAccounts(a.id, ['X1']);
            throw boom;
          }),
        ).rejects.toBe(boom);
        expect(analysisId).not.toBe('');
        expect(await repo().analyses.getById(analysisId)).toBeNull();
        expect((await repo().analyses.list({ orgId: ORG })).total).toBe(0);
        expect((await repo().importJobs.list({})).total).toBe(0);
        // rollback-ийн дараа repo хэвийн ажиллана, хувилбар 1-ээс эхэлнэ
        expect((await seedAnalysis()).version).toBe(1);
      });

      it('rolls back writes made to previously committed rows too, and survives a domain error inside', async () => {
        const { analysis, job } = await seedBase();
        await repo().transactions.bulkInsert(job.id, [txn(1)]);
        await expect(
          repo().runInTransaction(async (tx) => {
            await tx.analyses.update(analysis.id, { status: 'ANALYZED' });
            await tx.importJobs.update(job.id, { status: 'FAILED' });
            await tx.transactions.deleteByJob(job.id);
            await expect(tx.importJobs.create({ analysisId: analysis.id, fileId: 'dup', fileName: 'd.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: sha(1), format: 'PDF' })).rejects.toBeInstanceOf(BsaDuplicateError);
            throw new Error('abort');
          }),
        ).rejects.toThrow('abort');
        expect((await repo().analyses.getById(analysis.id))?.status).toBe('DRAFT');
        expect((await repo().importJobs.getById(job.id))?.status).toBe('PENDING');
        expect((await repo().transactions.counts(analysis.id)).total).toBe(1);
      });

      it('joins the outer transaction when nested', async () => {
        const boom = new Error('outer');
        let innerId = '';
        await expect(
          repo().runInTransaction(async (tx) => {
            innerId = await tx.runInTransaction(async (inner) => (await inner.analyses.create(newAnalysis())).id);
            expect(await tx.analyses.getById(innerId)).not.toBeNull();
            throw boom;
          }),
        ).rejects.toBe(boom);
        expect(await repo().analyses.getById(innerId)).toBeNull();
        const committed = await repo().runInTransaction((tx) => tx.runInTransaction(async (inner) => (await inner.analyses.create(newAnalysis())).id));
        expect(await repo().analyses.getById(committed)).not.toBeNull();
      });

      it('serializes version assignment across concurrent transactions on the same customer', async () => {
        const versions = await Promise.all(
          Array.from({ length: 5 }, () => repo().runInTransaction(async (tx) => (await tx.analyses.create(newAnalysis())).version)),
        );
        expect([...versions].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
      });

      it('runs concurrent transactions without losing or mixing writes', async () => {
        const ids = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            repo().runInTransaction(async (tx) => {
              const a = await tx.analyses.create(newAnalysis({ customerId: `c-${i}` }));
              await tx.events.append({ analysisId: a.id, action: `E${i}` });
              return a.id;
            }),
          ),
        );
        expect((await repo().analyses.list({ orgId: ORG })).total).toBe(6);
        for (const id of ids) expect((await repo().events.list(id)).total).toBe(1);
      });
    });

    // ───────────────────────── PII at rest ─────────────────────────
    describe('PII at rest', () => {
      it('stores no plaintext PII in any BSA table', async () => {
        if (!h.rawDump) return; // зөвхөн DB хэрэгжүүлэлт
        const a = await seedAnalysis({ customer: SNAPSHOT, ownAccounts: ['9900123456', 'MN129900123456789'] });
        const j = await repo().importJobs.create({
          analysisId: a.id, fileId: 'files/opaque-1', fileName: 'statement_9900123456_Тестов.pdf', mimeType: 'application/pdf', sizeBytes: 5, sha256: sha(77), format: 'PDF', bankCode: 'KHAN',
        });
        await repo().importJobs.update(j.id, { accountNo: '9900123456', iban: 'MN129900123456789', holderName: 'Тестов Синтетик' });
        await repo().transactions.bulkInsert(j.id, [
          txn(1, { description: 'Синтетик гүйлгээний утга ALPHA-7731', counterpartyAccount: '9900654321', counterpartyName: 'Контрагент Тестов', dedupeKey: 'opaque-dedupe-1' }),
        ]);
        await repo().events.append({ analysisId: a.id, action: 'IMPORT_COMPLETED', detail: { rows: 1 } });
        const dump = await h.rawDump();
        expect(dump).toContain('opaque-dedupe-1'); // хяналт: dump үнэхээр мөрүүдийг агуулж байна
        expect(dump).toContain('files/opaque-1');
        for (const secret of ['ЦП99887766', '99001234', 'Тестов', 'Синтетик', '9900123456', '9900654321', 'MN129900123456789', 'ALPHA-7731', 'Контрагент']) {
          expect(dump, `plaintext leaked: ${secret.length} chars`).not.toContain(secret);
        }
        // дахин унших нь бүгдийг буцаана
        expect((await repo().analyses.getById(a.id))?.customer).toEqual(SNAPSHOT);
        expect(await repo().importJobs.getById(j.id)).toMatchObject({ fileName: 'statement_9900123456_Тестов.pdf', accountNo: '9900123456', holderName: 'Тестов Синтетик' });
        expect((await repo().transactions.loadAll(a.id))[0]).toMatchObject({ description: 'Синтетик гүйлгээний утга ALPHA-7731', counterpartyAccount: '9900654321' });
      });
    });
  });
}
