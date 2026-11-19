import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ApplicationDetail, type RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { ApplicationModule } from '../application/application.module';
import { ApplicationStateMachine } from '../application/application-state-machine';
import { DMS_DOCUMENTS } from '../document/dms-documents.port';
import { FakeDmsDocuments } from '../document/testing/fake-dms-documents';
import { KYC_AML_PORT } from './ports/kyc-aml.port';
import { FakeKycAml } from './testing/fake-kyc-aml.port';

// H4 (FR-9.2, BR-7) ба C4 (G1, FR-3.4; docs/05-compliance-aml.md §5): илгээх хаалт — заавал баримт ба AML шалгалт.
const DAY = 86_400_000;
const CHECKLIST = [
  { key: 'id_card', name: 'Иргэний үнэмлэхний хуулбар', required: true },
  { key: 'application_form', name: 'Зээлийн хүсэлтийн маягт', required: true },
  { key: 'photo', name: 'Зураг', required: false },
];
const OTHER_STEPS = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score'];

describe.skipIf(!hasTestDb)('submit gate G1: documents (FR-9.2) + AML (FR-3.4)', () => {
  let t: TestApp;
  const aml = new FakeKycAml(() => t.clock.now());
  const dms = new FakeDmsDocuments();
  const officer = actors.officer('officer-a');

  beforeAll(async () => {
    t = await createTestApp([ApplicationModule], (b) => b.overrideProvider(KYC_AML_PORT).useValue(aml).overrideProvider(DMS_DOCUMENTS).useValue(dms));
  });
  afterAll(async () => { await t?.close(); });
  beforeEach(async () => {
    await resetDb(t.prisma);
    aml.reset();
    dms.reset();
  });

  const http = () => request(t.app.getHttpServer());
  const submit = (appId: string, actor = officer) => http().post(`/api/applications/${appId}/transition`).set(actor).send({ to: 'SUBMITTED' });
  const statusOf = async (appId: string) => (await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: appId } })).status;

  /** Бүтээгдэхүүн + checklist, 7 алхам COMPLETED, `document` PENDING, оролцогчид (харилцагчийн `updated_at` = 2 хоногийн өмнө). */
  async function ready(roles: Array<'PRIMARY' | 'CO_BORROWER' | 'GUARANTOR' | 'PLEDGOR'> = ['PRIMARY'], checklist: unknown = CHECKLIST) {
    const product = await t.prisma.product.create({ data: { orgId: ORG, code: `P-${randomUUID().slice(0, 6)}`, name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40, documentChecklistJson: checklist as never } });
    const res = await http().post('/api/applications').set(officer).send({ productId: product.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const app = ApplicationDetail.parse(res.body);
    await t.prisma.loanApplication.update({ where: { id: app.id }, data: { amount: 10_000_000, termMonths: 12, interestRate: 24 } });
    await t.prisma.loanApplicationStep.updateMany({ where: { applicationId: app.id, stepKey: { in: OTHER_STEPS } }, data: { status: 'COMPLETED', completedAt: t.clock.now() } });
    const customers = [];
    for (const role of roles) {
      const c = await createCustomer(t.prisma);
      await createBorrower(t.prisma, app.id, c.id, role);
      customers.push(c);
    }
    await t.prisma.customer.updateMany({ where: { id: { in: customers.map((c) => c.id) } }, data: { updatedAt: new Date(t.clock.now().getTime() - 2 * DAY) } });
    return { app, product, customers };
  }
  const upload = async (appId: string, key: string) => dms.insertDirect(ORG, { applicationId: appId, type: key, relatedEntity: 'APPLICATION', fileId: dms.addFile(ORG), checklistKey: key });
  const uploadRequired = async (appId: string) => { await upload(appId, 'id_card'); await upload(appId, 'application_form'); };

  // ── H4 · FR-9.2 ───────────────────────────────────────────────────────────────────────
  describe('FR-9.2 required documents', () => {
    it('дутуу заавал баримт → 422 DOCUMENTS_INCOMPLETE, нэрээр жагсаана; DRAFT хэвээр; AML дуудагдахгүй', async () => {
      const { app } = await ready();
      await upload(app.id, 'id_card');
      const res = await submit(app.id);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('DOCUMENTS_INCOMPLETE');
      expect(res.body.message).toContain('Зээлийн хүсэлтийн маягт');
      expect(res.body.details).toMatchObject({ missing: ['document'], missingDocuments: [{ key: 'application_form', name: 'Зээлийн хүсэлтийн маягт' }] });
      expect(await statusOf(app.id)).toBe('DRAFT');
      expect(aml.calls).toHaveLength(0);
    });

    it('DB-д COMPLETED гэж хуучирсан алхмыг (dms-д баримт алга) тойрч илгээж чадахгүй — dms-ийн шинэ жагсаалтаар дахин тооцно', async () => {
      const { app } = await ready();
      await t.prisma.loanApplicationStep.updateMany({ where: { applicationId: app.id, stepKey: 'document' }, data: { status: 'COMPLETED', completedAt: t.clock.now() } });
      const res = await submit(app.id);
      expect(res.body.code).toBe('DOCUMENTS_INCOMPLETE');
      expect(res.body.details.missingDocuments.map((d: { key: string }) => d.key)).toEqual(['id_card', 'application_form']);
      const step = await t.prisma.loanApplicationStep.findFirstOrThrow({ where: { applicationId: app.id, stepKey: 'document' } });
      expect(step.status).toBe('PENDING');
    });

    it('заавал баримт бүрдсэн (сонголтот дутуу) → `document` алхам COMPLETED болж SUBMITTED', async () => {
      const { app } = await ready();
      await uploadRequired(app.id);
      const res = await submit(app.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('SUBMITTED');
      expect(res.body.steps.find((s: { stepKey: string }) => s.stepKey === 'document')).toMatchObject({ status: 'COMPLETED', required: true });
    });

    it('detail: `document` алхам «Заавал» (required=true), илгээх шилжилтийн blockedBy-д орно', async () => {
      const { app } = await ready();
      const d = ApplicationDetail.parse((await http().get(`/api/applications/${app.id}`).set(officer)).body);
      expect(d.steps.find((s) => s.stepKey === 'document')?.required).toBe(true);
      expect(d.transitions.find((x) => x.to === 'SUBMITTED')?.blockedBy).toEqual(['document']);
    });

    it('бусад алхам дутуу → 422 STEPS_INCOMPLETE (бүх дутуу алхам + дутуу баримт), AML дуудагдахгүй', async () => {
      const { app } = await ready();
      await t.prisma.loanApplicationStep.updateMany({ where: { applicationId: app.id, stepKey: 'score' }, data: { status: 'PENDING', completedAt: null } });
      const res = await submit(app.id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('STEPS_INCOMPLETE');
      expect(res.body.details.missing).toEqual(['score', 'document']);
      expect(res.body.details.missingDocuments).toHaveLength(2);
      expect(aml.calls).toHaveLength(0);
    });

    it('тохиргооноос (`br7.required_steps`) `document`-г хассан бол баримтгүй илгээж болно — дүрэм hardcode биш', async () => {
      const { app } = await ready();
      await t.prisma.setting.create({ data: { orgId: ORG, key: 'br7.required_steps', valueJson: OTHER_STEPS } });
      const res = await submit(app.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('checklist-гүй бүтээгдэхүүн → заавал баримт байхгүй тул илгээгдэнэ', async () => {
      const { app } = await ready(['PRIMARY'], []);
      expect((await submit(app.id)).status).toBe(200);
    });

    it('бүтээгдэхүүний checklist JSON буруу (тохиргооны алдаа) → 422 DOCUMENTS_INCOMPLETE reason PRODUCT_CHECKLIST_INVALID; хоосон гэж үзэж нэвтрүүлэхгүй', async () => {
      const { app } = await ready(['PRIMARY'], [{ name: 'түлхүүргүй мөр' }]);
      const res = await submit(app.id);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('DOCUMENTS_INCOMPLETE');
      expect(res.body.details).toMatchObject({ reason: 'PRODUCT_CHECKLIST_INVALID', missing: ['document'] });
      expect(res.body.message).toMatch(/тохиргоо/);
      expect((await t.prisma.loanApplicationStep.findFirstOrThrow({ where: { applicationId: app.id, stepKey: 'document' } })).status).toBe('PENDING');
      expect(aml.calls).toHaveLength(0);
    });

    it('dms хүрэхгүй → илгээхгүй (fail-closed), DRAFT хэвээр', async () => {
      const { app } = await ready();
      await uploadRequired(app.id);
      dms.failNext('list', new DomainError('UPSTREAM_ERROR', 'dms down', 502));
      const res = await submit(app.id);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await statusOf(app.id)).toBe('DRAFT');
    });
  });

  // ── C4 · G1 AML ───────────────────────────────────────────────────────────────────────
  describe('G1 AML screening', () => {
    it('оролцогч бүр (PRIMARY, CO_BORROWER, GUARANTOR, PLEDGOR) цэвэр → тус бүрийг нэг удаа шалгаж, лавлагааг хадгалаад SUBMITTED', async () => {
      const { app, customers } = await ready(['PRIMARY', 'CO_BORROWER', 'GUARANTOR', 'PLEDGOR']);
      await uploadRequired(app.id);
      const res = await submit(app.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(aml.screenCalls().sort()).toEqual(customers.map((c) => c.id).sort());
      const req = aml.calls.find((c) => c.op === 'screen' && c.customerId === customers[2].id)?.req;
      expect(req).toMatchObject({ orgId: ORG, applicationId: app.id, borrowerRole: 'GUARANTOR', trigger: 'APPLICATION', subject: { subjectType: 'INDIVIDUAL', firstName: customers[2].firstName } });
      const rows = await t.prisma.applicationAmlScreening.findMany({ where: { applicationId: app.id } });
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.status === 'CLEAR' && !r.blocking && !r.reused && r.checkedBy === 'officer-a' && r.applicationVersion === 1)).toBe(true);
      const audit = await t.prisma.auditLog.findMany({ where: { applicationId: app.id, action: 'AML_SCREENED' } });
      expect(audit).toHaveLength(4);
      expect(JSON.stringify(audit)).not.toMatch(/УБ\d{8}/); // регистр аудитад орохгүй
    });

    it('нэг харилцагч хоёр дүрд (PRIMARY + PLEDGOR) → нэг л удаа шалгана', async () => {
      const { app, customers } = await ready();
      await createBorrower(t.prisma, app.id, customers[0].id, 'PLEDGOR');
      await uploadRequired(app.id);
      expect((await submit(app.id)).status).toBe(200);
      expect(aml.screenCalls()).toEqual([customers[0].id]);
    });

    it('шийдвэрлэгдээгүй hit (GUARANTOR REVIEW_REQUIRED) → 422 AML_REVIEW_REQUIRED, DRAFT; review-ийн дараа шинэ шалгалтгүйгээр илгээгдэнэ', async () => {
      const { app, customers } = await ready(['PRIMARY', 'GUARANTOR']);
      await uploadRequired(app.id);
      aml.willScreen(customers[1].id, 'REVIEW_REQUIRED');
      const blocked = await submit(app.id);
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(422);
      expect(blocked.body.code).toBe('AML_REVIEW_REQUIRED');
      expect(blocked.body.details.borrowers).toEqual([expect.objectContaining({ customerId: customers[1].id, role: 'GUARANTOR', status: 'REVIEW_REQUIRED', reason: 'REVIEW_REQUIRED' })]);
      expect(await statusOf(app.id)).toBe('DRAFT');
      const row = await t.prisma.applicationAmlScreening.findFirstOrThrow({ where: { applicationId: app.id, customerId: customers[1].id } });
      expect(row).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });

      // дахин оролдоход блоклосон шалгалтыг дахин ашиглана (review-ийн дарааллыг хуучруулахгүй)
      aml.calls.length = 0;
      expect((await submit(app.id)).body.code).toBe('AML_REVIEW_REQUIRED');
      expect(aml.screenCalls()).not.toContain(customers[1].id);

      aml.review(customers[1].id, 'CLEARED_AFTER_REVIEW');
      aml.calls.length = 0;
      const ok = await submit(app.id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(aml.screenCalls()).toEqual([]); // хоёул цонх дотор, өөрчлөгдөөгүй → дахин ашиглана
      const after = await t.prisma.applicationAmlScreening.findFirstOrThrow({ where: { applicationId: app.id, customerId: customers[1].id } });
      expect(after).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false, reused: true, screeningId: row.screeningId });
    });

    it('баталгаажсан тохирол (CONFIRMED_MATCH) → 422 AML_CONFIRMED_MATCH; дахин оролдоход ч блоклогдоно', async () => {
      const { app, customers } = await ready(['PRIMARY', 'CO_BORROWER']);
      await uploadRequired(app.id);
      aml.willScreen(customers[1].id, 'CONFIRMED_MATCH');
      expect((await submit(app.id)).body.code).toBe('AML_CONFIRMED_MATCH');
      const again = await submit(app.id);
      expect(again.status).toBe(422);
      expect(again.body.code).toBe('AML_CONFIRMED_MATCH');
      expect(await statusOf(app.id)).toBe('DRAFT');
    });

    it('WARNING (зөвхөн анхааруулга, BR-9) → блоклохгүй', async () => {
      const { app, customers } = await ready();
      await uploadRequired(app.id);
      aml.willScreen(customers[0].id, 'WARNING');
      expect((await submit(app.id)).status).toBe(200);
    });

    it('reuse: origination-д ижил screening + ижил customer snapshot (өөр хүсэлтээс) байвал цонх дотор дахин шалгахгүй (reused=true)', async () => {
      const first = await ready();
      await uploadRequired(first.app.id);
      expect((await submit(first.app.id)).status).toBe(200);
      const firstRow = await t.prisma.applicationAmlScreening.findFirstOrThrow({ where: { applicationId: first.app.id } });
      const second = await ready([]);
      await createBorrower(t.prisma, second.app.id, first.customers[0].id, 'PRIMARY');
      await uploadRequired(second.app.id);
      aml.calls.length = 0;
      expect((await submit(second.app.id)).status).toBe(200);
      expect(aml.screenCalls()).toEqual([]);
      expect(await t.prisma.applicationAmlScreening.findFirstOrThrow({ where: { applicationId: second.app.id } })).toMatchObject({ screeningId: firstRow.screeningId, reused: true, customerUpdatedAt: firstRow.customerUpdatedAt });
    });

    it('reuse хийхгүй: kyc-д өөр газраас хийгдсэн шалгалт (origination-д snapshot байхгүй) цонх дотор ч шинээр шалгана', async () => {
      const { app, customers } = await ready();
      await uploadRequired(app.id);
      aml.seedLatest(customers[0].id, { screenedAt: new Date(t.clock.now().getTime() - 3_600_000).toISOString() });
      expect((await submit(app.id)).status).toBe(200);
      expect(aml.screenCalls()).toEqual([customers[0].id]);
    });

    it('RACE: kyc дуудлагын явцад харилцагч засагдвал (updated_at < хадгалах цаг) хуучин identity-ийн шалгалтаар ИЛГЭЭХГҮЙ → 409 AML_SCREENING_STALE; дахин илгээхэд шинэ identity-г шалгана', async () => {
      const { app, customers } = await ready();
      await uploadRequired(app.id);
      const editedAt = new Date(t.clock.now().getTime() - 60_000); // засвар хадгалах цагаас (clock.now) ӨМНӨ
      aml.onScreen = async (customerId) => {
        await t.prisma.customer.update({ where: { id: customerId }, data: { firstName: 'Засагдсан', updatedAt: editedAt } });
      };
      const res = await submit(app.id);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('AML_SCREENING_STALE');
      expect(await statusOf(app.id)).toBe('DRAFT');
      aml.onScreen = undefined;
      aml.calls.length = 0;
      expect((await submit(app.id)).status).toBe(200);
      const req = aml.calls.find((c) => c.op === 'screen')?.req;
      expect(req?.subject).toMatchObject({ firstName: 'Засагдсан' });
      expect(await t.prisma.applicationAmlScreening.findFirstOrThrow({ where: { applicationId: app.id, customerId: customers[0].id } })).toMatchObject({ customerUpdatedAt: editedAt });
    });

    it('reuse цонхноос хуучин (25 цаг) → шинээр шалгана', async () => {
      const { app, customers } = await ready();
      await uploadRequired(app.id);
      aml.seedLatest(customers[0].id, { screenedAt: new Date(t.clock.now().getTime() - 25 * 3_600_000).toISOString() });
      expect((await submit(app.id)).status).toBe(200);
      expect(aml.screenCalls()).toEqual([customers[0].id]);
    });

    it('тохиргоо `aml.screening_reuse_hours = 0` → үргэлж шинээр шалгана', async () => {
      const { app, customers } = await ready();
      await uploadRequired(app.id);
      await t.prisma.setting.create({ data: { orgId: ORG, key: 'aml.screening_reuse_hours', valueJson: 0 } });
      aml.seedLatest(customers[0].id, { screenedAt: t.clock.now().toISOString() });
      expect((await submit(app.id)).status).toBe(200);
      expect(aml.screenCalls()).toEqual([customers[0].id]);
    });

    it('kyc хүрэхгүй → 503 AML_SCREENING_UNAVAILABLE (retryable), DRAFT, «цэвэр» хадгалахгүй; kyc сэргэхэд илгээгдэнэ', async () => {
      const { app } = await ready();
      await uploadRequired(app.id);
      aml.down = true;
      const res = await submit(app.id);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'AML_SCREENING_UNAVAILABLE', details: { retryable: true } });
      expect(await statusOf(app.id)).toBe('DRAFT');
      expect(await t.prisma.applicationAmlScreening.count({ where: { applicationId: app.id } })).toBe(0);
      aml.down = false;
      expect((await submit(app.id)).status).toBe(200);
    });

    it('эрх: өөр ЗЭЗ → 403, dms/kyc дуудагдахгүй', async () => {
      const { app } = await ready();
      const res = await submit(app.id, actors.officer('officer-b'));
      expect(res.status).toBe(403);
      expect(aml.calls).toHaveLength(0);
      expect(dms.listCalls).toBe(0);
    });

    describe('түгжээн доорх эцсийн шалгалт (ApplicationStateMachine) — урьдчилсан шалгалтын дараах өөрчлөлтийг тойруулахгүй', () => {
      const ctx = (): RequestContext => ({ userId: 'officer-a', roles: ['OFFICER'], branchId: 'branch-1', orgId: ORG, customerId: null, correlationId: randomUUID() });
      const apply = (appId: string, via: 'USER' | 'SYSTEM' = 'USER') => t.prisma.$transaction((tx) => t.app.get(ApplicationStateMachine).apply(tx, ctx(), appId, 'SUBMITTED', { via }));
      async function codeOf(p: Promise<unknown>) {
        try { await p; } catch (e) { return { code: ((e as DomainError).getResponse() as { code: string }).code, status: (e as DomainError).getStatus() }; }
        throw new Error('expected rejection');
      }
      const screeningRow = (appId: string, customerId: string, o: Record<string, unknown> = {}) => t.prisma.applicationAmlScreening.create({
        data: { orgId: ORG, applicationId: appId, customerId, borrowerRole: 'PRIMARY', screeningId: 's1', status: 'CLEAR', blocking: false, riskScore: 0, riskLevel: 'LOW', hitCount: 0, listVersions: {}, screenedAt: t.clock.now(), applicationVersion: 1, checkedAt: t.clock.now(), customerUpdatedAt: new Date(t.clock.now().getTime() - 2 * DAY), ...o },
      });
      async function screenedReady() {
        const r = await ready();
        await t.prisma.loanApplicationStep.updateMany({ where: { applicationId: r.app.id, stepKey: 'document' }, data: { status: 'COMPLETED', completedAt: t.clock.now() } });
        return r;
      }

      it('шалгалтгүй оролцогч (урьдчилсан шалгалтгүйгээр шууд, эсвэл дараа нь нэмэгдсэн) → 409 AML_SCREENING_STALE', async () => {
        const { app } = await screenedReady();
        expect(await codeOf(apply(app.id))).toEqual({ code: 'AML_SCREENING_STALE', status: 409 });
        expect(await statusOf(app.id)).toBe('DRAFT');
      });

      it('хадгалсан шалгалтын дараа харилцагчийн мэдээлэл өөрчлөгдсөн → 409 AML_SCREENING_STALE', async () => {
        const { app, customers } = await screenedReady();
        await screeningRow(app.id, customers[0].id); // checked_at = одоо (засвараас ХОЙШ) — цагийн дараалал биш snapshot тэнцэл шийднэ
        await t.prisma.customer.update({ where: { id: customers[0].id }, data: { updatedAt: new Date(t.clock.now().getTime() - 60_000) } });
        expect(await codeOf(apply(app.id))).toEqual({ code: 'AML_SCREENING_STALE', status: 409 });
      });

      it('хадгалсан блоклосон шалгалт → 422 AML_REVIEW_REQUIRED (SYSTEM шилжилт ч тойрохгүй)', async () => {
        const { app, customers } = await screenedReady();
        await screeningRow(app.id, customers[0].id, { status: 'REVIEW_REQUIRED', blocking: true, riskScore: 60, riskLevel: 'HIGH', hitCount: 1 });
        expect(await codeOf(apply(app.id))).toEqual({ code: 'AML_REVIEW_REQUIRED', status: 422 });
        expect(await codeOf(apply(app.id, 'SYSTEM'))).toEqual({ code: 'AML_REVIEW_REQUIRED', status: 422 });
      });

      it('цэвэр, шинэ шалгалт бүх оролцогчид → SUBMITTED', async () => {
        const { app, customers } = await screenedReady();
        await screeningRow(app.id, customers[0].id);
        await apply(app.id);
        expect(await statusOf(app.id)).toBe('SUBMITTED');
      });
    });
  });
});
