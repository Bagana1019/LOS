import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReportDefinitionView, ReportKey } from '@los/contracts';
import { actors, hasTestDb, ORG } from '../../test-utils/factories';
import { createTestApp } from '../../test-utils/test-app';
import { CORE_DEPOSIT_PORT } from '../../integrations/core-deposit/core-deposit.provider';
import { RealCoreDepositPort } from '../../integrations/core-deposit/core-deposit.real';
import { ReportModule } from './report.module';
import { createExactSchedule, createPayment, OTHER_ORG, rowsOf, seedBulkLoans, seedOtherOrgLoan, type World } from './report.fixtures';
import { bootReport, col, getReport, resetAndSeed, resetReport, ReportEnv } from './report.test-helpers';
import request from 'supertest';
import { createApplication, createBorrower, createCustomer } from '../../test-utils/factories';

const SQL_REPORTS = ['upcoming-repayments', 'overdue-loans', 'outstanding-balance', 'closed-loans', 'disbursed-loans', 'interest-payments', 'collateral-assets', 'pipeline-progress'] as const;
const WIDE = { dateFrom: '2000-01-01', dateTo: '2100-01-01' }; // огноо шүүлттэй тайланд бүх мөрийг авахын тулд

describe.skipIf(!hasTestDb)('report: эрх, хүрээ, шүүлт, хуудаслалт, аюулгүй байдал (HTTP)', () => {
  let env: ReportEnv;
  let w: World;
  const admin = actors.admin();
  beforeAll(async () => { env = await bootReport(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { w = await resetAndSeed(env); });

  const get = (headers: Record<string, string>, path: string, query: Record<string, string | number> = {}) => env.http().get(`/api${path}`).query(query).set(headers);

  describe('эрх (401/403/404)', () => {
    const paths = ['/reports', '/reports/dashboard/summary', '/reports/overdue-loans', '/reports/overdue-loans/export'];

    it('нэвтрээгүй → 401', async () => {
      for (const p of paths) expect((await get(actors.anonymous(), p)).status, p).toBe(401);
    });

    it('CUSTOMER болон үл мэдэгдэх дүр → 403', async () => {
      const c = await createCustomer(env.t.prisma);
      for (const p of paths) {
        expect((await get(actors.customer(c.id), p)).status, p).toBe(403);
        expect((await get({ 'x-user-id': 'u', 'x-roles': 'GUEST', 'x-org-id': ORG }, p)).status, p).toBe(403);
      }
    });

    it('ADMIN, APPROVER, BRANCH_MANAGER, OFFICER → 200', async () => {
      for (const h of [actors.admin(), actors.approver(), actors.branchManager('bm', 'branch-1'), actors.officer('officer-1')]) {
        for (const p of paths) expect((await get(h, p)).status, `${h['x-roles']} ${p}`).toBe(200);
      }
    });

    it('салбарын захирал салбаргүй (X-Branch-Id байхгүй) → 403 BRANCH_REQUIRED', async () => {
      const res = await get({ 'x-user-id': 'bm', 'x-roles': 'BRANCH_MANAGER', 'x-org-id': ORG }, '/reports/overdue-loans');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('BRANCH_REQUIRED');
    });

    it('үл мэдэгдэх тайлан → 404 REPORT_NOT_FOUND (run ба export); "dashboard" нь тайлангийн түлхүүр биш', async () => {
      for (const p of ['/reports/nope', '/reports/nope/export', '/reports/dashboard']) {
        const res = await get(admin, p);
        expect(res.status, p).toBe(404);
        expect(res.body.code).toBe('REPORT_NOT_FOUND');
      }
      const ok = await get(admin, '/reports/dashboard/summary');
      expect(ok.status).toBe(200);
      expect(ok.body.currency).toBe('MNT');
    });
  });

  describe('GET reports (тодорхойлолт)', () => {
    it('9 тайлан, ReportKey дарааллаар; багана/шүүлт/эрэмбэ; deposit-balances = core-mock', async () => {
      const res = await get(admin, '/reports');
      expect(res.status).toBe(200);
      const defs = (res.body as unknown[]).map((d) => ReportDefinitionView.parse(d));
      expect(defs.map((d) => d.key)).toEqual([...ReportKey]);
      for (const d of defs) {
        expect(d.title.length).toBeGreaterThan(0);
        expect(d.description.length).toBeGreaterThan(0);
        expect(new Set(d.columns.map((c) => c.key)).size).toBe(d.columns.length);
        const sortable = d.columns.filter((c) => c.sortable).map((c) => c.key);
        expect(sortable).toContain(d.defaultSort?.sortBy);
        expect(d.columns.find((c) => c.key === 'registerNo')?.sortable).toBe(false);
        expect(d.filters.map((f) => f.key)).toEqual(expect.arrayContaining(['branchId', 'officerId', 'search']));
      }
      expect(defs.filter((d) => d.dataSource !== 'origination').map((d) => [d.key, d.dataSource])).toEqual([['deposit-balances', 'core-mock']]);
      // бүтээгдэхүүн шүүлт нь каталогоос select болно
      const product = defs[0].filters.find((f) => f.key === 'productId');
      expect(product).toMatchObject({ type: 'select' });
      expect(product?.options?.map((o) => o.label).sort()).toEqual(['Бизнесийн зээл', 'Хэрэглээний зээл']);
      // status баганад options
      expect(defs[1].columns.find((c) => c.key === 'bucket')?.options?.map((o) => o.value)).toEqual(['CURRENT', 'DPD_1_30', 'DPD_31_60', 'DPD_61_90', 'DPD_90_PLUS']);
    });
  });

  describe('оролтын шалгалт (400)', () => {
    it.each([
      [{ pageSize: 7 }, 'VALIDATION_FAILED'],
      [{ page: 0 }, 'VALIDATION_FAILED'],
      [{ asOf: '2026-02-31' }, 'VALIDATION_FAILED'],
      [{ asOf: '28-10-2026' }, 'VALIDATION_FAILED'],
      [{ dateFrom: 'abc' }, 'VALIDATION_FAILED'],
      [{ currency: 'MN' }, 'VALIDATION_FAILED'],
      [{ sortDir: 'sideways' }, 'VALIDATION_FAILED'],
      [{ search: 'x'.repeat(101) }, 'VALIDATION_FAILED'],
      [{ dateFrom: '2026-10-02', dateTo: '2026-10-01' }, 'INVALID_DATE_RANGE'],
      [{ status: 'NOPE' }, 'INVALID_FILTER'],
      [{ sortBy: 'nope' }, 'INVALID_SORT'],
      [{ sortBy: 'registerNo' }, 'INVALID_SORT'], // шифрлэгдсэн, нуугдсан → эрэмбэлэх боломжгүй
      [{ sortBy: 'dueDate; DROP TABLE origination.loan_application;--' }, 'INVALID_SORT'],
      [{ sortBy: '"dueDate" DESC, "_id"' }, 'INVALID_SORT'],
    ])('upcoming-repayments %j → 400 %s', async (query, code) => {
      const res = await get(admin, '/reports/upcoming-repayments', query as Record<string, string | number>);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
    });

    it('тайланд хамааралгүй шүүлтийг үл тооно (closed-loans дээр provider/status/asOf)', async () => {
      const res = await get(admin, '/reports/closed-loans', { provider: 'QPAY', assetType: 'LAND', status: 'ANYTHING' });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
    });

    it('export ч адил шалгана (pageSize үл тооно)', async () => {
      expect((await get(admin, '/reports/upcoming-repayments/export', { sortBy: 'nope' })).status).toBe(400);
      expect((await get(admin, '/reports/upcoming-repayments/export', { pageSize: 7 })).status).toBe(200);
    });
  });

  describe('SQL injection', () => {
    it('search / branchId / officerId / productId нь параметр — өгөгдөл алдагдахгүй, хүснэгт устахгүй', async () => {
      const evil = ["' OR '1'='1", "x'; DROP TABLE origination.loan_application; --", "\\", "O'Brien", '%', '_', '%%', '"; SELECT 1; --'];
      for (const v of evil) {
        for (const key of ['search', 'branchId', 'officerId', 'productId']) {
          const res = await get(admin, '/reports/outstanding-balance', { [key]: v });
          expect(res.status, `${key}=${v}`).toBe(200);
          expect(res.body.total, `${key}=${v}`).toBe(0);
        }
      }
      expect(await env.t.prisma.loanApplication.count()).toBeGreaterThan(10);
    });

    it('LIKE тусгай тэмдэгт (% _) нь wildcard биш; хэсэгчилсэн нэр/гэрээний дугаар таарна', async () => {
      expect((await getReport(env, admin, 'outstanding-balance', { search: '%' })).total).toBe(0);
      expect((await getReport(env, admin, 'outstanding-balance', { search: 'B10026L_' })).total).toBe(0);
      expect((await getReport(env, admin, 'outstanding-balance', { search: 'B10026L' })).total).toBe(6);
      expect(col(await getReport(env, admin, 'outstanding-balance', { search: 'Болд' }), 'contractNo')).toEqual(['B10026LA']);
      expect(col(await getReport(env, admin, 'outstanding-balance', { search: 'Бат Болд' }), 'contractNo')).toEqual(['B10026LA']);
      expect(col(await getReport(env, admin, 'outstanding-balance', { search: 'Болд Бат' }), 'contractNo')).toEqual(['B10026LA']);
      expect(col(await getReport(env, admin, 'outstanding-balance', { search: 'APP-LC' }), 'contractNo')).toEqual(['B10026LC']);
    });

    it('регистрээр яг таарсанд л олно (том/жижиг үсэг үл ялгана); хэсэгчилсэн регистр олохгүй', async () => {
      expect(col(await getReport(env, admin, 'outstanding-balance', { search: 'УБ90000003' }), 'contractNo')).toEqual(['B10026LC']);
      expect(col(await getReport(env, admin, 'outstanding-balance', { search: ' уб90000003 ' }), 'contractNo')).toEqual(['B10026LC']);
      expect((await getReport(env, admin, 'outstanding-balance', { search: 'УБ9000000' })).total).toBe(0);
    });
  });

  describe('хүрээ (NFR-3)', () => {
    it('ЗЭЗ: зөвхөн өөрийн хариуцсан — өөр ЗЭЗ-ийн officerId шүүлтийг үл тооно', async () => {
      const o1 = actors.officer('officer-1');
      expect(col(await getReport(env, o1, 'outstanding-balance'), 'officerId')).toEqual(Array(4).fill('officer-1')); // LA, LB, LD, LE
      const sneaky = await getReport(env, o1, 'outstanding-balance', { officerId: 'officer-2' });
      expect(sneaky.total).toBe(4);
      expect(new Set(col(sneaky, 'officerId'))).toEqual(new Set(['officer-1']));
      expect(col(await getReport(env, actors.officer('officer-2'), 'outstanding-balance'), 'contractNo').sort()).toEqual(['B10026LC', 'B10026LN']);
      expect((await getReport(env, actors.officer('officer-9'), 'outstanding-balance')).total).toBe(0);
    });

    it('ЗЭЗ: branchId-ээр нарийсгаж болно (хүрээгээс гарахгүй)', async () => {
      expect((await getReport(env, actors.officer('officer-1'), 'outstanding-balance', { branchId: 'branch-1' })).total).toBe(4);
      expect((await getReport(env, actors.officer('officer-1'), 'outstanding-balance', { branchId: 'branch-2' })).total).toBe(0);
    });

    it('салбарын захирал: зөвхөн өөрийн салбар — өөр салбарын branchId шүүлтийг үл тооно; officerId-ээр нарийсгана', async () => {
      const bm1 = actors.branchManager('bm-1', 'branch-1');
      expect(col(await getReport(env, bm1, 'outstanding-balance'), 'contractNo').sort()).toEqual(['B10026LA', 'B10026LB', 'B10026LD', 'B10026LE']);
      const sneaky = await getReport(env, bm1, 'outstanding-balance', { branchId: 'branch-2' });
      expect(new Set(col(sneaky, 'branchId'))).toEqual(new Set(['branch-1']));
      expect(col(await getReport(env, actors.branchManager('bm-2', 'branch-2'), 'outstanding-balance'), 'contractNo').sort()).toEqual(['B10026LC', 'B10026LN']);
      expect(col(await getReport(env, bm1, 'outstanding-balance', { officerId: 'officer-9' }), 'contractNo')).toEqual([]);
    });

    it('ADMIN/APPROVER: бүгд; branchId/officerId-ээр нарийсгана', async () => {
      expect((await getReport(env, actors.approver(), 'outstanding-balance')).total).toBe(6);
      expect(col(await getReport(env, admin, 'outstanding-balance', { branchId: 'branch-2' }), 'contractNo').sort()).toEqual(['B10026LC', 'B10026LN']);
      expect(col(await getReport(env, admin, 'outstanding-balance', { branchId: 'branch-1', officerId: 'officer-1' }), 'contractNo').sort()).toEqual(['B10026LA', 'B10026LB', 'B10026LD', 'B10026LE']);
    });

    it('олон дүр: ADMIN+OFFICER → бүгд; BRANCH_MANAGER+OFFICER → салбар', async () => {
      expect((await getReport(env, { ...actors.officer('officer-1'), 'x-roles': 'OFFICER,ADMIN' }, 'outstanding-balance')).total).toBe(6);
      const both = await getReport(env, { ...actors.branchManager('bm-1', 'branch-1'), 'x-roles': 'OFFICER,BRANCH_MANAGER' }, 'outstanding-balance');
      expect(both.total).toBe(4);
    });

    it.each([...SQL_REPORTS])('%s: бүх тайланд ЗЭЗ/салбарын хүрээ мөрөнд хэрэгжинэ', async (key) => {
      const all = await getReport(env, admin, key, WIDE);
      const o1 = await getReport(env, actors.officer('officer-1'), key, WIDE);
      const bm2 = await getReport(env, actors.branchManager('bm-2', 'branch-2'), key, WIDE);
      expect(all.total).toBeGreaterThan(0);
      expect(o1.total).toBeLessThan(all.total + 1);
      for (const row of o1.rows) expect(row.officerId).toBe('officer-1');
      for (const row of bm2.rows) expect(row.branchId).toBe('branch-2');
      // хүрээ хоорондын хуваарилалт: officer-1 ∪ officer-2 = бүгд (бүх өгөгдөл officer-1/2-ийнх)
      const o2 = await getReport(env, actors.officer('officer-2'), key, WIDE);
      expect(o1.total + o2.total).toBe(all.total);
    });

    it('deposit-balances: хүрээ зөвхөн хүрээний зээлдэгчид', async () => {
      const all = await getReport(env, admin, 'deposit-balances', { pageSize: 100 });
      const o2 = await getReport(env, actors.officer('officer-2'), 'deposit-balances', { pageSize: 100 });
      const o1 = await getReport(env, actors.officer('officer-1'), 'deposit-balances', { pageSize: 100 });
      expect(o1.total + o2.total).toBe(all.total);
      expect(new Set(col(o2, 'customerName'))).toEqual(new Set(['Чимэд Тэмүүлэн', 'Номин Дулам']));
    });

    it('өөр байгууллагын өгөгдөл хэзээ ч харагдахгүй (org тусгаарлалт)', async () => {
      await seedOtherOrgLoan(env.t.prisma);
      for (const key of SQL_REPORTS) {
        const r = await getReport(env, admin, key, WIDE);
        expect(JSON.stringify(r.rows)).not.toContain('X-OTHER');
        expect(JSON.stringify(r.rows)).not.toContain('APP-OTHER');
      }
      const other = await getReport(env, { ...admin, 'x-org-id': OTHER_ORG }, 'outstanding-balance');
      expect(col(other, 'contractNo')).toEqual(['X-OTHER']);
      const overdue = await getReport(env, { ...admin, 'x-org-id': OTHER_ORG }, 'overdue-loans');
      expect(overdue.rows).toHaveLength(1);
      expect((await get({ ...admin, 'x-org-id': OTHER_ORG }, '/reports/dashboard/summary')).body.portfolio.activeLoanCount).toBe(1);
    });
  });

  describe('шүүлтүүд', () => {
    it('бүтээгдэхүүн, валют (жижиг үсгээр ч)', async () => {
      const biz = await getReport(env, admin, 'outstanding-balance', { productId: w.products.business.id });
      expect(col(biz, 'contractNo').sort()).toEqual(['B10026LC', 'B10026LE', 'B10026LN']);
      expect(col(await getReport(env, admin, 'outstanding-balance', { currency: 'usd' }), 'contractNo')).toEqual(['B10026LD']);
      expect((await getReport(env, admin, 'outstanding-balance', { productId: 'no-such-product' })).total).toBe(0);
    });

    it('хоосон string шүүлтийг үл тооно', async () => {
      expect((await get(admin, '/reports/outstanding-balance', { search: '   ', branchId: '', productId: '' })).body.total).toBe(6);
    });
  });

  describe('хуудаслалт ба эрэмбэ', () => {
    it('25 нэмэлт зээл: хуудас бүр давхцалгүй, нийт тоо ба нийлбэр хуудаснаас үл хамаарна, 10/20/50/100', async () => {
      await resetReport(env);
      await seedBulkLoans(env.t.prisma, 25);
      const p1 = await getReport(env, admin, 'outstanding-balance', { pageSize: 10, page: 1, sortBy: 'currency' }); // бүгд ижил → _id-ээр тогтвортой
      const p2 = await getReport(env, admin, 'outstanding-balance', { pageSize: 10, page: 2, sortBy: 'currency' });
      const p3 = await getReport(env, admin, 'outstanding-balance', { pageSize: 10, page: 3, sortBy: 'currency' });
      const p4 = await getReport(env, admin, 'outstanding-balance', { pageSize: 10, page: 4, sortBy: 'currency' });
      expect([p1.rows.length, p2.rows.length, p3.rows.length, p4.rows.length]).toEqual([10, 10, 5, 0]);
      for (const p of [p1, p2, p3, p4]) { expect(p.total).toBe(25); expect(p.pageSize).toBe(10); expect(p.totals).toEqual(p1.totals); }
      const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.appNo);
      expect(new Set(seen).size).toBe(25);
      expect(p4.page).toBe(4);
      for (const size of [10, 20, 50, 100]) {
        const r = await getReport(env, admin, 'outstanding-balance', { pageSize: size });
        expect(r.rows).toHaveLength(Math.min(size, 25));
        expect(r.total).toBe(25);
      }
    });

    it('эрэмбэ: чиглэл, NULL үргэлж төгсгөлд, эрэмбийн хариу echo', async () => {
      const asc = await getReport(env, admin, 'outstanding-balance', { sortBy: 'nextDueAmount', sortDir: 'asc' });
      const desc = await getReport(env, admin, 'outstanding-balance', { sortBy: 'nextDueAmount', sortDir: 'desc' });
      expect(asc.sortBy).toBe('nextDueAmount'); expect(asc.sortDir).toBe('asc');
      expect(col(asc, 'nextDueAmount')).toEqual([1100, 100000, 220000, 110000, 255000, null].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b)));
      expect(col(desc, 'nextDueAmount')).toEqual([255000, 220000, 110000, 100000, 1100, null]);
      const def = await getReport(env, admin, 'outstanding-balance');
      expect(def.sortBy).toBe('outstandingPrincipal'); expect(def.sortDir).toBe('desc');
    });

    it('текст эрэмбэ + sortDir default asc', async () => {
      const r = await getReport(env, admin, 'outstanding-balance', { sortBy: 'contractNo' });
      expect(col(r, 'contractNo')).toEqual(['B10026LA', 'B10026LB', 'B10026LC', 'B10026LD', 'B10026LE', 'B10026LN']);
    });
  });

  describe('идемпотент / зэрэгцээ', () => {
    it('ижил хүсэлтийг давхар болон зэрэг илгээхэд ижил хариу, өгөгдөл өөрчлөгдөхгүй', async () => {
      const before = await env.t.prisma.loanApplication.count();
      const first = await get(admin, '/reports/overdue-loans', { currency: 'MNT' });
      const second = await get(admin, '/reports/overdue-loans', { currency: 'MNT' });
      const strip = (b: Record<string, unknown>) => ({ ...b, generatedAt: 0 });
      expect(strip(second.body)).toEqual(strip(first.body));
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => get(i % 2 ? actors.admin() : actors.approver(), '/reports/overdue-loans', { currency: 'MNT' })));
      for (const r of results) { expect(r.status).toBe(200); expect(strip(r.body)).toEqual(strip(first.body)); }
      const dash = await Promise.all(Array.from({ length: 6 }, () => get(admin, '/reports/dashboard/summary')));
      for (const d of dash) expect({ ...d.body, generatedAt: 0 }).toEqual({ ...dash[0].body, generatedAt: 0 });
      expect(await env.t.prisma.loanApplication.count()).toBe(before);
      expect(await env.t.prisma.reportRun.count()).toBe(0); // JSON харах нь аудитад бичигдэхгүй (зөвхөн экспорт)
    });
  });

  describe('ЭТХ, asOf', () => {
    it('одоогийн ЭТХ = stale БИШ хамгийн сүүлийн generatedAt', async () => {
      const customer = await createCustomer(env.t.prisma, { lastName: 'Олон', firstName: 'Хуваарь', registerNo: 'УБ90000099' });
      const app = await createApplication(env.t.prisma, { appNo: 'APP-MULTI', contractNo: 'B10026MS', status: 'ACTIVE', amount: 100000, updatedAt: new Date('2026-10-20T04:00:00Z') });
      await createBorrower(env.t.prisma, app.id, customer.id, 'PRIMARY');
      await createExactSchedule(env.t.prisma, app.id, rowsOf(['2026-09-01'], 100000, 1000), { generatedAt: new Date('2026-01-01T00:00:00Z') }); // хуучин
      await createExactSchedule(env.t.prisma, app.id, rowsOf(['2026-09-05'], 200000, 2000), { generatedAt: new Date('2026-02-01T00:00:00Z') }); // одоогийн
      await createExactSchedule(env.t.prisma, app.id, rowsOf(['2026-09-09'], 999999, 9999), { generatedAt: new Date('2026-03-01T00:00:00Z'), stale: true }); // stale — үл тооно
      const r = await getReport(env, admin, 'overdue-loans', { search: 'B10026MS' });
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ oldestDueDate: '2026-09-05', dpd: 53, overduePrincipal: 200000, overdueInterest: 2000, outstandingPrincipal: 200000 });
    });

    it('түүхэн asOf: asOf-ийн дараах төлбөрийг тооцохгүй', async () => {
      // LA мөр3 (10-10, 110k)-д 10-29 өдөр төлбөр орсон гэж үзье
      const rows = (await env.t.prisma.repaymentScheduleRow.findMany({ where: { schedule: { applicationId: w.LA.app.id } }, orderBy: { seq: 'asc' } }));
      await createPayment(env.t.prisma, w.LA.app.id, { id: 'LA-3', paidAt: '2026-10-29T04:00:00Z', amount: 110000, allocations: [{ rowId: rows[2].id, interest: 10000, principal: 100000 }] });
      const onAsOf = await getReport(env, admin, 'overdue-loans', { search: 'B10026LA' });
      expect(onAsOf.rows[0]).toMatchObject({ overdueInstallments: 2, overdueTotal: 170000 }); // 10-28 дээр мөр3 төлөгдөөгүй
      const next = await getReport(env, admin, 'overdue-loans', { search: 'B10026LA', asOf: '2026-10-29' });
      expect(next.rows[0]).toMatchObject({ overdueInstallments: 1, overduePrincipal: 60000, overdueInterest: 0, overdueTotal: 60000, outstandingPrincipal: 360000, dpd: 49 });
      const bal = await getReport(env, admin, 'outstanding-balance', { search: 'B10026LA', asOf: '2026-10-29' });
      expect(bal.rows[0]).toMatchObject({ paidPrincipal: 240000, outstandingPrincipal: 360000, outstandingInterest: 0 });
      const bal28 = await getReport(env, admin, 'outstanding-balance', { search: 'B10026LA' });
      expect(bal28.rows[0]).toMatchObject({ paidPrincipal: 140000, outstandingPrincipal: 460000 });
    });

    it('asOf өөрчлөхөд хугацаа хэтрэлт, DPD шилжинэ (түүхэн)', async () => {
      // 08-15: LA-ийн мөр1 (08-10) 08-12-нд төлөгдсөн → зөвхөн LC (07-01 → 45 хоног)
      const early = await getReport(env, admin, 'overdue-loans', { asOf: '2026-08-15', currency: 'MNT' });
      expect(col(early, 'contractNo')).toEqual(['B10026LC']);
      expect(col(early, 'dpd')).toEqual([45]);
      expect(early.asOf).toBe('2026-08-15');
      // 09-20: LC 81 хоног; LA мөр2 (09-10) 09-12-нд 50k л төлөгдсөн → 10 хоног, үлдэгдэл 60k
      const mid = await getReport(env, admin, 'overdue-loans', { asOf: '2026-09-20', currency: 'MNT' });
      expect(col(mid, 'contractNo')).toEqual(['B10026LC', 'B10026LA']);
      expect(col(mid, 'dpd')).toEqual([81, 10]);
      expect(col(mid, 'overduePrincipal')[1]).toBe(60000);
      expect((await getReport(env, admin, 'overdue-loans', { asOf: '2026-06-30' })).total).toBe(0);
    });
  });

  describe('Core интеграци (deposit-balances)', () => {
    it('үндсэн ба ХАМТРАН зээлдэгч орно, БАТЛАН ДААГЧ орохгүй; олон зээлтэй харилцагч нэг л удаа', async () => {
      const co = await createCustomer(env.t.prisma, { lastName: 'Хамтран', firstName: 'Зээлдэгч', registerNo: 'УБ90000071' });
      const gu = await createCustomer(env.t.prisma, { lastName: 'Батлан', firstName: 'Даагч', registerNo: 'УБ90000072' });
      await createBorrower(env.t.prisma, w.LA.app.id, co.id, 'CO_BORROWER');
      await createBorrower(env.t.prisma, w.LA.app.id, gu.id, 'GUARANTOR');
      await createBorrower(env.t.prisma, w.LB.app.id, co.id, 'CO_BORROWER'); // нэг хамтран зээлдэгч 2 зээлд
      const r = await getReport(env, admin, 'deposit-balances', { pageSize: 100 });
      const names = col(r, 'customerName') as string[];
      expect(names).toContain('Хамтран Зээлдэгч');
      expect(names).not.toContain('Батлан Даагч');
      const coRows = r.rows.filter((x) => x.customerName === 'Хамтран Зээлдэгч');
      expect(coRows.length).toBeGreaterThanOrEqual(1);
      expect(new Set(coRows.map((x) => x.accountNo)).size).toBe(coRows.length); // данс давхардахгүй
      expect(coRows[0]).toMatchObject({ loanCount: 2, contractNos: 'B10026LA, B10026LB' });
      // ЗЭЗ-ийн хүрээ: officer-2 нь LA/LB-ийн хамтран зээлдэгчийг харахгүй
      const o2 = await getReport(env, actors.officer('officer-2'), 'deposit-balances', { pageSize: 100 });
      expect(col(o2, 'customerName')).not.toContain('Хамтран Зээлдэгч');
    });

    it('шүүлт: данс валют (usd), зээлийн төлөв, эрэмбэ, хуудаслалт, нийлбэр (нэг валют)', async () => {
      const all = await getReport(env, admin, 'deposit-balances', { pageSize: 100 });
      expect(all.mixedCurrency).toBe(true);
      expect(all.totals).toBeUndefined();
      const mnt = await getReport(env, admin, 'deposit-balances', { pageSize: 100, currency: 'mnt' });
      expect(new Set(col(mnt, 'currency'))).toEqual(new Set(['MNT']));
      expect(mnt.totals?.balance).toBeCloseTo((mnt.rows as Array<{ balance: number }>).reduce((a, x) => a + x.balance, 0), 2);
      const balances = col(mnt, 'balance') as number[];
      expect([...balances].sort((a, b) => b - a)).toEqual(balances); // анхдагч: balance буурах
      const asc = await getReport(env, admin, 'deposit-balances', { pageSize: 100, currency: 'MNT', sortBy: 'balance', sortDir: 'asc' });
      expect(col(asc, 'balance')).toEqual([...balances].reverse());
      const p2 = await getReport(env, admin, 'deposit-balances', { pageSize: 10, page: 2, currency: 'MNT' });
      expect(p2.rows).toHaveLength(Math.max(0, Math.min(10, mnt.total - 10)));
      expect(p2.total).toBe(mnt.total);
      const migrated = await getReport(env, admin, 'deposit-balances', { pageSize: 100, status: 'MIGRATED' });
      expect(new Set(col(migrated, 'customerName'))).toEqual(new Set(['Нямаа Анар']));
      // яг ижил хүсэлт → ижил үр дүн (mock deterministic)
      expect(col(await getReport(env, admin, 'deposit-balances', { pageSize: 100 }), 'accountNo')).toEqual(col(all, 'accountNo'));
    });

    it('real горим + тохиргоогүй → 503 INTEGRATION_NOT_CONFIGURED; тохиргоотой ч → 501 INTEGRATION_NOT_IMPLEMENTED; GET reports → dataSource=core', async () => {
      for (const [env2, status, code] of [[{}, 503, 'INTEGRATION_NOT_CONFIGURED'], [{ CORE_DEPOSIT_API_URL: 'https://core.invalid', CORE_DEPOSIT_API_KEY: 'k' }, 501, 'INTEGRATION_NOT_IMPLEMENTED']] as const) {
        const t = await createTestApp([ReportModule], (b) => b.overrideProvider(CORE_DEPOSIT_PORT).useValue(new RealCoreDepositPort(env2)));
        try {
          const http = () => request(t.app.getHttpServer());
          const res = await http().get('/api/reports/deposit-balances').set(admin);
          expect(res.status).toBe(status);
          expect(res.body.code).toBe(code);
          expect((await http().get('/api/reports/deposit-balances/export').set(admin)).status).toBe(status);
          expect(JSON.stringify(res.body)).not.toContain('k"');
          const defs = (await http().get('/api/reports').set(admin)).body as Array<{ key: string; dataSource: string }>;
          expect(defs.find((d) => d.key === 'deposit-balances')?.dataSource).toBe('core');
          expect((await http().get('/api/reports/overdue-loans').set(admin)).status).toBe(200); // бусад тайлан хэвийн
          expect(await t.prisma.reportRun.count()).toBe(0); // амжилтгүй экспорт аудитад орохгүй
        } finally { await t.close(); }
      }
    });
  });
});
