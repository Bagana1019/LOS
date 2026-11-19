// M6 follow-up · эзэмшигч бус салбарын харилцагчийн засвар maker-checker-ээр (эзэмшигчийн шийдвэр 2026-11-18, хувилбар A).
// Maker = өөр салбарын ЗЭЗ; checker = эзэмшигч салбарын захирал; PII шифрлэгдэж хадгалагдана; хуучирсан хүсэлт → FAILED.
import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SEED } from '@los/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { XYP_LOOKUP } from '../src/modules/customer/xyp-lookup';
import { as } from './app';

const ADDRESS = { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'Хан-Уул хотхон, 12-р байр, 45 тоот' };
const full = () => ({
  registerNo: 'УБ90010112', lastName: 'Болд', clanName: 'Боржигон', firstName: 'Бат-Эрдэнэ', gender: 'MALE', birthDate: '1990-01-01', phone: '99112233', email: 'bat@example.mn', photoFileId: 'file-1',
  familySize: 4, activitySector: 'Худалдаа', maritalStatus: 'MARRIED', segment: 'Жижиг бизнес', education: 'Бакалавр', officialAddress: ADDRESS, residenceSameAsOfficial: true,
  employment: { organization: 'Тэнгэр ХХК', position: 'Менежер', phone: '70112233' }, contacts: [{ relation: 'SPOUSE', firstName: 'Сараа', phone: '88112233' }],
});
const NEW_PHONE = '88445566';
const NEW_EMAIL = 'shine.email@example.mn';
const REASON = 'Харилцагч Баянзүрх салбарт ирж утсаа шинэчлүүлэв';
const BAYANZURKH_MANAGER = '00000000-0000-4000-8000-0000000003bb';

