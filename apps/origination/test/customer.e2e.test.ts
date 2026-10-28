import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type XypCitizen } from '@los/contracts';
import { SEED, blindIndex, decryptedField, isEncryptedField } from '@los/database';
import { DomainError } from '@los/nest-common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { XYP_LOOKUP } from '../src/modules/customer/xyp-lookup';
import { as } from './app';

const OTHER_ORG = '00000000-0000-4000-8000-0000000000ff';
const ADDRESS = { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'Хан-Уул хотхон, 12-р байр, 45 тоот' };
const REGISTER = 'УБ90010112';

/** Бүрэн, зөв иргэн (FR-2.3). */
const full = (over: Record<string, unknown> = {}) => ({
  registerNo: REGISTER, lastName: 'Болд', firstName: 'Бат-Эрдэнэ', gender: 'MALE', birthDate: '1990-01-01', phone: '+976 9911-2233', email: 'bat@example.mn', photoFileId: 'file-1',
  familySize: 4, activitySector: 'Худалдаа', maritalStatus: 'MARRIED', segment: 'Жижиг бизнес', education: 'Бакалавр', officialAddress: ADDRESS, residenceSameAsOfficial: true,
  employment: { organization: 'Тэнгэр ХХК', position: 'Менежер', phone: '70112233' }, contacts: [{ relation: 'SPOUSE', firstName: 'Сараа', phone: '88112233' }], ...over,
});

