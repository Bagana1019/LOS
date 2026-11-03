import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CreditHistorySummary, InquiryFetchResponse, InquiryListResponse, INQUIRY_SOURCES, NdshSalaryResponse } from '@los/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma.service';
import { as, createApp } from './app';

const APP = 'app-1';
const CUST = 'cust-1';
const REG = 'УБ90010112';

describe.skipIf(!process.env.TEST_DATABASE_URL)('kyc · inquiry (FR-3) and NDSH (FR-4.1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => { app = await createApp(); prisma = app.get(PrismaService); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => { await prisma.inquiry.deleteMany(); await prisma.unregisteredLoan.deleteMany(); });

  const http = () => request(app.getHttpServer());
  const fetchAll = (body: Record<string, unknown> = {}, who: Parameters<typeof as>[0] = 'officerA') =>
    http().post('/api/inquiry/fetch').set(as(who)).send({ applicationId: APP, customerId: CUST, registerNo: REG, staleDays: 30, blacklist: { hit: false, reasons: [] }, ...body });

  it('AC: fetches all 11 inquiries per borrower; CIB summary exposes the active-loan monthly payment', async () => {
    const res = await fetchAll();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = InquiryFetchResponse.parse(res.body);
    expect(body.failures).toEqual([]);
    expect(body.items.map((i) => i.source).sort()).toEqual([...INQUIRY_SOURCES].sort());
    expect(body.items).toHaveLength(11);
    const cib = body.items.find((i) => i.source === 'CIB')!;
    for (const k of ['active_loan_count', 'total_disbursed', 'outstanding', 'monthly_payment']) expect(typeof cib.summary[k]).toBe('number');
    expect(cib.detail).toHaveProperty('loans');
    expect(cib.expiresAt).toBe(new Date(new Date(cib.fetchedAt).getTime() + 30 * 86_400_000).toISOString());
  });

  it('the external response is stored encrypted and the register is never stored', async () => {
    await fetchAll();
    const rows = await prisma.inquiry.findMany();
    expect(rows).toHaveLength(11);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(REG);
    expect(dump).not.toContain('lender');
    for (const r of rows) expect(r.rawJson).toMatchObject({ v: 1, enc: expect.stringMatching(/^v1\./) });
  });

  it('a blacklist hit is stored as a RED warning (a warning, not a block)', async () => {
    const res = await fetchAll({ sources: ['BLACKLIST'], blacklist: { hit: true, reasons: [{ reasonCode: 'FRAUD', listType: 'INTERNAL' }] } });
    expect(res.status).toBe(200);
    expect(InquiryFetchResponse.parse(res.body).items[0]).toMatchObject({ source: 'BLACKLIST', warningLevel: 'RED', summary: { hit: true, reason_codes: ['FRAUD'] } });
  });

  it('partial failure: the unavailable register stores nothing and reports every source; BLACKLIST without a result is reported', async () => {
    const bad = await fetchAll({ registerNo: 'УБ99999999', sources: ['CIB', 'FICO'] });
    expect(bad.status).toBe(200);
    const parsed = InquiryFetchResponse.parse(bad.body);
    expect(parsed.items).toEqual([]);
    expect(parsed.failures.map((f) => f.code)).toEqual(['INQUIRY_UNAVAILABLE', 'INQUIRY_UNAVAILABLE']);
    const missing = await http().post('/api/inquiry/fetch').set(as('officerA')).send({ applicationId: APP, customerId: CUST, registerNo: REG, sources: ['BLACKLIST'] });
    expect(InquiryFetchResponse.parse(missing.body).failures[0]).toMatchObject({ source: 'BLACKLIST', code: 'BLACKLIST_RESULT_MISSING' });
  });

  it('list returns the latest row per source; a re-fetch keeps history but the list shows the newest', async () => {
    await fetchAll();
    await fetchAll({ sources: ['FICO'] });
    expect(await prisma.inquiry.count()).toBe(12);
    const list = InquiryListResponse.parse((await http().get(`/api/inquiry?applicationId=${APP}&customerId=${CUST}`).set(as('officerA'))).body);
    expect(list.items).toHaveLength(11);
    const other = InquiryListResponse.parse((await http().get(`/api/inquiry?applicationId=${APP}&customerId=nobody`).set(as('officerA'))).body);
    expect(other.items).toEqual([]);
  });

  it('FR-3.2 unregistered loans: add, list, delete; they add to the credit-history monthly debt', async () => {
    await fetchAll({ sources: ['CIB', 'FICO'] });
    const before = CreditHistorySummary.parse((await http().get(`/api/inquiry/credit-history?applicationId=${APP}&customerId=${CUST}`).set(as('officerA'))).body);
    expect(before.existingDebtServiceMonthly).not.toBeNull();
    expect(before.ficoScore).toBeGreaterThanOrEqual(520);

    const add = await http().post('/api/inquiry/unregistered-loans').set(as('officerA')).send({ applicationId: APP, customerId: CUST, lenderName: 'Найзын зээл', amount: 2_000_000, monthlyPayment: 150_000 });
    expect(add.status).toBe(201);
    const after = CreditHistorySummary.parse((await http().get(`/api/inquiry/credit-history?applicationId=${APP}&customerId=${CUST}`).set(as('officerA'))).body);
    expect(after.existingDebtServiceMonthly).toBe(before.existingDebtServiceMonthly! + 150_000);
    expect(InquiryListResponse.parse((await http().get(`/api/inquiry?applicationId=${APP}`).set(as('officerA'))).body).unregisteredLoans).toHaveLength(1);

    expect((await http().delete(`/api/inquiry/unregistered-loans/${add.body.id}?applicationId=${APP}`).set(as('officerA'))).status).toBe(204);
    expect((await http().delete(`/api/inquiry/unregistered-loans/${add.body.id}?applicationId=${APP}`).set(as('officerA'))).body.code).toBe('UNREGISTERED_LOAN_NOT_FOUND');
    expect((await http().post('/api/inquiry/unregistered-loans').set(as('officerA')).send({ applicationId: APP, customerId: CUST, lenderName: '', amount: 1, monthlyPayment: 1 })).status).toBe(400);
  });

  it('nothing fetched → credit history is all null (unknown, not zero)', async () => {
    const r = CreditHistorySummary.parse((await http().get(`/api/inquiry/credit-history?applicationId=${APP}&customerId=${CUST}`).set(as('officerA'))).body);
    expect(r).toEqual({ ficoScore: null, activeLoanCount: null, overdueHistoryMonths: null, existingDebtServiceMonthly: null });
  });

  it('permissions: approver reads but cannot fetch or edit; anonymous is 401; bad body is 400', async () => {
    expect((await fetchAll({}, 'approver')).status).toBe(403);
    expect((await http().get(`/api/inquiry?applicationId=${APP}`).set(as('approver'))).status).toBe(200);
    expect((await http().get(`/api/inquiry?applicationId=${APP}`)).status).toBe(401);
    expect((await fetchAll({ registerNo: '' })).status).toBe(400);
    expect((await fetchAll({ sources: [] })).status).toBe(400);
  });

  it('NDSH: returns up to 24 monthly salary rows; unavailable → 503, malformed register → 400', async () => {
    const ok = await http().post('/api/ndsh/salaries').set(as('officerA')).send({ registerNo: REG });
    expect(ok.status).toBe(200);
    const parsed = NdshSalaryResponse.parse(ok.body);
    expect(parsed.items.length).toBeGreaterThan(12);
    expect(JSON.stringify(ok.body)).not.toContain(REG);
    expect((await http().post('/api/ndsh/salaries').set(as('officerA')).send({ registerNo: 'УБ99999999' })).body.code).toBe('NDSH_UNAVAILABLE');
    expect((await http().post('/api/ndsh/salaries').set(as('officerA')).send({ registerNo: 'AB1' })).body.code).toBe('INVALID_REGISTER_NO');
    expect((await http().post('/api/ndsh/salaries').set(as('approver')).send({ registerNo: REG })).status).toBe(403);
  });
});
