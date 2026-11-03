import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { InquiriesResponse, KycCompleted, INQUIRY_SOURCES, StepKey } from '@los/contracts';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { InquiryModule } from './inquiry.module';
import { KYC_INQUIRY_PORT } from './ports/kyc-inquiry.port';
import { FakeKycInquiryPort } from './testing/fake-kyc-inquiry.port';

// Модуль 3 AC: зээлдэгч бүрт 11 лавлагаа; summary_json-д идэвхтэй зээлийн сарын төлбөр; хуучирсан лавлагаа шар тэмдэгтэй; алхам COMPLETED.
describe.skipIf(!hasTestDb)('inquiry API (DB)', () => {
  let t: TestApp;
  let baseUrl: string;
  const kyc = new FakeKycInquiryPort();
  const officer = actors.officer('officer-1');
  beforeAll(async () => {
    t = await createTestApp([InquiryModule], (b) => b.overrideProvider(KYC_INQUIRY_PORT).useValue(kyc), '2026-11-03T02:00:00Z');
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    kyc.now = () => t.clock.now();
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await resetDb(t.prisma);
    kyc.rows = []; kyc.loans = []; kyc.calls = []; kyc.failSources.clear(); kyc.notImplemented = false;
    t.bus.published.length = 0;
    t.clock.set('2026-11-03T02:00:00Z');
  });

  const http = () => request(baseUrl);
  async function setup(opts: { status?: string; co?: boolean; guarantor?: boolean; pledgor?: boolean } = {}) {
    const primary = await createCustomer(t.prisma);
    const app = await createApplication(t.prisma, { status: opts.status ?? 'DRAFT' });
    await t.prisma.loanApplicationStep.createMany({ data: StepKey.map((k) => ({ orgId: ORG, applicationId: app.id, stepKey: k, status: 'PENDING' })) });
    await createBorrower(t.prisma, app.id, primary.id, 'PRIMARY');
    const others: Record<string, string> = {};
    for (const [flag, role] of [['co', 'CO_BORROWER'], ['guarantor', 'GUARANTOR'], ['pledgor', 'PLEDGOR']] as const) {
      if (opts[flag]) { const c = await createCustomer(t.prisma); others[role] = c.id; await createBorrower(t.prisma, app.id, c.id, role); }
    }
    return { app, primary, others };
  }
  const step = async (applicationId: string, key: string) => t.prisma.loanApplicationStep.findFirstOrThrow({ where: { applicationId, stepKey: key } });
  const fetch = (id: string, body: Record<string, unknown> = {}, actor: Record<string, string> = officer) => http().post(`/api/applications/${id}/inquiries/fetch`).set(actor).send(body);

  it('AC: 11 inquiries per borrower (primary, co-borrower, guarantor — not the pledgor); CIB summary has the monthly payment; step COMPLETED', async () => {
    const { app, others } = await setup({ co: true, guarantor: true, pledgor: true });
    const res = await fetch(app.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = InquiriesResponse.parse(res.body);
    expect(body.borrowers.map((b) => b.role)).toEqual(['PRIMARY', 'CO_BORROWER', 'GUARANTOR']);
    expect(body.borrowers.map((b) => b.customerId)).not.toContain(others.PLEDGOR);
    for (const b of body.borrowers) {
      expect(b.items).toHaveLength(11);
      expect(b.items.map((i) => i.source)).toEqual([...INQUIRY_SOURCES]);
      expect(b.complete).toBe(true);
      expect(b.items.find((i) => i.source === 'CIB')!.summary.monthly_payment).toBe(350_000);
      expect(b.monthlyDebtPayment).toBe(350_000);
    }
    expect(body.complete).toBe(true);
    expect(body.step).toEqual({ status: 'COMPLETED', reason: null });
    expect((await step(app.id, 'inquiry')).status).toBe('COMPLETED');
    expect(kyc.calls).toHaveLength(3);
    // FR-3.4: хар жагсаалтын үр дүн kyc-д дамжсан (hit=false), KycCompleted гурван оролцогчид
    expect(kyc.calls.every((c) => c.blacklist?.hit === false)).toBe(true);
    const completed = t.bus.published.filter((e) => e.type === 'KycCompleted');
    expect(completed).toHaveLength(0); // outbox → relay-ээр л bus-д гарна
    expect(await t.prisma.outbox.count({ where: { type: 'KycCompleted' } })).toBe(3);
    expect(KycCompleted.parse(JSON.parse(JSON.stringify((await t.prisma.outbox.findFirstOrThrow({ where: { type: 'KycCompleted' } })).payload))).blacklisted).toBe(false);
  });

  it('the register is sent to kyc normalised but never written to the audit log', async () => {
    const { app, primary } = await setup();
    await fetch(app.id);
    expect(kyc.calls[0]!.registerNo).toMatch(/^УБ\d{8}$/);
    expect(kyc.calls[0]!.staleDays).toBe(30);
    const audit = await t.prisma.auditLog.findMany({ where: { applicationId: app.id } });
    expect(audit.map((a) => a.action)).toEqual(['INQUIRY_FETCHED']);
    expect(JSON.stringify(audit)).not.toContain(kyc.calls[0]!.registerNo);
    expect(JSON.stringify(audit)).toContain(primary.id);
  });

  it('FR-3.4: a blacklisted borrower is flagged RED but nothing is blocked (step still COMPLETED)', async () => {
    const { app, primary } = await setup();
    await t.prisma.blacklist.create({ data: { orgId: ORG, registerNoHash: primary.registerNoHash, registerNoEncrypted: primary.registerNoEncrypted, customerType: 'INDIVIDUAL', name: 'X', listType: 'INTERNAL', reasonCode: 'FRAUD', isActive: true, registeredBy: 'admin-1' } });
    const body = InquiriesResponse.parse((await fetch(app.id)).body);
    expect(kyc.calls[0]!.blacklist).toEqual({ hit: true, reasons: [{ reasonCode: 'FRAUD', listType: 'INTERNAL' }] });
    expect(body.borrowers[0]!.items.find((i) => i.source === 'BLACKLIST')!.warningLevel).toBe('RED');
    expect(body.step.status).toBe('COMPLETED');
    expect(await t.prisma.outbox.findFirstOrThrow({ where: { type: 'KycCompleted' } }).then((o) => (o.payload as { blacklisted: boolean }).blacklisted)).toBe(true);
  });

  it('AC: a stale inquiry is flagged (yellow) and the step goes back to PENDING after a recheck; re-fetching fixes it', async () => {
    const { app } = await setup();
    await fetch(app.id);
    t.clock.set('2026-12-10T02:00:00Z'); // 37 хоног
    const list = InquiriesResponse.parse((await http().get(`/api/applications/${app.id}/inquiries`).set(officer)).body);
    expect(list.borrowers[0]).toMatchObject({ complete: false, hasStale: true, missing: [] });
    expect(list.borrowers[0]!.items.every((i) => i.status === 'STALE')).toBe(true);
    expect(list.complete).toBe(false);
    const re = InquiriesResponse.parse((await http().post(`/api/applications/${app.id}/inquiries/recheck`).set(officer)).body);
    expect(re.step).toEqual({ status: 'PENDING', reason: 'INQUIRY_STALE' });
    expect((await step(app.id, 'inquiry')).staleReason).toBe('INQUIRY_STALE');
    const again = InquiriesResponse.parse((await fetch(app.id)).body);
    expect(again.step.status).toBe('COMPLETED');
    expect(again.borrowers[0]!.hasStale).toBe(false);
  });

  it('partial failure: the step stays PENDING with INQUIRY_MISSING, failures are reported, KycCompleted is not sent for that borrower', async () => {
    const { app } = await setup();
    kyc.failSources.add('FICO');
    const body = InquiriesResponse.parse((await fetch(app.id)).body);
    expect(body.failures).toEqual([expect.objectContaining({ source: 'FICO', code: 'INQUIRY_UNAVAILABLE' })]);
    expect(body.borrowers[0]!.missing).toEqual(['FICO']);
    expect(body.step).toEqual({ status: 'PENDING', reason: 'INQUIRY_MISSING' });
    expect(await t.prisma.outbox.count({ where: { type: 'KycCompleted' } })).toBe(0);
    // зөвхөн дутууг дахин татаж болно
    kyc.failSources.clear();
    const fixed = InquiriesResponse.parse((await fetch(app.id, { sources: ['FICO'] })).body);
    expect(fixed.step.status).toBe('COMPLETED');
  });

  it('adding a participant later: fetching only that customer keeps the others; the step needs all of them', async () => {
    const { app } = await setup();
    await fetch(app.id);
    const co = await createCustomer(t.prisma);
    await createBorrower(t.prisma, app.id, co.id, 'CO_BORROWER');
    const list = InquiriesResponse.parse((await http().get(`/api/applications/${app.id}/inquiries`).set(officer)).body);
    expect(list.borrowers.map((b) => b.complete)).toEqual([true, false]);
    const one = InquiriesResponse.parse((await fetch(app.id, { customerId: co.id })).body);
    expect(kyc.calls.at(-1)!.customerId).toBe(co.id);
    expect(one.complete).toBe(true);
    expect((await fetch(app.id, { customerId: 'nobody' })).body.code).toBe('INQUIRY_BORROWER_NOT_FOUND');
  });

  it('fetching marks a COMPLETED score step STALE (INQUIRY_CHANGED)', async () => {
    const { app } = await setup();
    await t.prisma.loanApplicationStep.updateMany({ where: { applicationId: app.id, stepKey: 'score' }, data: { status: 'COMPLETED' } });
    await fetch(app.id);
    expect(await step(app.id, 'score')).toMatchObject({ status: 'STALE', staleReason: 'INQUIRY_CHANGED' });
  });

  it('FR-3.2 unregistered loans: add / delete, monthly debt payment grows, step is not completed by it, score goes STALE', async () => {
    const { app, primary } = await setup();
    await fetch(app.id);
    await t.prisma.loanApplicationStep.updateMany({ where: { applicationId: app.id, stepKey: 'score' }, data: { status: 'COMPLETED' } });
    const add = await http().post(`/api/applications/${app.id}/inquiries/unregistered-loans`).set(officer).send({ customerId: primary.id, lenderName: 'Найзын зээл', amount: 2_000_000, monthlyPayment: 150_000 });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const list = InquiriesResponse.parse((await http().get(`/api/applications/${app.id}/inquiries`).set(officer)).body);
    expect(list.borrowers[0]).toMatchObject({ monthlyDebtPayment: 500_000, unregisteredLoans: [expect.objectContaining({ lenderName: 'Найзын зээл' })] });
    expect(await step(app.id, 'score')).toMatchObject({ status: 'STALE', staleReason: 'INQUIRY_CHANGED' });
    expect((await http().delete(`/api/applications/${app.id}/inquiries/unregistered-loans/${add.body.id}`).set(officer)).status).toBe(204);
    expect(InquiriesResponse.parse((await http().get(`/api/applications/${app.id}/inquiries`).set(officer)).body).borrowers[0]!.monthlyDebtPayment).toBe(350_000);
    expect((await http().post(`/api/applications/${app.id}/inquiries/unregistered-loans`).set(officer).send({ customerId: 'nobody', lenderName: 'x', amount: 1, monthlyPayment: 1 })).body.code).toBe('INQUIRY_BORROWER_NOT_FOUND');
    expect((await http().post(`/api/applications/${app.id}/inquiries/unregistered-loans`).set(officer).send({ customerId: primary.id, lenderName: '', amount: 1, monthlyPayment: 1 })).status).toBe(400);
  });

  it('real mode without a provider: the 501 is passed through, nothing changes', async () => {
    const { app } = await setup();
    kyc.notImplemented = true;
    const res = await fetch(app.id);
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('INTEGRATION_NOT_IMPLEMENTED');
    expect((await step(app.id, 'inquiry')).status).toBe('PENDING');
  });

  it('only DRAFT/RETURNED applications can be changed; reading works in any status', async () => {
    const { app } = await setup({ status: 'PENDING_APPROVAL' });
    const res = await fetch(app.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('APPLICATION_NOT_EDITABLE');
    expect((await http().get(`/api/applications/${app.id}/inquiries`).set(officer)).status).toBe(200);
  });

  it('access: another officer 403, approver may read but not write, unknown application 404, anonymous 401', async () => {
    const { app } = await setup();
    expect((await fetch(app.id, {}, actors.officer('officer-2'))).status).toBe(403);
    expect((await http().get(`/api/applications/${app.id}/inquiries`).set(actors.officer('officer-2'))).status).toBe(403);
    expect((await http().get(`/api/applications/${app.id}/inquiries`).set(actors.approver())).status).toBe(200);
    expect((await fetch(app.id, {}, actors.approver())).status).toBe(403);
    expect((await fetch('00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await http().get(`/api/applications/${app.id}/inquiries`)).status).toBe(401);
    expect((await fetch(app.id, { sources: ['NOPE'] })).status).toBe(400);
  });

  it('no participants → empty list, step reason NO_BORROWER', async () => {
    const app = await createApplication(t.prisma);
    await t.prisma.loanApplicationStep.createMany({ data: StepKey.map((k) => ({ orgId: ORG, applicationId: app.id, stepKey: k, status: 'PENDING' })) });
    const body = InquiriesResponse.parse((await fetch(app.id)).body);
    expect(body).toMatchObject({ borrowers: [], complete: false, step: { status: 'PENDING', reason: 'NO_BORROWER' } });
  });
});