/** ХУР-ын fake (kyc-ийн mock-той ижил хэлбэр). Дуудлагын тоог тоолно. */
const xypCalls: string[] = [];
const fakeXyp = {
  async fetchCitizen(_ctx: unknown, registerNo: string): Promise<XypCitizen> {
    xypCalls.push(registerNo);
    if (registerNo.endsWith('00000000')) throw new DomainError('XYP_NOT_FOUND', 'ХУР-д олдсонгүй', 404);
    return {
      registerNo, customerType: 'INDIVIDUAL', lastName: 'Цэрэн', firstName: 'Сарнай', gender: 'FEMALE', birthDate: '1990-01-01', maritalStatus: 'DIVORCED', familySize: 3,
      activitySector: null, address: ADDRESS, fetchedAt: '2026-01-01T00:00:00.000Z',
    };
  },
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('origination · Модуль 1 · харилцагч (FR-2, FR-13.1)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(XYP_LOOKUP).useValue(fakeXyp).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    xypCalls.length = 0;
    await db.loanApplicationBorrower.deleteMany();
    await db.loanApplication.deleteMany();
    await db.customer.deleteMany(); // contacts cascade
    await db.blacklist.deleteMany();
    await db.auditLog.deleteMany({ where: { entity: 'CUSTOMER' } });
  });

  const create = (body: unknown, who: Parameters<typeof as>[0] = 'officerA') => http().post('/api/customers').set(as(who)).send(body as object);
  const blacklist = (registerNo: string, over: Record<string, unknown> = {}) => db.blacklist.create({
    data: { orgId: SEED.org.id, registerNoHash: blindIndex(registerNo), registerNoEncrypted: 'x', customerType: 'INDIVIDUAL', name: 'Хар', listType: 'INTERNAL', reasonCode: 'FRAUD', reasonText: 'Залилан', ...over },
  });

  describe('AC: регистр DB-д шифрлэгдсэн', () => {
    it('stores the register as ciphertext + blind index, never as plaintext in any column', async () => {
      const res = await create(full());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ registerNo: REGISTER, phone: '99112233', residenceSameAsOfficial: true, warnings: [], xypFetchedAt: null, branchId: SEED.branches.head.id });

      const [row] = await db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM origination.customer`;
      expect(isEncryptedField(String(row!.register_no_encrypted))).toBe(true);
      expect(decryptedField(String(row!.register_no_encrypted))).toBe(REGISTER);
      expect(row!.register_no_hash).toBe(blindIndex(REGISTER));
      expect(JSON.stringify(row)).not.toContain('90010112');
      // яаралтай холбоо барих хүний регистр мөн шифрлэгдэнэ
      const withReg = await create(full({ registerNo: 'УБ91010211', contacts: [{ relation: 'PARENT', firstName: 'Эх', phone: '88112233', registerNo: 'уб 70010101' }] }));
      const [c] = await db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM origination.customer_contact WHERE customer_id = ${withReg.body.id}`;
      expect(JSON.stringify(c)).not.toContain('70010101');
      expect(withReg.body.contacts[0].registerNo).toBe('УБ70010101');
    });

    it('audit log records who created it, without the register or photo', async () => {
      const res = await create(full());
      const audits = await db.auditLog.findMany({ where: { entity: 'CUSTOMER', entityId: res.body.id } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'CUSTOMER_CREATED', actorId: SEED.users.officerA.id });
      const json = JSON.stringify(audits[0]!.afterJson);
      expect(json).not.toContain('90010112');
      expect(json).not.toContain('file-1');
      expect(audits[0]!.afterJson).toMatchObject({ registerNo: '[redacted]', photoFileId: '[redacted]', firstName: 'Бат-Эрдэнэ' });
    });
  });

  describe('AC: регистр давхардахгүй (FR-2.2)', () => {
    it('409 CUSTOMER_EXISTS with the existing id, however the register is typed', async () => {
      const first = await create(full());
      const dup = await create(full({ registerNo: 'уб 90010112', firstName: 'Өөр' }));
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject({ code: 'CUSTOMER_EXISTS', details: { customerId: first.body.id } });
      expect(await db.customer.count()).toBe(1);
    });

    it('two simultaneous registrations of the same register: exactly one wins', async () => {
      const results = await Promise.all([create(full()), create(full()), create(full())]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await db.customer.count()).toBe(1);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'CUSTOMER_EXISTS')).toBe(true);
    });

    it('the same register in another organization is a different customer', async () => {
      await db.customer.create({ data: { orgId: OTHER_ORG, registerNoHash: blindIndex(REGISTER), registerNoEncrypted: 'x', customerType: 'INDIVIDUAL', firstName: 'Бусад' } });
      expect((await create(full())).status).toBe(201);
    });

    it('lookup tells the officer to open the existing customer instead of re-registering', async () => {
      const none = await http().get('/api/customers/lookup').query({ registerNo: 'уб90010112' }).set(as('officerA'));
      expect(none.body).toMatchObject({ registerNo: REGISTER, customerType: 'INDIVIDUAL', exists: false, customer: null, warnings: [] });
      const made = await create(full());
      const found = await http().get('/api/customers/lookup').query({ registerNo: ' уб 90010112 ' }).set(as('officerB')); // бусад салбарын ЗЭЗ ч олно
      expect(found.body).toMatchObject({ exists: true, customer: { id: made.body.id, registerNoMasked: 'УБ****0112', firstName: 'Бат-Эрдэнэ' } });
      expect((await http().get('/api/customers/lookup').query({ registerNo: 'bad' }).set(as('officerA'))).body.code).toBe('INVALID_REGISTER_NO');
      expect((await http().get('/api/customers/lookup').set(as('officerA'))).status).toBe(400);
    });
  });

  describe('AC: заавал талбар дутуу бол хадгалахгүй (FR-2.3)', () => {
    it('400 VALIDATION_FAILED listing every missing field; nothing is stored or audited', async () => {
      const { phone, email, photoFileId, birthDate, ...rest } = full();
      void [phone, email, photoFileId, birthDate];
      const res = await create({ ...rest, officialAddress: undefined });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect((res.body.details as { path: string }[]).map((d) => d.path).sort()).toEqual(['birthDate', 'email', 'officialAddress', 'phone', 'photoFileId']);
      expect(await db.customer.count()).toBe(0);
      expect(await db.auditLog.count({ where: { entity: 'CUSTOMER' } })).toBe(0);
    });

    it('rejects malformed values (register, phone, e-mail, future birth date) and unknown contact relations', async () => {
      for (const [bad, field] of [
        [{ phone: '123' }, 'phone'], [{ email: 'nope' }, 'email'], [{ birthDate: '2999-01-01' }, 'birthDate'],
        [{ contacts: [{ relation: 'BOSS', firstName: 'X', phone: '88112233' }] }, 'contacts.0.relation'],
      ] as const) {
        const res = await create(full(bad));
        expect(res.status, field).toBe(400);
        expect((res.body.details as { path: string }[]).map((d) => d.path)).toContain(field);
      }
      const badRegister = await create(full({ registerNo: 'AB123' }));
      expect(badRegister.status).toBe(400);
      expect(badRegister.body.code).toBe('INVALID_REGISTER_NO');
      expect(await db.customer.count()).toBe(0);
    });

    it('the "residence = official" box fills the second address; otherwise it is required', async () => {
      expect((await create(full({ residenceSameAsOfficial: false }))).body.details).toEqual([expect.objectContaining({ path: 'residenceAddress' })]);
      const other = { ...ADDRESS, khoroo: '9-р хороо' };
      const ok = await create(full({ residenceSameAsOfficial: false, residenceAddress: other }));
      expect(ok.body).toMatchObject({ residenceSameAsOfficial: false, residenceAddress: other, officialAddress: ADDRESS });
    });

    it('a company needs no personal fields', async () => {
      const res = await create({ registerNo: '5012345', firstName: 'Тэнгэр ХХК', phone: '77001122', email: 'info@tenger.mn', activitySector: 'Барилга', segment: 'ЖДБ', officialAddress: ADDRESS, residenceSameAsOfficial: true });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ customerType: 'LEGAL_ENTITY', registerNo: '5012345', gender: null, birthDate: null, employment: null });
    });
  });

  describe('AC: ХУР mock-оор 10+ талбар автоматаар бөглөгдөнө (FR-2.2)', () => {
    it('xyp-fetch pre-fills the form and lists only what is still missing', async () => {
      const res = await http().post('/api/customers/xyp-fetch').set(as('officerA')).send({ registerNo: 'уб 90010112' });
      expect(res.status).toBe(200);
      expect(res.body.prefilledFields.length).toBeGreaterThanOrEqual(10);
      expect(res.body).toMatchObject({
        registerNo: REGISTER, customerType: 'INDIVIDUAL', fetchedAt: '2026-01-01T00:00:00.000Z', existing: null, warnings: [],
        prefill: { lastName: 'Цэрэн', firstName: 'Сарнай', gender: 'FEMALE', birthDate: '1990-01-01', maritalStatus: 'DIVORCED', familySize: 3, officialAddress: ADDRESS },
      });
      expect([...res.body.missing].sort()).toEqual(['activitySector', 'education', 'email', 'employment', 'phone', 'photoFileId', 'residenceAddress', 'segment']);
      expect(await db.customer.count()).toBe(0); // хадгалахгүй
    });

    it('source=XYP saves the customer from the officer\'s missing fields plus XYP data; XYP overrides identity fields it owns', async () => {
      const res = await create({
        source: 'XYP', registerNo: REGISTER, lastName: 'Хуурамч', firstName: 'Хуурамч', gender: 'MALE', birthDate: '1980-05-05', maritalStatus: 'MARRIED',
        phone: '99112233', email: 'x@example.mn', photoFileId: 'file-9', activitySector: 'Худалдаа', segment: 'Жижиг бизнес', education: 'Бакалавр',
        residenceSameAsOfficial: true, employment: { organization: 'Тэнгэр ХХК', position: 'Менежер' },
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        lastName: 'Цэрэн', firstName: 'Сарнай', gender: 'FEMALE', birthDate: '1990-01-01', officialAddress: ADDRESS, // ХУР
        maritalStatus: 'MARRIED', familySize: 3, // ЗЭЗ-ийн бөглөснийг хадгалж, хоосныг ХУР нөхнө
        phone: '99112233', xypFetchedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(xypCalls).toEqual([REGISTER]);
    });

    it('source=XYP still refuses a customer whose officer-supplied fields are incomplete', async () => {
      const res = await create({ source: 'XYP', registerNo: REGISTER, phone: '99112233' });
      expect(res.status).toBe(400);
      expect((res.body.details as { path: string }[]).map((d) => d.path)).toContain('photoFileId');
      expect(await db.customer.count()).toBe(0);
    });

    it('a registered customer is returned instead of calling XYP again; creating with source=XYP does not call XYP for a duplicate', async () => {
      const made = await create(full());
      const res = await http().post('/api/customers/xyp-fetch').set(as('officerB')).send({ registerNo: REGISTER });
      expect(res.body).toMatchObject({ existing: { id: made.body.id }, fetchedAt: null, prefill: {}, missing: [] });
      expect((await create({ source: 'XYP', registerNo: REGISTER })).status).toBe(409);
      expect(xypCalls).toEqual([]);
    });

    it('XYP "not found" reaches the officer with its own code; a malformed register is 400', async () => {
      const nf = await http().post('/api/customers/xyp-fetch').set(as('officerA')).send({ registerNo: 'УБ00000000' });
      expect(nf.status).toBe(404);
      expect(nf.body.code).toBe('XYP_NOT_FOUND');
      expect((await http().post('/api/customers/xyp-fetch').set(as('officerA')).send({ registerNo: 'AB1' })).body.code).toBe('INVALID_REGISTER_NO');
    });
  });

  describe('AC: хар жагсаалтад байвал анхааруулга, гэхдээ хадгалж болно (BR-9)', () => {
    it('shows a red warning on lookup, xyp-fetch, create, card and list — and never blocks the save', async () => {
      await blacklist(REGISTER);
      await blacklist(REGISTER, { listType: 'AML', reasonCode: 'PEP_RISK', reasonText: null });
      await blacklist(REGISTER, { isActive: false, reasonCode: 'OLD' }); // идэвхгүй нь тооцогдохгүй
      const codes = (w: { reasonCode: string }[]) => w.map((x) => x.reasonCode).sort();

      const look = await http().get('/api/customers/lookup').query({ registerNo: REGISTER }).set(as('officerA'));
      expect(look.body.warnings[0]).toMatchObject({ code: 'BLACKLISTED', severity: 'WARNING', listType: expect.any(String) });
      expect(codes(look.body.warnings)).toEqual(['FRAUD', 'PEP_RISK']);
      expect(codes((await http().post('/api/customers/xyp-fetch').set(as('officerA')).send({ registerNo: REGISTER })).body.warnings)).toEqual(['FRAUD', 'PEP_RISK']);
      expect(codes((await http().get('/api/blacklist/check').query({ registerNo: REGISTER }).set(as('officerA'))).body.warnings)).toEqual(['FRAUD', 'PEP_RISK']);

      const res = await create(full());
      expect(res.status).toBe(201); // хориг биш
      expect(codes(res.body.warnings)).toEqual(['FRAUD', 'PEP_RISK']);
      expect(codes((await http().get(`/api/customers/${res.body.id}`).set(as('officerA'))).body.warnings)).toEqual(['FRAUD', 'PEP_RISK']);
      const list = await http().get('/api/customers').set(as('officerA'));
      expect(list.body.items[0]).toMatchObject({ id: res.body.id, blacklisted: true });
    });

    it('a clean customer has no warnings, and other organizations\' blacklist rows do not leak', async () => {
      await blacklist(REGISTER, { orgId: OTHER_ORG });
      const res = await create(full());
      expect(res.body.warnings).toEqual([]);
      expect((await http().get('/api/customers').set(as('officerA'))).body.items[0].blacklisted).toBe(false);
      const check = await http().get('/api/blacklist/check').query({ registerNo: REGISTER }).set(as('officerA'));
      expect(check.body).toEqual({ registerNo: REGISTER, blacklisted: false, warnings: [] });
    });

    it('every role that reads customers can check the blacklist', async () => {
      for (const who of ['officerA', 'manager', 'approver', 'admin'] as const) {
        expect((await http().get('/api/blacklist/check').query({ registerNo: REGISTER }).set(as(who))).status, who).toBe(200);
      }
      expect((await http().get('/api/blacklist/check').query({ registerNo: 'x' }).set(as('officerA'))).body.code).toBe('INVALID_REGISTER_NO');
      // давхар/задгай query параметр 500 биш 400 (zod)
      for (const q of ['registerNo=a&registerNo=b', 'registerNo[x]=1', 'registerNo[]=a', '']) {
        const res = await http().get(`/api/blacklist/check?${q}`).set(as('officerA'));
        expect(res.status, q).toBe(400);
        expect(res.body.code, q).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('карт, засвар, холбоо барих, KYC (FR-2.4, FR-2.5, FR-2.6)', () => {
    it('update changes only the given fields, re-validates, audits the diff, and cannot touch the register', async () => {
      const made = (await create(full())).body;
      const res = await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ phone: '88001122', isPep: true, isRelatedParty: true, registerNo: 'УБ00000001', customerType: 'LEGAL_ENTITY' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ registerNo: REGISTER, customerType: 'INDIVIDUAL', phone: '88001122', isPep: true, isRelatedParty: true, firstName: 'Бат-Эрдэнэ', contacts: [expect.objectContaining({ firstName: 'Сараа' })] });

      const audit = await db.auditLog.findFirstOrThrow({ where: { entity: 'CUSTOMER', entityId: made.id, action: 'CUSTOMER_UPDATED' } });
      expect(audit.beforeJson).toEqual({ phone: '99112233', isPep: false, isRelatedParty: false });
      expect(audit.afterJson).toEqual({ phone: '88001122', isPep: true, isRelatedParty: true });

      expect((await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ email: 'bad' })).status).toBe(400);
      expect((await http().get(`/api/customers/${made.id}`).set(as('officerA'))).body.phone).toBe('88001122');
      // өөрчлөлтгүй хадгалбал аудит нэмэгдэхгүй
      await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ phone: '88001122' });
      expect(await db.auditLog.count({ where: { entity: 'CUSTOMER', entityId: made.id, action: 'CUSTOMER_UPDATED' } })).toBe(1);
    });

    it('addresses: changing the official one drags a "same" residence along; giving a residence unticks the box', async () => {
      const made = (await create(full())).body;
      const moved = { ...ADDRESS, district: 'Сүхбаатар' };
      const a = await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ officialAddress: moved });
      expect(a.body).toMatchObject({ officialAddress: moved, residenceAddress: moved, residenceSameAsOfficial: true });
      const home = { ...ADDRESS, khoroo: '9-р хороо' };
      const b = await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ residenceAddress: home });
      expect(b.body).toMatchObject({ officialAddress: moved, residenceAddress: home, residenceSameAsOfficial: false });
    });

    it('unticking "same address" without giving a residence is refused; the audit trail shows the effective residence', async () => {
      const made = (await create(full())).body;
      const res = await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ residenceSameAsOfficial: false });
      expect(res.status).toBe(400);
      expect((res.body.details as { path: string }[]).map((d) => d.path)).toEqual(['residenceAddress']);
      const home = { ...ADDRESS, khoroo: '9-р хороо' };
      await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ residenceAddress: home });
      const audit = await db.auditLog.findFirstOrThrow({ where: { entity: 'CUSTOMER', entityId: made.id, action: 'CUSTOMER_UPDATED' } });
      expect(audit.beforeJson).toEqual({ residenceAddress: ADDRESS });
      expect(audit.afterJson).toEqual({ residenceAddress: home });
    });

    it('a blank value on PUT means "clear": refused for required fields, clears optional ones, omitted fields stay', async () => {
      const made = (await create(full())).body;
      for (const f of ['phone', 'email', 'lastName', 'segment']) {
        const res = await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ [f]: '  ' });
        expect(res.status, f).toBe(400);
        expect((res.body.details as { path: string }[]).map((d) => d.path), f).toEqual([f]);
      }
      expect((await http().get(`/api/customers/${made.id}`).set(as('officerA'))).body).toMatchObject({ phone: '99112233', email: 'bat@example.mn', lastName: 'Болд' });

      const company = (await create({ registerNo: '5012345', firstName: 'Тэнгэр ХХК', lastName: 'Хуучин', phone: '77001122', email: 'info@tenger.mn', activitySector: 'Барилга', segment: 'ЖДБ', officialAddress: ADDRESS, residenceSameAsOfficial: true })).body;
      const cleared = await http().put(`/api/customers/${company.id}`).set(as('officerA')).send({ lastName: '', education: '' });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ lastName: null, education: null, phone: '77001122' });
    });

    it('concurrent edits of one customer are serialized: no lost update, no duplicated contacts', async () => {
      const made = (await create(full())).body;
      const put = (b: object) => http().put(`/api/customers/${made.id}`).set(as('officerA')).send(b);
      const rs = await Promise.all([put({ phone: '88001122' }), put({ email: 'new@example.mn' }), put({ isPep: true }), put({ familySize: 6 })]);
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect((await http().get(`/api/customers/${made.id}`).set(as('officerA'))).body).toMatchObject({ phone: '88001122', email: 'new@example.mn', isPep: true, familySize: 6 });

      const contacts = [{ relation: 'PARENT', firstName: 'Эх', phone: '88112233' }];
      const again = await Promise.all([put({ contacts }), put({ contacts }), put({ contacts })]);
      expect(again.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(await db.customerContact.count({ where: { customerId: made.id } })).toBe(1);
    });

    it('emergency contacts are replaced as a whole list', async () => {
      const made = (await create(full())).body;
      const two = [{ relation: 'PARENT', firstName: 'Эх', phone: '88112233' }, { relation: 'FRIEND', firstName: 'Найз', lastName: 'Бат', phone: '99001122', employment: 'Банк' }];
      const a = await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ contacts: two });
      expect(a.body.contacts.map((c: { firstName: string }) => c.firstName).sort()).toEqual(['Найз', 'Эх']);
      expect((await http().put(`/api/customers/${made.id}`).set(as('officerA')).send({ contacts: [] })).body.contacts).toEqual([]);
      expect(await db.customerContact.count({ where: { customerId: made.id } })).toBe(0);
    });

    it('list: exact search by register, partial by name or phone, masked register, paging, org isolation', async () => {
      const ids: string[] = [];
      for (const [reg, name] of [['УБ90010112', 'Бат-Эрдэнэ'], ['УБ91010211', 'Сарнай'], ['УБ92010312', 'Батбаяр']] as const) {
        ids.push((await create(full({ registerNo: reg, firstName: name, phone: `9900${ids.length}000` }))).body.id);
      }
      await db.customer.create({ data: { orgId: OTHER_ORG, registerNoHash: blindIndex('УБ93010413'), registerNoEncrypted: 'x', customerType: 'INDIVIDUAL', firstName: 'Батхүү' } });

      const get = (q: Record<string, string | number>) => http().get('/api/customers').query(q).set(as('officerA'));
      expect((await get({})).body).toMatchObject({ total: 3, page: 1, pageSize: 20 });
      expect((await get({ registerNo: 'уб 91010211' })).body.items.map((i: { id: string }) => i.id)).toEqual([ids[1]]);
      expect((await get({ q: 'УБ92010312' })).body.items.map((i: { id: string }) => i.id)).toEqual([ids[2]]);
      expect((await get({ q: 'Бат' })).body.total).toBe(2); // Бат-Эрдэнэ, Батбаяр (зөвхөн энэ байгууллага)
      expect((await get({ q: '99001' })).body.items.map((i: { id: string }) => i.id)).toEqual([ids[1]]);
      const paged = await get({ pageSize: 2, page: 2 });
      expect(paged.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(paged.body.items).toHaveLength(1);
      expect((await get({})).body.items[0].registerNoMasked).toMatch(/^УБ\*{4}\d{4}$/);
      expect(JSON.stringify((await get({})).body)).not.toContain('90010112'); // жагсаалтад бүтэн регистр гарахгүй
      expect((await get({ pageSize: 1000 })).status).toBe(400);
    });

    it('card: previous loans follow the application visibility rules (NFR-3)', async () => {
      const made = (await create(full())).body;
      const mk = async (appNo: string, officer: keyof typeof SEED.users, branch: keyof typeof SEED.branches, extra: Record<string, unknown> = {}) => {
        const a = await db.loanApplication.create({ data: { appNo, orgId: SEED.org.id, branchId: SEED.branches[branch].id, officerId: SEED.users[officer].id, ...extra } });
        await db.loanApplicationBorrower.create({ data: { orgId: SEED.org.id, applicationId: a.id, customerId: made.id, role: 'PRIMARY', isPrimary: true } });
      };
      await mk('A-1', 'officerA', 'head', { status: 'ACTIVE', amount: '12000000', contractNo: 'B10026010101' });
      await mk('B-1', 'officerB', 'bayanzurkh');
      const refs = async (who: Parameters<typeof as>[0]) => ((await http().get(`/api/customers/${made.id}`).set(as(who))).body.applications as { appNo: string }[]).map((a) => a.appNo).sort();
      expect(await refs('officerA')).toEqual(['A-1']);
      expect(await refs('officerB')).toEqual(['B-1']);
      expect(await refs('manager')).toEqual(['A-1']); // Төв салбар
      expect(await refs('approver')).toEqual(['A-1', 'B-1']);
      expect(await refs('admin')).toEqual(['A-1', 'B-1']);
      const a1 = (await http().get(`/api/customers/${made.id}`).set(as('officerA'))).body.applications[0];
      expect(a1).toMatchObject({ appNo: 'A-1', status: 'ACTIVE', role: 'PRIMARY', amount: '12000000', currency: 'MNT', contractNo: 'B10026010101' });
    });

    it('404 for an unknown or other-organization customer, 400 for a non-uuid id', async () => {
      const foreign = await db.customer.create({ data: { orgId: OTHER_ORG, registerNoHash: blindIndex('УБ93010413'), registerNoEncrypted: 'x', customerType: 'INDIVIDUAL', firstName: 'Бусад' } });
      expect((await http().get(`/api/customers/${foreign.id}`).set(as('officerA'))).status).toBe(404);
      expect((await http().put(`/api/customers/${foreign.id}`).set(as('officerA')).send({ phone: '99112233' })).status).toBe(404);
      expect((await http().get('/api/customers/00000000-0000-4000-8000-0000000000aa').set(as('officerA'))).status).toBe(404);
      expect((await http().get('/api/customers/not-a-uuid').set(as('officerA'))).status).toBe(400);
    });
  });

  describe('эрх (RBAC)', () => {
    it('only the loan officer writes; manager, approver and admin read; anonymous is 401', async () => {
      const made = (await create(full())).body;
      for (const who of ['manager', 'approver', 'admin'] as const) {
        expect((await create(full({ registerNo: 'УБ95010512' }), who)).status, `${who} create`).toBe(403);
        expect((await http().put(`/api/customers/${made.id}`).set(as(who)).send({ phone: '99001122' })).status, `${who} update`).toBe(403);
        expect((await http().post('/api/customers/xyp-fetch').set(as(who)).send({ registerNo: REGISTER })).status, `${who} xyp`).toBe(403);
        expect((await http().get(`/api/customers/${made.id}`).set(as(who))).status, `${who} read`).toBe(200);
        expect((await http().get('/api/customers').set(as(who))).status, `${who} list`).toBe(200);
      }
      expect(await db.customer.count()).toBe(1);
      expect((await http().get('/api/customers')).status).toBe(401);
      expect((await http().post('/api/customers').send(full())).status).toBe(401);
    });
  });
});