describe.skipIf(!process.env.TEST_DATABASE_URL)('origination · харилцагчийн засварын хүсэлт (maker-checker CUSTOMER/UPDATE)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(XYP_LOOKUP).useValue({ fetchCitizen: () => { throw new Error('not used'); } }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await db.loanApplicationBorrower.deleteMany();
    await db.loanApplication.deleteMany();
    await db.customer.deleteMany();
    await db.makerCheckerPolicy.deleteMany({ where: { targetType: 'CUSTOMER' } });
  });

  type Who = Parameters<typeof as>[0];
  const managerOf = (branch: keyof typeof SEED.branches, userId: string) => ({ ...as('manager'), 'x-user-id': userId, 'x-branch-id': SEED.branches[branch].id });
  const owned = async () => (await http().post('/api/customers').set(as('officerA')).send(full())).body as { id: string; updatedAt: string }; // head branch
  const submit = (id: string, changes: object, headers: Record<string, string> = as('officerB'), reason = REASON) =>
    http().post(`/api/customers/${id}/edit-requests`).set(headers).send({ changes, reason });
  const approve = (rid: string, headers: Record<string, string> = as('manager')) => http().post(`/api/maker-checker/requests/${rid}/approve`).set(headers).send({});
  const customer = (id: string) => db.customer.findUniqueOrThrow({ where: { id } });
  const inboxHas = async (headers: Record<string, string>, rid: string) =>
    ((await http().get('/api/maker-checker/requests').query({ scope: 'inbox', pageSize: 100 }).set(headers)).body.items as { id: string }[]).some((r) => r.id === rid);

  describe('direct PUT hint', () => {
    it('403 CUSTOMER_BRANCH_FORBIDDEN now tells the client where to submit an edit request (status unchanged)', async () => {
      const c = await owned();
      const res = await http().put(`/api/customers/${c.id}`).set(as('officerB')).send({ phone: NEW_PHONE });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'CUSTOMER_BRANCH_FORBIDDEN',
        details: { ownerBranchId: SEED.branches.head.id, editRequest: { method: 'POST', path: `/api/origination/customers/${c.id}/edit-requests` } },
      });
    });
  });

  describe('happy path: other-branch officer → owning-branch manager', () => {
    it('submit is 202 PENDING scoped to the OWNING branch; the customer does not change yet', async () => {
      const c = await owned();
      const res = await submit(c.id, { phone: NEW_PHONE });
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        outcome: 'PENDING',
        request: { status: 'PENDING', targetType: 'CUSTOMER', action: 'UPDATE', targetId: c.id, branchId: SEED.branches.head.id, requiredCheckerRoles: ['BRANCH_MANAGER'], makerId: SEED.users.officerB.id },
      });
      expect((await customer(c.id)).phone).toBe('99112233');
    });

    it('approve applies the change in the checker transaction, with the normal CUSTOMER_UPDATED audit', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE, email: NEW_EMAIL, clanName: '' })).body.request.id;
      expect(await inboxHas(as('manager'), rid)).toBe(true);
      const res = await approve(rid);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'APPLIED', checkerId: SEED.users.manager.id });
      const after = await customer(c.id);
      expect(after).toMatchObject({ phone: NEW_PHONE, email: NEW_EMAIL, clanName: null, branchId: SEED.branches.head.id, updatedBy: SEED.users.manager.id });
      const audits = await db.auditLog.findMany({ where: { entity: 'CUSTOMER', entityId: c.id, action: 'CUSTOMER_UPDATED' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorId: SEED.users.manager.id });
      expect(await db.auditLog.count({ where: { entity: 'CHANGE_REQUEST', entityId: rid, action: 'CHANGE_REQUEST_APPLIED' } })).toBe(1);
    });

    it('contacts in the request replace the list on approval', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { contacts: [{ relation: 'PARENT', firstName: 'Эх', phone: '88112244', registerNo: 'УБ60010112' }] })).body.request.id;
      expect((await approve(rid)).status).toBe(200);
      const contacts = await db.customerContact.findMany({ where: { customerId: c.id } });
      expect(contacts).toEqual([expect.objectContaining({ relation: 'PARENT', firstName: 'Эх' })]);
    });
  });

  describe('M5: official address through the change request', () => {
    it('an official-address edit is applied on approval and stored encrypted in the request (no silent drop)', async () => {
      const c = await owned();
      const moved = { province: 'Дархан-Уул', district: 'Дархан', khoroo: '3-р баг', detail: 'Нууц-байр 77' };
      const sub = await submit(c.id, { officialAddress: moved, residenceSameAsOfficial: false, residenceAddress: ADDRESS });
      expect(sub.status).toBe(202);
      const rid = sub.body.request.id;
      const row = await db.changeRequest.findUniqueOrThrow({ where: { id: rid } });
      expect(JSON.stringify([row.payload, row.before])).not.toContain('Нууц-байр 77');
      expect(row.payload).toMatchObject({ summary: { fields: ['officialAddress', 'residenceAddress', 'residenceSameAsOfficial'] } });
      expect((await approve(rid)).status).toBe(200);
      const after = await customer(c.id);
      expect(after.officialAddressJson).toEqual(moved);
      expect(after.residenceAddressJson).toEqual(ADDRESS);
    });

    it('unknown or read-only fields in `changes` are refused with 400, not dropped', async () => {
      const c = await owned();
      const unknown = await submit(c.id, { phone: NEW_PHONE, registeredAddress: ADDRESS });
      expect(unknown.status).toBe(400);
      expect(unknown.body).toMatchObject({ code: 'UNKNOWN_FIELD', details: { fields: ['registeredAddress'] } });
      const ro = await submit(c.id, { registerNo: 'УБ00000001' });
      expect(ro.status).toBe(400);
      expect(ro.body).toMatchObject({ code: 'READONLY_FIELD', details: { fields: ['registerNo'] } });
      expect(await db.changeRequest.count({ where: { targetId: c.id } })).toBe(0);
    });
  });

  describe('PII: nothing readable in the immutable rows, history, outbox or audit', () => {
    it('stores payload and before encrypted; only changed field names are readable', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE, email: NEW_EMAIL, contacts: [{ relation: 'PARENT', firstName: 'Эх', phone: '88112244', registerNo: 'УБ60010112' }] })).body.request.id;
      await approve(rid);
      const row = await db.changeRequest.findUniqueOrThrow({ where: { id: rid } });
      const stored = JSON.stringify([row.payload, row.before, row.targetId]);
      for (const pii of [NEW_PHONE, NEW_EMAIL, '99112233', 'bat@example.mn', 'УБ60010112', '88112244']) expect(stored, pii).not.toContain(pii);
      expect(row.payload).toMatchObject({ summary: { fields: ['contacts', 'email', 'phone'] } });
      const history = JSON.stringify(await db.changeRequestHistory.findMany({ where: { changeRequestId: rid } }));
      const outbox = JSON.stringify(await db.outbox.findMany({ where: { payload: { path: ['changeRequestId'], equals: rid } } }));
      const audit = JSON.stringify(await db.auditLog.findMany({ where: { entityId: rid } }));
      for (const blob of [history, outbox, audit]) for (const pii of [NEW_PHONE, NEW_EMAIL, 'УБ60010112']) expect(blob).not.toContain(pii);
    });

    it('the detail view decrypts for the checker; the inbox list stays sealed', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE })).body.request.id;
      const detail = (await http().get(`/api/maker-checker/requests/${rid}`).set(as('manager'))).body;
      expect(detail.payload).toEqual({ changes: { phone: NEW_PHONE }, cleared: [] });
      expect(detail.before).toEqual({ phone: '99112233' });
      const list = (await http().get('/api/maker-checker/requests').query({ scope: 'inbox', pageSize: 100 }).set(as('manager'))).body;
      expect(JSON.stringify(list)).not.toContain(NEW_PHONE);
    });
  });

  describe('who may check', () => {
    it('only the owning branch manager: other-branch manager, approver, compliance do not see it; admin sees but cannot decide', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE })).body.request.id;
      const bzManager = managerOf('bayanzurkh', BAYANZURKH_MANAGER);
      expect(await inboxHas(bzManager, rid)).toBe(false);
      expect((await approve(rid, bzManager)).status).toBe(404);
      for (const who of ['approver', 'compliance'] as const) expect((await approve(rid, as(who))).status, who).toBe(404);
      const admin = await approve(rid, as('admin'));
      expect(admin.status).toBe(403);
      expect(admin.body.code).toBe('CHECKER_ROLE_FORBIDDEN');
      expect((await customer(c.id)).phone).toBe('99112233');
    });

    it('the maker cannot approve their own request (and has no checker role anyway)', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE })).body.request.id;
      const res = await approve(rid, as('officerB'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    });

    it('even if the policy is widened to APPROVER, apply still requires the owning branch manager; the request stays PENDING', async () => {
      const c = await owned();
      await db.makerCheckerPolicy.create({ data: { orgId: SEED.org.id, targetType: 'CUSTOMER', action: 'UPDATE', enabled: true, checkerRoles: ['BRANCH_MANAGER', 'APPROVER'], expiresInHours: 72, createdBy: 'test', updatedBy: 'test' } });
      const rid = (await submit(c.id, { phone: NEW_PHONE })).body.request.id;
      const res = await approve(rid, as('approver'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CHECKER_BRANCH_FORBIDDEN');
      expect((await db.changeRequest.findUniqueOrThrow({ where: { id: rid } })).status).toBe('PENDING');
      expect((await approve(rid)).status).toBe(200);
    });

    it('the policy is locked: four eyes cannot be switched off for customer edits', async () => {
      const policies = (await http().get('/api/maker-checker/policies').set(as('admin'))).body as { targetType: string; action: string; locked: boolean; enabled: boolean }[];
      expect(policies.find((p) => p.targetType === 'CUSTOMER' && p.action === 'UPDATE')).toMatchObject({ locked: true, enabled: true });
    });
  });

  describe('who may submit, and what', () => {
    it('the owning branch edits directly, so its own request is refused (422) — one path per case', async () => {
      const c = await owned();
      const res = await submit(c.id, { phone: NEW_PHONE }, as('officerA'));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PAYLOAD_INVALID');
    });

    it('a legacy customer without an owning branch is edited directly by anyone, so a request is refused (422)', async () => {
      const c = await owned();
      await db.customer.update({ where: { id: c.id }, data: { branchId: null } });
      expect((await submit(c.id, { phone: NEW_PHONE })).status).toBe(422);
    });

    it('an officer without a branch cannot submit (403, fail closed)', async () => {
      const c = await owned();
      const { 'x-branch-id': _omit, ...noBranch } = as('officerB') as Record<string, string>;
      expect((await submit(c.id, { phone: NEW_PHONE }, noBranch)).status).toBe(403);
    });

    it('roles without customer:write are refused (403); anonymous is 401', async () => {
      const c = await owned();
      for (const who of ['manager', 'approver', 'admin', 'compliance'] as Who[]) expect((await submit(c.id, { phone: NEW_PHONE }, as(who))).status, who).toBe(403);
      expect((await http().post(`/api/customers/${c.id}/edit-requests`).send({ changes: { phone: NEW_PHONE }, reason: REASON })).status).toBe(401);
    });

    it('404 for an unknown customer; 400 for a non-uuid id', async () => {
      expect((await submit('00000000-0000-4000-8000-0000000000aa', { phone: NEW_PHONE })).status).toBe(404);
      expect((await submit('not-a-uuid', { phone: NEW_PHONE })).status).toBe(400);
    });

    it('validates with the PUT rules at submission: malformed values 400, a required field cleared 422, empty change 422, no reason 400', async () => {
      const c = await owned();
      expect((await submit(c.id, { phone: 'abc' })).status).toBe(400);
      expect((await submit(c.id, { email: '' })).status).toBe(422);
      expect((await submit(c.id, {})).status).toBe(422);
      expect((await submit(c.id, { phone: NEW_PHONE }, as('officerB'), '')).status).toBe(400);
      expect(await db.changeRequest.count({ where: { targetId: c.id } })).toBe(0);
    });

    it('one pending request per customer (409)', async () => {
      const c = await owned();
      expect((await submit(c.id, { phone: NEW_PHONE })).status).toBe(202);
      const again = await submit(c.id, { email: NEW_EMAIL });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('TARGET_HAS_PENDING_CHANGE');
    });

    it('the generic maker-checker endpoint enforces the same rules and encryption', async () => {
      const c = await owned();
      const generic = (headers: Record<string, string>) => http().post('/api/maker-checker/requests').set(headers)
        .send({ targetType: 'CUSTOMER', action: 'UPDATE', targetId: c.id, payload: { changes: { phone: NEW_PHONE } }, reason: REASON });
      expect((await generic(as('officerA'))).status).toBe(422);
      const ok = await generic(as('officerB'));
      expect(ok.status).toBe(202);
      expect(JSON.stringify((await db.changeRequest.findUniqueOrThrow({ where: { id: ok.body.request.id } })).payload)).not.toContain(NEW_PHONE);
    });
  });

  describe('stale requests are rejected, never applied on top', () => {
    it('owner edits the customer after submission → approve is 409 STALE_TARGET, request FAILED, owner\'s edit kept', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE })).body.request.id;
      expect((await http().put(`/api/customers/${c.id}`).set(as('officerA')).send({ email: NEW_EMAIL })).status).toBe(200);
      const res = await approve(rid);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STALE_TARGET');
      expect((await db.changeRequest.findUniqueOrThrow({ where: { id: rid } })).status).toBe('FAILED');
      expect(await customer(c.id)).toMatchObject({ phone: '99112233', email: NEW_EMAIL });
    });

    it('owning branch changed after submission (review LOW) → 409 STALE_TARGET, FAILED instead of a stuck PENDING', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE })).body.request.id;
      await db.$executeRaw`UPDATE origination.customer SET branch_id = NULL WHERE id = ${c.id}`; // keeps updated_at
      const res = await approve(rid);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STALE_TARGET');
      expect((await db.changeRequest.findUniqueOrThrow({ where: { id: rid } })).status).toBe('FAILED');
      expect(await customer(c.id)).toMatchObject({ phone: '99112233' });
    });

    it('customer removed after submission → 409 STALE_TARGET, FAILED', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE })).body.request.id;
      await db.customer.delete({ where: { id: c.id } });
      expect((await approve(rid)).body.code).toBe('STALE_TARGET');
      expect((await db.changeRequest.findUniqueOrThrow({ where: { id: rid } })).status).toBe('FAILED');
    });

    it('re-validates the merged result at apply: no longer valid → 409 STALE_TARGET (not 500)', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE })).body.request.id;
      await db.$executeRaw`UPDATE origination.customer SET email = NULL WHERE id = ${c.id}`; // out-of-band change that keeps updated_at
      const res = await approve(rid);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STALE_TARGET');
    });

    it('approve racing a direct owner edit: serialized, never a silent lost update', async () => {
      const c = await owned();
      const rid = (await submit(c.id, { phone: NEW_PHONE })).body.request.id;
      const [ap, put] = await Promise.all([approve(rid), http().put(`/api/customers/${c.id}`).set(as('officerA')).send({ email: NEW_EMAIL })]);
      expect(put.status).toBe(200);
      const after = await customer(c.id);
      expect(after.email).toBe(NEW_EMAIL); // the owner's edit always survives
      if (ap.status === 200) expect(after.phone).toBe(NEW_PHONE); // approval first, owner's edit on top of it
      else { expect(ap.body.code).toBe('STALE_TARGET'); expect(after.phone).toBe('99112233'); }
    });
  });
});
