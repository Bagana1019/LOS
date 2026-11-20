import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { DomainError } from '@los/nest-common';
import { IncomeOverviewResponse, StepKey } from '@los/contracts';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { IncomeModule } from './income.module';
import { FakeNdshPort, monthlySalaries } from './testing/fake-ndsh.port';
import { KYC_NDSH_PORT } from './ports/kyc-ndsh.port';

// Модуль 4 AC: 12 сарын цалин → сарын дундаж зөв; орлого байхгүй бол алхам PENDING, шалтгаан заагдана (FR-8.6).
describe.skipIf(!hasTestDb)('income API (DB)', () => {
  let t: TestApp;
  let baseUrl: string;
  const ndsh = new FakeNdshPort();
  const officer = actors.officer('officer-1');
  beforeAll(async () => {
    t = await createTestApp([IncomeModule], (b) => b.overrideProvider(KYC_NDSH_PORT).useValue(ndsh), '2026-11-03T02:00:00Z');
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await resetDb(t.prisma);
    ndsh.rows = monthlySalaries(12, 1_500_000); ndsh.error = null; ndsh.registers = [];
    t.clock.set('2026-11-03T02:00:00Z');
  });

  const http = () => request(baseUrl);
  const url = (id: string, path = '') => `/api/applications/${id}/income${path}`;
  async function setup(opts: { co?: boolean; coIncluded?: boolean; status?: string } = {}) {
    const primary = await createCustomer(t.prisma);
    const app = await createApplication(t.prisma, { status: opts.status ?? 'DRAFT' });
    await t.prisma.loanApplicationStep.createMany({ data: StepKey.map((k) => ({ orgId: ORG, applicationId: app.id, stepKey: k, status: 'PENDING' })) });
    await createBorrower(t.prisma, app.id, primary.id, 'PRIMARY');
    let co = null;
    if (opts.co) { co = await createCustomer(t.prisma); await createBorrower(t.prisma, app.id, co.id, 'CO_BORROWER', { incomeIncluded: opts.coIncluded ?? true }); }
    return { app, primary, co };
  }
  const step = (applicationId: string, key = 'income') => t.prisma.loanApplicationStep.findFirstOrThrow({ where: { applicationId, stepKey: key } });
  const parse = (res: request.Response) => { expect(res.status, JSON.stringify(res.body)).toBeLessThan(300); return IncomeOverviewResponse.parse(res.body); };
  const fetchNdsh = (id: string, customerId: string) => http().post(url(id, '/ndsh/fetch')).set(officer).send({ customerId });
  const calculate = (id: string, customerId: string, periodFrom = '2025-11', periodTo = '2026-10') => http().post(url(id, '/calculate')).set(officer).send({ customerId, periodFrom, periodTo });

  it('AC: NDSH salary rows → pick a period → Calculate → exact monthly average; the step becomes COMPLETED', async () => {
    const { app, primary } = await setup();
    const empty = parse(await http().get(url(app.id)).set(officer));
    expect(empty.blockers).toEqual([expect.objectContaining({ code: 'INCOME_MISSING', customerId: primary.id })]);
    expect(empty.step).toEqual({ status: 'PENDING', reason: null });
    expect(empty.borrowers[0]!.business.available).toBe(false);

    const fetched = parse(await fetchNdsh(app.id, primary.id));
    expect(fetched.borrowers[0]!.salaries).toHaveLength(12);
    expect(fetched.borrowers[0]!.salaries.every((s) => s.source === 'NDSH')).toBe(true);
    expect(fetched.borrowers[0]!.summary.avgSalaryMonthly).toBeNull(); // «Тооцоолох» дарахаас өмнө
    expect(fetched.step).toEqual({ status: 'PENDING', reason: 'INCOME_MISSING' });
    expect(ndsh.registers[0]).toMatch(/^УБ\d{8}$/);

    const calc = parse(await calculate(app.id, primary.id));
    expect(calc.borrowers[0]!.summary).toMatchObject({ periodFrom: '2025-11', periodTo: '2026-10', months: 12, salaryTotal: 18_000_000, avgSalaryMonthly: 1_500_000 });
    expect(calc.blockers).toEqual([]);
    expect(calc.step).toEqual({ status: 'COMPLETED', reason: null });
    const stored = await t.prisma.incomeSummary.findFirstOrThrow({ where: { applicationId: app.id } });
    expect(stored.avgSalaryMonthly?.toNumber()).toBe(1_500_000);
    expect(stored.periodFrom?.toISOString().slice(0, 10)).toBe('2025-11-01');
    expect(stored.periodTo?.toISOString().slice(0, 10)).toBe('2026-10-31');
    expect((await step(app.id)).status).toBe('COMPLETED');
  });

  it('the average is over months that have salary; a longer period does not lower it', async () => {
    const { app, primary } = await setup();
    ndsh.rows = monthlySalaries(6, 1_200_000);
    await fetchNdsh(app.id, primary.id);
    expect(parse(await calculate(app.id, primary.id, '2026-05', '2026-10')).borrowers[0]!.summary.avgSalaryMonthly).toBe(1_200_000);
    expect(parse(await calculate(app.id, primary.id, '2025-11', '2026-10')).borrowers[0]!.summary.avgSalaryMonthly).toBe(1_200_000);
  });

  it('re-fetching NDSH replaces only NDSH rows (manual rows stay) and refreshes the stored average for the same period', async () => {
    const { app, primary } = await setup();
    await fetchNdsh(app.id, primary.id);
    await calculate(app.id, primary.id);
    const added = parse(await http().post(url(app.id, '/salaries')).set(officer).send({ customerId: primary.id, employer: 'Хоёр дахь ажил', year: 2026, month: 10, salary: 500_000 }));
    expect(added.borrowers[0]!.summary.avgSalaryMonthly).toBe(1_541_666.67); // (18,000,000 + 500,000) / 12
    ndsh.rows = monthlySalaries(12, 2_000_000);
    const refetched = parse(await fetchNdsh(app.id, primary.id));
    expect(refetched.borrowers[0]!.salaries.filter((s) => s.source === 'NDSH')).toHaveLength(12);
    expect(refetched.borrowers[0]!.salaries.filter((s) => s.source === 'MANUAL')).toHaveLength(1);
    expect(refetched.borrowers[0]!.summary.avgSalaryMonthly).toBe(2_041_666.67);
  });

  it('manual salary rows can be deleted; NDSH rows cannot; unknown id 404', async () => {
    const { app, primary } = await setup();
    const o = parse(await fetchNdsh(app.id, primary.id));
    const ndshRow = o.borrowers[0]!.salaries[0]!;
    const refuse = await http().delete(url(app.id, `/salaries/${ndshRow.id}`)).set(officer);
    expect(refuse.status).toBe(422);
    expect(refuse.body.code).toBe('SALARY_NOT_EDITABLE');
    // 2025-09 нь НДШ-ийн хүрээнээс (2025-11…2026-10) гадуур: НДШ-д байгаа сард ажил олгогчгүй гар мөр нэмэхийг F2-14 хориглоно.
    const add = parse(await http().post(url(app.id, '/salaries')).set(officer).send({ customerId: primary.id, year: 2025, month: 9, salary: 100_000 }));
    const manualRow = add.borrowers[0]!.salaries.find((s) => s.source === 'MANUAL')!;
    expect(parse(await http().delete(url(app.id, `/salaries/${manualRow.id}`)).set(officer)).borrowers[0]!.salaries.some((s) => s.source === 'MANUAL')).toBe(false);
    expect((await http().delete(url(app.id, '/salaries/nope')).set(officer)).body.code).toBe('SALARY_NOT_FOUND');
  });

  it('manual income (rent / pension / other) counts as income by itself; delete removes it again', async () => {
    const { app, primary } = await setup();
    const added = parse(await http().post(url(app.id, '/manual')).set(officer).send({ customerId: primary.id, type: 'RENT', monthlyAmount: 800_000, note: 'Орон сууцны түрээс' }));
    expect(added.borrowers[0]).toMatchObject({ manualMonthlyTotal: 800_000, hasIncome: true });
    expect(added.step.status).toBe('COMPLETED');
    const id = added.borrowers[0]!.manual[0]!.id;
    const removed = parse(await http().delete(url(app.id, `/manual/${id}`)).set(officer));
    expect(removed.borrowers[0]!.hasIncome).toBe(false);
    expect(removed.step).toEqual({ status: 'PENDING', reason: 'INCOME_MISSING' });
    expect((await http().delete(url(app.id, '/manual/nope')).set(officer)).body.code).toBe('MANUAL_INCOME_NOT_FOUND');
  });

  it('household / business expenses are stored without completing the step; each can be updated alone', async () => {
    const { app, primary } = await setup();
    const a = parse(await http().put(url(app.id, `/expenses/${primary.id}`)).set(officer).send({ householdExpenseMonthly: 700_000 }));
    expect(a.borrowers[0]!.summary).toMatchObject({ householdExpenseMonthly: 700_000, businessExpenseMonthly: null });
    expect(a.step.status).toBe('PENDING');
    const b = parse(await http().put(url(app.id, `/expenses/${primary.id}`)).set(officer).send({ businessExpenseMonthly: 300_000 }));
    expect(b.borrowers[0]!.summary).toMatchObject({ householdExpenseMonthly: 700_000, businessExpenseMonthly: 300_000 });
    expect((await http().put(url(app.id, `/expenses/${primary.id}`)).set(officer).send({})).status).toBe(400);
    expect((await http().put(url(app.id, `/expenses/${primary.id}`)).set(officer).send({ householdExpenseMonthly: -1 })).status).toBe(400);
  });

  it('a co-borrower whose income is included must also have income; an excluded one does not', async () => {
    const { app, primary, co } = await setup({ co: true });
    await fetchNdsh(app.id, primary.id);
    const o = parse(await calculate(app.id, primary.id));
    expect(o.step).toEqual({ status: 'PENDING', reason: 'INCOME_MISSING' });
    expect(o.blockers).toEqual([expect.objectContaining({ customerId: co!.id })]);
    expect(o.borrowers.map((b) => [b.role, b.included])).toEqual([['PRIMARY', true], ['CO_BORROWER', true]]);
    await http().post(url(app.id, '/manual')).set(officer).send({ customerId: co!.id, type: 'PENSION', monthlyAmount: 500_000 });
    expect((await step(app.id)).status).toBe('COMPLETED');

    const second = await setup({ co: true, coIncluded: false });
    await fetchNdsh(second.app.id, second.primary.id);
    const done = parse(await calculate(second.app.id, second.primary.id));
    expect(done.step.status).toBe('COMPLETED');
    expect(done.borrowers[1]).toMatchObject({ included: false, hasIncome: false });
  });

  it('income changes mark a COMPLETED score step STALE (INCOME_CHANGED); refresh itself does not', async () => {
    const { app, primary } = await setup();
    await fetchNdsh(app.id, primary.id);
    await calculate(app.id, primary.id);
    await t.prisma.loanApplicationStep.updateMany({ where: { applicationId: app.id, stepKey: 'score' }, data: { status: 'COMPLETED' } });
    await http().post(url(app.id, '/refresh')).set(officer);
    expect((await step(app.id, 'score')).status).toBe('COMPLETED');
    await http().put(url(app.id, `/expenses/${primary.id}`)).set(officer).send({ householdExpenseMonthly: 1 });
    expect(await step(app.id, 'score')).toMatchObject({ status: 'STALE', staleReason: 'INCOME_CHANGED' });
  });

  it('refresh re-evaluates a step that other modules marked STALE (BORROWERS_CHANGED)', async () => {
    const { app, primary } = await setup();
    await fetchNdsh(app.id, primary.id);
    await calculate(app.id, primary.id);
    await t.prisma.loanApplicationStep.updateMany({ where: { applicationId: app.id, stepKey: 'income' }, data: { status: 'STALE', staleReason: 'BORROWERS_CHANGED' } });
    const o = parse(await http().post(url(app.id, '/refresh')).set(officer));
    expect(o.step).toEqual({ status: 'COMPLETED', reason: null });
  });

  it('removing all income puts a COMPLETED step back to PENDING with the reason (used by FR-8.6)', async () => {
    const { app, primary } = await setup();
    const m = parse(await http().post(url(app.id, '/manual')).set(officer).send({ customerId: primary.id, type: 'OTHER', monthlyAmount: 1 }));
    expect((await step(app.id)).status).toBe('COMPLETED');
    await http().delete(url(app.id, `/manual/${m.borrowers[0]!.manual[0]!.id}`)).set(officer);
    expect(await step(app.id)).toMatchObject({ status: 'PENDING', staleReason: 'INCOME_MISSING', completedAt: null });
  });

  it('period validation: reversed, > 60 months, future end month, bad format → 422/400; nothing is saved', async () => {
    const { app, primary } = await setup();
    await fetchNdsh(app.id, primary.id);
    const rev = await calculate(app.id, primary.id, '2026-10', '2026-01');
    expect([rev.status, rev.body.code]).toEqual([422, 'INVALID_PERIOD']);
    const long = await calculate(app.id, primary.id, '2020-01', '2026-10');
    expect([long.status, long.body.code]).toEqual([422, 'INVALID_PERIOD']);
    const future = await calculate(app.id, primary.id, '2026-01', '2026-12');
    expect([future.status, future.body.code]).toEqual([422, 'INVALID_PERIOD']);
    expect((await calculate(app.id, primary.id, '2026-13', '2026-12')).status).toBe(400);
    expect(await t.prisma.incomeSummary.count()).toBe(0);
    const futureSalary = await http().post(url(app.id, '/salaries')).set(officer).send({ customerId: primary.id, year: 2026, month: 12, salary: 1 });
    expect(futureSalary.body.code).toBe('INVALID_PERIOD');
  });

  it('NDSH errors are passed through: unavailable → 503 with a hint to enter salary by hand; nothing changes', async () => {
    const { app, primary } = await setup();
    ndsh.error = new DomainError('NDSH_UNAVAILABLE', 'НДШ түр ажиллахгүй байна', 503);
    const res = await fetchNdsh(app.id, primary.id);
    expect([res.status, res.body.code]).toEqual([503, 'NDSH_UNAVAILABLE']);
    expect(await t.prisma.incomeSalary.count()).toBe(0);
  });

  it('only the primary / co-borrowers can have income; guarantors and unknown customers get 404', async () => {
    const { app } = await setup();
    const g = await createCustomer(t.prisma);
    await createBorrower(t.prisma, app.id, g.id, 'GUARANTOR');
    expect((await fetchNdsh(app.id, g.id)).body.code).toBe('INCOME_BORROWER_NOT_FOUND');
    expect((await http().post(url(app.id, '/manual')).set(officer).send({ customerId: g.id, type: 'RENT', monthlyAmount: 1 })).body.code).toBe('INCOME_BORROWER_NOT_FOUND');
  });

  it('only DRAFT/RETURNED applications change; reading works anywhere; access follows the application scope', async () => {
    const { app, primary } = await setup({ status: 'PENDING_APPROVAL' });
    expect((await fetchNdsh(app.id, primary.id)).body.code).toBe('APPLICATION_NOT_EDITABLE');
    expect((await http().get(url(app.id)).set(officer)).status).toBe(200);
    const open = await setup();
    expect((await http().post(url(open.app.id, '/ndsh/fetch')).set(actors.officer('officer-2')).send({ customerId: open.primary.id })).status).toBe(403);
    expect((await http().get(url(open.app.id)).set(actors.approver())).status).toBe(200);
    expect((await http().post(url(open.app.id, '/ndsh/fetch')).set(actors.approver()).send({ customerId: open.primary.id })).status).toBe(403);
    expect((await http().get(url(open.app.id))).status).toBe(401);
  });

  it('audit log records each change by id and amount, never the register', async () => {
    const { app, primary } = await setup();
    await fetchNdsh(app.id, primary.id);
    await calculate(app.id, primary.id);
    const audit = await t.prisma.auditLog.findMany({ where: { applicationId: app.id }, orderBy: { at: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['INCOME_NDSH_FETCHED', 'INCOME_CALCULATED']);
    expect(JSON.stringify(audit)).not.toContain(ndsh.registers[0]!);
    expect(audit[1]!.afterJson).toMatchObject({ customerId: primary.id, average: 1_500_000 });
  });

  // ── F2-14 · давхардсан сарын цалин ────────────────────────────────────────────────────
  const addSalary = (id: string, body: Record<string, unknown>) => http().post(url(id, '/salaries')).set(officer).send(body);
  const salaryRows = (applicationId: string, customerId: string) => t.prisma.incomeSalary.findMany({ where: { applicationId, customerId }, orderBy: [{ year: 'asc' }, { month: 'asc' }, { createdAt: 'asc' }] });

  it('F2-14: the same manual salary month cannot be added twice (409 SALARY_MONTH_DUPLICATE); one row, average stays 1,500,000 and no second audit entry', async () => {
    const { app, primary } = await setup();
    expect((await addSalary(app.id, { customerId: primary.id, year: 2026, month: 10, salary: 1_500_000 })).status).toBe(201);
    parse(await calculate(app.id, primary.id, '2026-10', '2026-10'));
    const dup = await addSalary(app.id, { customerId: primary.id, year: 2026, month: 10, salary: 1_500_000 });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'SALARY_MONTH_DUPLICATE', details: { year: 2026, month: 10 } });
    expect(dup.body.message).toContain('2026-10');
    expect(await salaryRows(app.id, primary.id)).toHaveLength(1);
    const view = parse(await http().get(url(app.id)).set(officer));
    expect(view.borrowers[0]!.summary).toMatchObject({ salaryTotal: 1_500_000, avgSalaryMonthly: 1_500_000 });
    const audit = await t.prisma.auditLog.findMany({ where: { applicationId: app.id }, orderBy: { at: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['INCOME_SALARY_ADDED', 'INCOME_CALCULATED']);
  });

  it('F2-14: two manual rows in the same month with DIFFERENT named employers are both accepted (201, 201) and the average sums both (DECISIONS 2026-11-03)', async () => {
    const { app, primary } = await setup();
    expect((await addSalary(app.id, { customerId: primary.id, employer: 'А ХХК', year: 2026, month: 9, salary: 1_000_000 })).status).toBe(201);
    expect((await addSalary(app.id, { customerId: primary.id, employer: 'Б ХХК', year: 2026, month: 9, salary: 500_000 })).status).toBe(201);
    expect(await salaryRows(app.id, primary.id)).toHaveLength(2);
    const calc = parse(await calculate(app.id, primary.id, '2026-09', '2026-09'));
    expect(calc.borrowers[0]!.summary).toMatchObject({ months: 1, salaryTotal: 1_500_000, avgSalaryMonthly: 1_500_000 });
  });

  it('F2-14: same employer twice → 409 (any case / spacing); the message names the same-employer rule and offers no "combine into one row" advice', async () => {
    const { app, primary } = await setup();
    await addSalary(app.id, { customerId: primary.id, employer: 'А ХХК', year: 2026, month: 9, salary: 1_000_000 });
    await addSalary(app.id, { customerId: primary.id, employer: 'Б ХХК', year: 2026, month: 9, salary: 500_000 });
    for (const employer of ['А ХХК', ' а  ххк ', 'Б ХХК']) {
      const dup = await addSalary(app.id, { customerId: primary.id, employer, year: 2026, month: 9, salary: 1_000_000 });
      expect(dup.status, employer).toBe(409);
      expect(dup.body).toMatchObject({ code: 'SALARY_MONTH_DUPLICATE', details: { year: 2026, month: 9 } });
      expect(dup.body.message).toMatch(/2026-09.*ижил ажил олгогч.*нэрийг заан/);
      expect(dup.body.message).not.toMatch(/нийлбэр|нэг мөрөөр/);
    }
    expect(await salaryRows(app.id, primary.id)).toHaveLength(2);
  });

  it('F2-14: a blank employer is a wildcard against a named one in the same month, in both orders → 409', async () => {
    const { app, primary } = await setup();
    // blank first, then named
    expect((await addSalary(app.id, { customerId: primary.id, year: 2026, month: 8, salary: 1_000_000 })).status).toBe(201);
    const namedAfterBlank = await addSalary(app.id, { customerId: primary.id, employer: 'А ХХК', year: 2026, month: 8, salary: 500_000 });
    expect(namedAfterBlank.status).toBe(409);
    expect(namedAfterBlank.body.code).toBe('SALARY_MONTH_DUPLICATE');
    // named first, then blank
    expect((await addSalary(app.id, { customerId: primary.id, employer: 'А ХХК', year: 2026, month: 7, salary: 1_000_000 })).status).toBe(201);
    const blankAfterNamed = await addSalary(app.id, { customerId: primary.id, year: 2026, month: 7, salary: 500_000 });
    expect(blankAfterNamed.status).toBe(409);
    expect(blankAfterNamed.body.code).toBe('SALARY_MONTH_DUPLICATE');
    expect(await salaryRows(app.id, primary.id)).toHaveLength(2);
  });

  it('F2-14: a double click (two concurrent identical requests) stores exactly one row — one 201, one 409', async () => {
    const { app, primary } = await setup();
    const body = { customerId: primary.id, year: 2026, month: 10, salary: 1_500_000 };
    const [a, b] = await Promise.all([addSalary(app.id, body), addSalary(app.id, body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await salaryRows(app.id, primary.id)).toHaveLength(1);
  });

  it('F2-14: uniqueness is per borrower and per month; deleting the manual row frees the month again', async () => {
    const { app, primary, co } = await setup({ co: true });
    const body = (customerId: string, month: number) => ({ customerId, year: 2026, month, salary: 1_000_000 });
    expect((await addSalary(app.id, body(primary.id, 10))).status).toBe(201);
    expect((await addSalary(app.id, body(co!.id, 10))).status).toBe(201); // other borrower, same month
    expect((await addSalary(app.id, body(primary.id, 9))).status).toBe(201); // same borrower, other month
    expect((await addSalary(app.id, body(primary.id, 10))).status).toBe(409);
    const row = (await salaryRows(app.id, primary.id)).find((r) => r.month === 10)!;
    expect((await http().delete(url(app.id, `/salaries/${row.id}`)).set(officer)).status).toBeLessThan(300);
    expect((await addSalary(app.id, body(primary.id, 10))).status).toBe(201);
  });

  it('F2-14: a manual month that НДШ already has is rejected (409 SALARY_MONTH_IN_NDSH) unless it names a different employer (second job); the average is never doubled', async () => {
    const { app, primary } = await setup();
    await fetchNdsh(app.id, primary.id);
    await calculate(app.id, primary.id);
    for (const employer of [undefined, ' монгол  ШУУДАН ххк ']) {
      const res = await addSalary(app.id, { customerId: primary.id, ...(employer ? { employer } : {}), year: 2026, month: 10, salary: 1_500_000 });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('SALARY_MONTH_IN_NDSH');
      expect(res.body.message).toContain('2026-10');
    }
    expect(parse(await http().get(url(app.id)).set(officer)).borrowers[0]!.summary.avgSalaryMonthly).toBe(1_500_000);
    const second = parse(await addSalary(app.id, { customerId: primary.id, employer: 'Хоёр дахь ажил', year: 2026, month: 10, salary: 500_000 }));
    expect(second.borrowers[0]!.summary.avgSalaryMonthly).toBe(1_541_666.67);
    expect((await addSalary(app.id, { customerId: primary.id, employer: ' хоёр  ДАХЬ ажил', year: 2026, month: 10, salary: 1 })).body.code).toBe('SALARY_MONTH_DUPLICATE'); // нэмэлт ажлыг давтахгүй
    expect((await addSalary(app.id, { customerId: primary.id, year: 2025, month: 10, salary: 300_000 })).status).toBe(201); // НДШ-д байхгүй сар
  });

  it('F2-14: fetching НДШ after hand-entered salary drops only the manual rows it now repeats (same month + blank / same employer); the month is counted once', async () => {
    const { app, primary } = await setup();
    expect((await addSalary(app.id, { customerId: primary.id, year: 2026, month: 10, salary: 1_500_000 })).status).toBe(201); // НДШ-тэй давхцана
    expect((await addSalary(app.id, { customerId: primary.id, employer: 'Хоёр дахь ажил', year: 2026, month: 9, salary: 500_000 })).status).toBe(201); // нэмэлт ажил
    expect((await addSalary(app.id, { customerId: primary.id, year: 2025, month: 10, salary: 300_000 })).status).toBe(201); // НДШ-ийн хүрээнээс гадуур
    const fetched = parse(await fetchNdsh(app.id, primary.id));
    const manual = fetched.borrowers[0]!.salaries.filter((s) => s.source === 'MANUAL').map((s) => `${s.year}-${s.month}`).sort();
    expect(manual).toEqual(['2025-10', '2026-9']);
    expect(fetched.borrowers[0]!.salaries.filter((s) => s.year === 2026 && s.month === 10)).toHaveLength(1);
    const calc = parse(await calculate(app.id, primary.id, '2025-10', '2026-10'));
    expect(calc.borrowers[0]!.summary).toMatchObject({ months: 13, salaryTotal: 18_800_000, avgSalaryMonthly: 1_446_153.85 });
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { applicationId: app.id, action: 'INCOME_NDSH_FETCHED' } });
    expect(audit.afterJson).toMatchObject({ rows: 12, supersededManual: 1 });
  });
});
