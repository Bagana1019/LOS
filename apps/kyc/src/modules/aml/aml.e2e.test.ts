import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BadRequestException, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '.prisma/client-kyc';
import { AmlPolicy, DomainEvent, type AmlPolicy as AmlPolicyType, type BlacklistEntryChanged } from '@los/contracts';
import { hashRegisterNo, maskRegisterNoStrict, normalizeRegisterNo } from '@los/database';
import { FATF_CLIENT, type FatfSnapshot } from '../../integrations/fatf/fatf.client';
import { UN_SC_CLIENT, type UnSanctionsSnapshot } from '../../integrations/un-sc/un-sc.client';
import { AML_CLOCK, AML_IDS, AML_POLICY_PROVIDER, AML_REPOSITORY, PII_CIPHER, ScreeningRaceError, type AmlRepository } from './aml.ports';
import { AmlModule } from './aml.module';
import { PrismaModule } from '../../prisma.service';
import { AML_PRISMA } from './aml.prisma';
import { toResult } from './aml.service';
import { BlacklistProjectionService } from './blacklist-projection.service';
import { mapDbInputError } from './db-error.interceptor';
import { InMemoryAmlRepository } from './repository/in-memory-aml.repository';
import { truncateKycTables } from './test-db';

const REGISTER = 'ХИ87654321';
const MATCHED_REGISTER = 'ЖЖ99999999';
const OTHER_REGISTER = 'ЖЖ11111111';
const HOUR = 3_600_000;
const MINUTE = 60_000;

type UnEntry = UnSanctionsSnapshot['entries'][number];
const unEntry = (refId: string, name: string): UnEntry => ({ refId, type: 'INDIVIDUAL', names: [{ value: name, quality: 'PRIMARY' }], datesOfBirth: [], nationalities: [], identifiers: [], programme: 'TEST', listedOn: '2020-01-01' });
const unSnapshot = (version = 'un-v1', extra: UnEntry[] = []): UnSanctionsSnapshot => ({
  version,
  publishedAt: '2026-10-01T00:00:00.000Z',
  entries: [
    unEntry('T-NAME', 'Bat Erdene Ganbold'),
    { ...unEntry('T-ID', 'Somebody Else Entirely'), nationalities: ['MN'], identifiers: [{ type: 'National Identification Number', value: MATCHED_REGISTER, country: 'MN' }] },
    ...extra,
  ],
});
const fatfSnapshot: FatfSnapshot = {
  version: 'fatf-v1',
  publishedAt: '2026-10-01T00:00:00.000Z',
  entries: [
    { countryCode: 'KP', countryName: 'Fixtureland North', category: 'CALL_FOR_ACTION', listedOn: '2020-02-21' },
    { countryCode: 'ZZ', countryName: 'Fixtureland Grey', category: 'INCREASED_MONITORING', listedOn: '2024-06-28' },
  ],
};

const headers = (user: string | null, roles: string[] = [], org: string | null = 'org-1') => ({
  ...(user ? { 'x-user-id': user } : {}),
  ...(org ? { 'x-org-id': org } : {}),
  'x-roles': roles.join(','),
  'x-correlation-id': 'corr-1',
});
const subject = (over: Record<string, unknown> = {}) => ({ subjectType: 'INDIVIDUAL', registerNo: REGISTER, lastName: 'Тест', firstName: 'Хэрэглэгч', ...over });
const screenBody = (over: Record<string, unknown> = {}, subjectOver: Record<string, unknown> = {}) => ({
  orgId: 'org-1', customerId: 'cust-1', applicationId: 'app-1', subject: subject(subjectOver), ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// TEST_DATABASE_URL (migrate хийгдсэн kyc schema — test/global-setup.ts) өгөгдсөн үед бодит PrismaAmlRepository-оор, үгүй бол in-memory-оор ажиллана.
const useDb = Boolean(process.env.TEST_DATABASE_URL);

describe(`AML module (HTTP, ${useDb ? 'Postgres' : 'in-memory'} persistence)`, () => {
  let app: INestApplication;
  let repo: AmlRepository;
  let memory: InMemoryAmlRepository;
  let now: Date;
  let un: UnSanctionsSnapshot;
  let unFails: boolean;
  let fatf: FatfSnapshot;
  let policy: AmlPolicyType;
  let orgPolicies: Record<string, AmlPolicyType>;
  let uuidCounter: number;
  const unClient = { fetchSnapshot: vi.fn(async () => { if (unFails) throw new Error('upstream down'); return structuredClone(un); }) };
  const policyFor = vi.fn(async (orgId: string) => orgPolicies[orgId] ?? policy);

  async function boot(): Promise<void> {
    let builder = Test.createTestingModule({ imports: useDb ? [PrismaModule, AmlModule] : [AmlModule] });
    if (!useDb) builder = builder.overrideProvider(AML_PRISMA).useValue({}).overrideProvider(AML_REPOSITORY).useValue(memory);
    const moduleRef = await builder
      .overrideProvider(UN_SC_CLIENT).useValue(unClient)
      .overrideProvider(FATF_CLIENT).useValue({ fetchSnapshot: async () => structuredClone(fatf) })
      .overrideProvider(PII_CIPHER).useValue({ encrypt: (p: string) => `enc:${p}`, decrypt: (c: string) => c.replace(/^enc:/, '') })
      .overrideProvider(AML_CLOCK).useValue({ now: () => new Date(now) })
      .overrideProvider(AML_IDS).useValue({ uuid: () => `00000000-0000-4000-8000-${(++uuidCounter).toString(16).padStart(12, '0')}` })
      .overrideProvider(AML_POLICY_PROVIDER).useValue({ getPolicy: policyFor })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    repo = app.get<AmlRepository>(AML_REPOSITORY);
    if (useDb) await truncateKycTables(app.get<PrismaClient>(AML_PRISMA)); // DATABASE_URL-ийн нэрэнд 'test' байхгүй бол татгалзана
  }

  beforeEach(async () => {
    vi.stubEnv('DEFAULT_ORG_ID', '');
    vi.stubEnv('AML_LIST_REFRESH_MINUTES', '60');
    memory = new InMemoryAmlRepository();
    now = new Date('2026-10-28T09:00:00.000Z');
    un = unSnapshot();
    fatf = fatfSnapshot;
    unFails = false;
    policy = AmlPolicy.parse({});
    orgPolicies = {};
    uuidCounter = 0;
    unClient.fetchSnapshot.mockClear();
    policyFor.mockClear();
    await boot();
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  const http = () => request(app.getHttpServer());
  const screen = (body: unknown, h = headers('officer-1', ['OFFICER'])) => http().post('/api/aml/screen').set(h).send(body as object);
  const events = async (type?: string): Promise<DomainEvent[]> => {
    const all = useDb
      ? (await app.get<PrismaClient>(AML_PRISMA).outbox.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((r) => r.payload as unknown as DomainEvent)
      : memory.getOutbox();
    return type ? all.filter((e) => e.type === type) : all;
  };

  describe('access', () => {
    it('rejects calls without X-User-Id (401) or organisation (400)', async () => {
      await screen(screenBody(), headers(null)).expect(401);
      await screen(screenBody(), headers('officer-1', [], null)).expect(400);
    });
    it('falls back to DEFAULT_ORG_ID when X-Org-Id is absent', async () => {
      vi.stubEnv('DEFAULT_ORG_ID', 'org-1');
      await screen(screenBody(), headers('officer-1', [], null)).expect(201);
    });
    it('restricts the review queue, list admin and rescreen to the right roles', async () => {
      const officer = headers('officer-1', ['OFFICER']);
      await http().get('/api/aml/hits').set(officer).expect(403);
      await http().get('/api/aml/lists').set(officer).expect(403);
      await http().post('/api/aml/lists/refresh').set(headers('approver-1', ['APPROVER'])).send({}).expect(403);
      await http().post('/api/aml/rescreen').set(headers('approver-1', ['APPROVER'])).send({}).expect(403);
      await http().get('/api/aml/hits').set(headers('approver-1', ['APPROVER'])).expect(200);
    });
    it('ignores unknown role names in X-Roles', async () => {
      await http().get('/api/aml/hits').set(headers('u', ['SUPERUSER', 'ROOT'])).expect(403);
    });
    it('refuses to screen on behalf of another organisation', async () => {
      await screen(screenBody({ orgId: 'org-2' })).expect(403);
    });
  });

  describe('POST /aml/screen', () => {
    it('returns CLEAR for an unlisted customer, masks the register and records the event', async () => {
      const res = await screen(screenBody()).expect(201);
      expect(res.body).toMatchObject({
        status: 'CLEAR', blocking: false, riskScore: 0, riskLevel: 'LOW', hits: [], customerId: 'cust-1', applicationId: 'app-1',
        trigger: 'APPLICATION', registerNoMasked: maskRegisterNoStrict(REGISTER), subjectName: 'Тест Хэрэглэгч', screenedBy: 'officer-1',
        listVersions: { UN_SC: 'un-v1', FATF: 'fatf-v1', INTERNAL_BLACKLIST: 'live' },
      });
      expect(JSON.stringify(res.body)).not.toContain(REGISTER);
      expect(await events()).toHaveLength(1);
      expect((await events())[0]).toMatchObject({ type: 'AmlScreeningCompleted', screeningId: res.body.id, actorId: 'officer-1', correlationId: 'corr-1', orgId: 'org-1', status: 'CLEAR', blocking: false, hitCount: 0 });
      const stored = await repo.findScreening('org-1', res.body.id);
      expect(stored?.registerNoEncrypted).toBe(`enc:${REGISTER}`);
      expect(stored?.registerNoHash).toBe(hashRegisterNo(REGISTER));
    });

    it('blocks on a sanctions name match and rates the customer HIGH risk', async () => {
      const res = await screen(screenBody({}, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' })).expect(201);
      expect(res.body).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true, riskLevel: 'HIGH', riskScore: 60 });
      expect(res.body.hits).toHaveLength(1);
      expect(res.body.hits[0]).toMatchObject({ list: 'UN_SC', matchType: 'NAME_EXACT', severity: 'BLOCKING', status: 'OPEN', entryRef: 'T-NAME', listVersion: 'un-v1', reviewedBy: null });
      expect(res.body.riskFactors).toEqual([{ code: 'SANCTIONS_POSSIBLE', weight: 60 }]);
      expect((await events())[0]).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true, riskLevel: 'HIGH', hitCount: 1 });
    });

    it('matches a sanctioned identifier regardless of the name and never exposes the register', async () => {
      const res = await screen(screenBody({}, { registerNo: MATCHED_REGISTER })).expect(201);
      expect(res.body.hits[0]).toMatchObject({ matchType: 'REGISTER_EXACT', entryRef: 'T-ID', matchedValue: maskRegisterNoStrict(MATCHED_REGISTER) });
      expect(JSON.stringify(res.body)).not.toContain(MATCHED_REGISTER);
    });

    it('does not block when the policy says sanctions are warnings only', async () => {
      policy = AmlPolicy.parse({ blockOnSanctionsHit: false });
      const res = await screen(screenBody({}, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' })).expect(201);
      expect(res.body).toMatchObject({ status: 'WARNING', blocking: false });
      expect(res.body.hits[0].severity).toBe('WARNING');
    });

    it('only warns for a FATF jurisdiction (EDD) and raises the risk score', async () => {
      const res = await screen(screenBody({}, { countries: ['kp'] })).expect(201);
      expect(res.body).toMatchObject({ status: 'WARNING', blocking: false, riskScore: 40, riskLevel: 'MEDIUM' });
      expect(res.body.hits[0]).toMatchObject({ list: 'FATF', matchType: 'COUNTRY', entryRef: 'KP', details: { category: 'CALL_FOR_ACTION' } });
    });

    it('treats an empty country list as Mongolia: it hits a listed MN, but not when other countries are named', async () => {
      // Анхдагч 'MN' жинхэнээр ажиллаж байгааг батлахын тулд FATF snapshot-д MN-ийг оруулна.
      fatf = { ...fatfSnapshot, entries: [...fatfSnapshot.entries, { countryCode: 'MN', countryName: 'Fixtureland Home', category: 'INCREASED_MONITORING', listedOn: '2024-01-01' }] };
      const empty = await screen(screenBody({}, { countries: [] })).expect(201);
      expect(empty.body.hits).toHaveLength(1);
      expect(empty.body.hits[0]).toMatchObject({ list: 'FATF', matchType: 'COUNTRY', entryRef: 'MN', details: { category: 'INCREASED_MONITORING' } });
      expect(empty.body).toMatchObject({ status: 'WARNING', riskScore: 15 });
      const omitted = await screen(screenBody({ customerId: 'cust-2' })).expect(201); // countries талбар огт байхгүй
      expect(omitted.body.hits.map((h: { entryRef: string }) => h.entryRef)).toEqual(['MN']);
      const named = await screen(screenBody({ customerId: 'cust-3' }, { countries: ['KZ'] })).expect(201);
      expect(named.body.hits).toEqual([]);
    });

    it('rates a subject in both FATF categories by the stricter one (call for action), with a hit for each country', async () => {
      const res = await screen(screenBody({}, { countries: ['KP', 'ZZ'] })).expect(201);
      expect(res.body.hits.map((h: { entryRef: string; details: { category: string } }) => [h.entryRef, h.details.category])).toEqual([
        ['KP', 'CALL_FOR_ACTION'], ['ZZ', 'INCREASED_MONITORING'],
      ]);
      expect(res.body).toMatchObject({ status: 'WARNING', blocking: false, riskScore: 40, riskLevel: 'MEDIUM' });
      expect(res.body.riskFactors).toEqual([{ code: 'FATF_CALL_FOR_ACTION', weight: 40 }]);
    });

    it('adds PEP and related-party weight to the risk score', async () => {
      expect((await screen(screenBody({}, { isPep: true })).expect(201)).body).toMatchObject({ riskScore: 25, riskLevel: 'LOW' });
      expect((await screen(screenBody({}, { isPep: true, isRelatedParty: true })).expect(201)).body).toMatchObject({ riskScore: 35, riskLevel: 'MEDIUM' });
    });

    it('always screens every list: a client-supplied `lists` subset is ignored', async () => {
      for (const lists of [['FATF'], ['INTERNAL_BLACKLIST'], ['UN_SC']]) {
        const res = await screen(screenBody({ lists, customerId: `cust-${lists[0]}` }, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' })).expect(201);
        expect(res.body.hits).toHaveLength(1);
        expect(res.body.hits[0]).toMatchObject({ list: 'UN_SC', status: 'OPEN' });
        expect(res.body.listVersions).toEqual({ UN_SC: 'un-v1', FATF: 'fatf-v1', INTERNAL_BLACKLIST: 'live' });
      }
      expect(unClient.fetchSnapshot).toHaveBeenCalled();
    });

    it('never persists or publishes the plain register number (only the masked, hashed and encrypted forms)', async () => {
      const res = await screen(screenBody({}, { registerNo: MATCHED_REGISTER, lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' })).expect(201);
      expect(res.body.hits).toHaveLength(2); // регистрийн тохирол + нэрийн тохирол: matchedValue дахь регистр зөвхөн mask
      const plain = [MATCHED_REGISTER, normalizeRegisterNo(MATCHED_REGISTER), MATCHED_REGISTER.toLowerCase()];

      const { registerNoEncrypted, ...persisted } = (await repo.findScreening('org-1', res.body.id))!;
      expect(registerNoEncrypted).toBe(`enc:${normalizeRegisterNo(MATCHED_REGISTER)}`); // шифрлэгдсэн хэлбэр л зөвшөөрөгдөнө
      const dumps = [JSON.stringify(persisted), JSON.stringify(await events())];
      if (useDb) {
        // Бодит хүснэгтүүдийн (шифрлэсэн багана хасна) түүхий агуулга.
        const rows = await app.get<PrismaClient>(AML_PRISMA).$queryRawUnsafe<{ j: string }[]>(
          `SELECT (to_jsonb(s) - 'register_no_encrypted')::text AS j FROM kyc.aml_check s
           UNION ALL SELECT to_jsonb(h)::text FROM kyc.aml_hit h UNION ALL SELECT to_jsonb(o)::text FROM kyc.outbox o`,
        );
        expect(rows.length).toBeGreaterThanOrEqual(4);
        dumps.push(...rows.map((r) => r.j));
      }
      for (const dump of dumps) for (const value of plain) expect(dump).not.toContain(value);
      expect(persisted.registerNoMasked).toBe(maskRegisterNoStrict(MATCHED_REGISTER));
      expect(persisted.registerNoHash).toBe(hashRegisterNo(MATCHED_REGISTER));
    });

    it('validates the body with the shared zod schema', async () => {
      const bad = await screen({ orgId: 'org-1', customerId: 'c', subject: { subjectType: 'INDIVIDUAL', registerNo: '', firstName: 'X', birthDate: '1980/01/01', countries: ['MNG'] } }).expect(400);
      expect(bad.body.message).toBe('Validation failed');
      expect([...new Set(bad.body.issues.map((i: { path: string[] }) => i.path.join('.')))].sort()).toEqual(['subject.birthDate', 'subject.countries.0', 'subject.registerNo']);
      expect(await events()).toHaveLength(0);
    });
  });

  describe('internal blacklist (BR-9)', () => {
    const event = (over: Partial<BlacklistEntryChanged> = {}): BlacklistEntryChanged => ({
      type: 'BlacklistEntryChanged', eventId: '11111111-1111-4111-8111-111111111111', occurredAt: '2026-10-28T08:00:00.000Z', version: 1,
      orgId: 'org-1', actorId: 'admin-1', correlationId: 'c', entryId: 'bl-1', registerNoHash: hashRegisterNo(REGISTER), customerType: 'INDIVIDUAL',
      name: 'Тест Хэрэглэгч', listType: 'DELINQUENT', reasonCode: 'OVERDUE_90', isActive: true, changedAt: '2026-10-28T08:00:00.000Z', ...over,
    });
    const projection = () => app.get(BlacklistProjectionService);

    it('warns but never blocks, and the projection stays idempotent and ordered', async () => {
      expect(await projection().handle(event())).toBe('APPLIED');
      expect(await projection().handle(event())).toBe('DUPLICATE');
      const res = await screen(screenBody()).expect(201);
      expect(res.body).toMatchObject({ status: 'WARNING', blocking: false, riskScore: 20, riskLevel: 'LOW' });
      expect(res.body.hits[0]).toMatchObject({ list: 'INTERNAL_BLACKLIST', matchType: 'REGISTER_EXACT', severity: 'WARNING', entryRef: 'bl-1', details: { listType: 'DELINQUENT', reasonCode: 'OVERDUE_90' } });

      // Хуучин (эрт) өөрчлөлт орж ирэхэд STALE; дараа нь идэвхгүй болгосон event хар жагсаалтаас гаргана.
      expect(await projection().handle(event({ eventId: '22222222-2222-4222-8222-222222222222', isActive: false, changedAt: '2026-10-28T07:00:00.000Z' }))).toBe('STALE');
      expect(await projection().handle(event({ eventId: '33333333-3333-4333-8333-333333333333', isActive: false, changedAt: '2026-10-28T08:30:00.000Z' }))).toBe('APPLIED');
      expect((await screen(screenBody()).expect(201)).body.status).toBe('CLEAR');
    });

    it('only matches rows of the caller organisation, in both directions', async () => {
      await projection().handle(event({ orgId: 'org-2' }));
      expect((await screen(screenBody()).expect(201)).body.status).toBe('CLEAR');
      // org-1-ийн бүртгэл org-2-ийн шалгалтад харагдахгүй, org-1-ийн шалгалтад харагдана.
      await projection().handle(event({ eventId: '44444444-4444-4444-8444-444444444444', entryId: 'bl-org1', orgId: 'org-1' }));
      const org2 = await screen(screenBody({ orgId: 'org-2', customerId: 'cust-2' }), headers('officer-9', ['OFFICER'], 'org-2')).expect(201);
      expect(org2.body).toMatchObject({ orgId: 'org-2', status: 'WARNING' });
      expect(org2.body.hits.map((h: { entryRef: string }) => h.entryRef)).toEqual(['bl-1']);
      const org1 = await screen(screenBody({ customerId: 'cust-3' })).expect(201);
      expect(org1.body.hits.map((h: { entryRef: string }) => h.entryRef)).toEqual(['bl-org1']);
    });

    it('can block when the organisation policy says so', async () => {
      policy = AmlPolicy.parse({ blockOnInternalBlacklist: true });
      await projection().handle(event());
      expect((await screen(screenBody()).expect(201)).body).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });
    });

    it('rejects malformed events', async () => {
      await expect(projection().handle({ type: 'BlacklistEntryChanged' })).rejects.toThrow();
    });
  });

  describe('hit review', () => {
    const matchBody = () => screenBody({}, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' });
    const admin = headers('admin-1', ['ADMIN']);
    const review = (hitId: string, body: unknown, h = admin) => http().post(`/api/aml/hits/${hitId}/review`).set(h).send(body as object);
    const completedEvent = (screeningId: string, over: Record<string, unknown> = {}) => ({
      type: 'AmlScreeningCompleted', eventId: expect.any(String), occurredAt: '2026-10-28T09:00:00.000Z', version: 1, orgId: 'org-1', actorId: 'officer-1',
      correlationId: 'corr-1', screeningId, customerId: 'cust-1', applicationId: 'app-1', status: 'REVIEW_REQUIRED', blocking: true, riskScore: 60, riskLevel: 'HIGH', hitCount: 1, ...over,
    });
    const reviewedEvent = (screeningId: string, hitId: string, over: Record<string, unknown> = {}) => ({
      type: 'AmlHitReviewed', eventId: expect.any(String), occurredAt: '2026-10-28T09:00:00.000Z', version: 1, orgId: 'org-1', actorId: 'admin-1',
      correlationId: 'corr-1', screeningId, hitId, customerId: 'cust-1', applicationId: 'app-1', list: 'UN_SC', decision: 'FALSE_POSITIVE',
      screeningStatus: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, riskLevel: 'LOW', ...over,
    });

    it('clears a false positive, recomputes risk and records AmlHitReviewed', async () => {
      const screened = (await screen(matchBody()).expect(201)).body;
      const res = await review(screened.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Different date of birth confirmed' }).expect(200);
      expect(res.body).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, riskLevel: 'LOW', riskFactors: [] });
      expect(res.body.hits[0]).toMatchObject({ status: 'FALSE_POSITIVE', reviewedBy: 'admin-1', reviewComment: 'Different date of birth confirmed', reviewedAt: '2026-10-28T09:00:00.000Z' });
      const latest = (await http().get('/api/aml/customers/cust-1/latest').set(admin).expect(200)).body;
      expect(latest).toMatchObject({ id: screened.id, status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0 });

      // Хариу нь хадгалагдсан төлөвийг тусгана (локал бодсон объект биш): repository-оос дахин уншиж тулгана.
      const stored = (await repo.findScreening('org-1', screened.id))!;
      expect(stored.hits[0]).toEqual({ ...screened.hits[0], status: 'FALSE_POSITIVE', reviewedBy: 'admin-1', reviewedAt: '2026-10-28T09:00:00.000Z', reviewComment: 'Different date of birth confirmed' });
      expect(stored).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, riskLevel: 'LOW', riskFactors: [] });
      expect(res.body).toEqual(JSON.parse(JSON.stringify(toResult(stored))));

      // Origination эдгээр event-ээр хаалтаа шийддэг: бүх талбар, applicationId/customerId/blocking-тай нь бүрэн.
      expect(await events('AmlScreeningCompleted')).toEqual([completedEvent(screened.id)]);
      expect(await events('AmlHitReviewed')).toEqual([reviewedEvent(screened.id, screened.hits[0].id)]);
      for (const e of await events()) expect(DomainEvent.parse(e)).toEqual(e);
    });

    it('confirms a match: CONFIRMED_MATCH, blocking, risk 100, persisted and published', async () => {
      const screened = (await screen(matchBody()).expect(201)).body;
      const res = await review(screened.hits[0].id, { decision: 'CONFIRMED', comment: 'Identity documents match the listed party' }, headers('approver-1', ['APPROVER'])).expect(200);
      expect(res.body).toMatchObject({ status: 'CONFIRMED_MATCH', blocking: true, riskScore: 100, riskLevel: 'HIGH' });
      expect(res.body.riskFactors).toEqual([{ code: 'SANCTIONS_CONFIRMED', weight: 100 }]);

      const stored = (await repo.findScreening('org-1', screened.id))!;
      expect(stored.hits[0]).toEqual({
        ...screened.hits[0], status: 'CONFIRMED', reviewedBy: 'approver-1', reviewedAt: '2026-10-28T09:00:00.000Z', reviewComment: 'Identity documents match the listed party',
      });
      expect(stored).toMatchObject({ status: 'CONFIRMED_MATCH', blocking: true, riskScore: 100, riskLevel: 'HIGH', riskFactors: [{ code: 'SANCTIONS_CONFIRMED', weight: 100 }] });
      expect(res.body).toEqual(JSON.parse(JSON.stringify(toResult(stored))));
      expect(await events('AmlScreeningCompleted')).toEqual([completedEvent(screened.id)]);
      // Баталгаажсан хоригийн дараа blocking:false event гарвал дараагийн систем хэрэглэгчийг чөлөөлчихнө — blocking:true байх ёстой.
      expect(await events('AmlHitReviewed')).toEqual([reviewedEvent(screened.id, screened.hits[0].id, {
        actorId: 'approver-1', decision: 'CONFIRMED', screeningStatus: 'CONFIRMED_MATCH', blocking: true, riskScore: 100, riskLevel: 'HIGH',
      })]);
    });

    it('freezes the decision: a second review gets 409', async () => {
      const screened = (await screen(matchBody()).expect(201)).body;
      await review(screened.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }).expect(200);
      await review(screened.hits[0].id, { decision: 'CONFIRMED', comment: 'Changed my mind later' }, headers('admin-2', ['ADMIN'])).expect(409);
      expect(await events('AmlHitReviewed')).toHaveLength(1);
    });

    it('requires a different person than the one who ran the screening, for either decision', async () => {
      const screened = (await screen(matchBody(), headers('admin-1', ['ADMIN'])).expect(201)).body;
      await review(screened.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }).expect(403);
      // Эхлүүлсэн хүн CONFIRMED-ээр ч шийдвэрлэж болохгүй (код санаатайгаар ямар ч шийдвэрийг хаадаг).
      await review(screened.hits[0].id, { decision: 'CONFIRMED', comment: 'Confirmed by the same person' }).expect(403);
      expect((await repo.findScreening('org-1', screened.id))?.hits[0]).toMatchObject({ status: 'OPEN', reviewedBy: null });
      expect(await events('AmlHitReviewed')).toHaveLength(0);
      // Өөр хүн CONFIRMED-ээр шийдвэрлэж чадна.
      await review(screened.hits[0].id, { decision: 'CONFIRMED', comment: 'Confirmed by a second person' }, headers('approver-1', ['APPROVER'])).expect(200);
      // Бодлого сулруулсан org-д эхлүүлсэн хүн өөрөө шийдвэрлэж болно.
      policy = AmlPolicy.parse({ requireSeparateReviewer: false });
      const other = (await screen(screenBody({ customerId: 'cust-2' }, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' }), headers('admin-1', ['ADMIN'])).expect(201)).body;
      await review(other.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }).expect(200);
    });

    it('rejects short comments, wrong roles, unknown hits and other organisations', async () => {
      const screened = (await screen(matchBody()).expect(201)).body;
      const id = screened.hits[0].id;
      await review(id, { decision: 'FALSE_POSITIVE', comment: 'ok' }).expect(400);
      await review(id, { decision: 'MAYBE', comment: 'Not a valid decision' }).expect(400);
      await review(id, { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }, headers('officer-2', ['OFFICER'])).expect(403);
      await review('00000000-0000-4000-8000-0000000fffff', { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }).expect(404);
      await review(id, { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }, headers('admin-9', ['ADMIN'], 'org-2')).expect(404);
    });

    it('keeps a warning-level hit as WARNING after a blocking hit is cleared', async () => {
      const screened = (await screen(screenBody({}, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', countries: ['KP'] })).expect(201)).body;
      expect(screened.status).toBe('REVIEW_REQUIRED');
      const unHit = screened.hits.find((h: { list: string }) => h.list === 'UN_SC');
      const res = await review(unHit.id, { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }).expect(200);
      expect(res.body).toMatchObject({ status: 'WARNING', blocking: false, riskScore: 40, riskLevel: 'MEDIUM' });
    });

    it('keeps the PEP weight after a sanctions hit is reviewed, in the response, the stored screening and the event', async () => {
      const screened = (await screen(screenBody({}, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', isPep: true })).expect(201)).body;
      expect(screened).toMatchObject({ riskScore: 85, riskLevel: 'HIGH' }); // PEP 25 + хоригийн боломжит тохирол 60
      const cleared = await review(screened.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Different person entirely' }).expect(200);
      expect(cleared.body).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 25, riskLevel: 'LOW', riskFactors: [{ code: 'PEP', weight: 25 }] });
      expect(await repo.findScreening('org-1', screened.id)).toMatchObject({ riskScore: 25, riskFactors: [{ code: 'PEP', weight: 25 }] });
      expect(await events('AmlHitReviewed')).toEqual([reviewedEvent(screened.id, screened.hits[0].id, { riskScore: 25, riskLevel: 'LOW' })]);

      const second = (await screen(screenBody({ customerId: 'cust-2' }, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', isPep: true })).expect(201)).body;
      const confirmed = await review(second.hits[0].id, { decision: 'CONFIRMED', comment: 'Identity documents match' }, headers('approver-1', ['APPROVER'])).expect(200);
      expect(confirmed.body).toMatchObject({ status: 'CONFIRMED_MATCH', riskScore: 100, riskLevel: 'HIGH' }); // 25 + 100 → 100-аар хязгаарлагдана
      expect(confirmed.body.riskFactors).toEqual([{ code: 'PEP', weight: 25 }, { code: 'SANCTIONS_CONFIRMED', weight: 100 }]);
    });

    it('resolves two hits of one screening reviewed at the same time: cleared, with consistent responses and events', async () => {
      const screened = (await screen(screenBody({}, { registerNo: MATCHED_REGISTER, lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' })).expect(201)).body;
      expect(screened.hits).toHaveLength(2);
      const body = { decision: 'FALSE_POSITIVE', comment: 'Different person entirely' };
      const [a, b] = await Promise.all([
        review(screened.hits[0].id, body, headers('admin-1', ['ADMIN'])),
        review(screened.hits[1].id, body, headers('approver-1', ['APPROVER'])),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);

      const latest = (await http().get('/api/aml/customers/cust-1/latest').set(admin).expect(200)).body;
      expect(latest).toMatchObject({ id: screened.id, status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0 });
      expect(latest.hits.map((h: { status: string }) => h.status)).toEqual(['FALSE_POSITIVE', 'FALSE_POSITIVE']);
      // Сүүлд шийдвэрлэсэн хүний хариу хоёр шийдвэрийг агуулна; хэн ч "blocking" үлдээсэнгүй.
      expect([a.body, b.body].filter((r) => r.status === 'CLEARED_AFTER_REVIEW' && r.blocking === false)).toHaveLength(1);
      expect([a.body, b.body].filter((r) => r.status === 'REVIEW_REQUIRED' && r.blocking === true)).toHaveLength(1);
      const reviewedEvents = (await events('AmlHitReviewed')) as Extract<DomainEvent, { type: 'AmlHitReviewed' }>[];
      expect(reviewedEvents.map((e) => [e.screeningStatus, e.blocking]).sort()).toEqual([['CLEARED_AFTER_REVIEW', false], ['REVIEW_REQUIRED', true]]);
    });

    it('lists open hits for the review queue with paging and filters', async () => {
      await screen(matchBody());
      await screen(screenBody({ customerId: 'cust-2' }, { countries: ['KP'] }));
      const open = (await http().get('/api/aml/hits?status=OPEN&limit=1').set(admin).expect(200)).body;
      expect(open.total).toBe(2);
      expect(open.items).toHaveLength(1);
      expect(open.items[0]).toMatchObject({ screening: { customerId: expect.any(String), registerNoMasked: maskRegisterNoStrict(REGISTER) }, hit: { status: 'OPEN' } });
      const un = (await http().get('/api/aml/hits?list=UN_SC').set(admin).expect(200)).body;
      expect(un.total).toBe(1);
      await http().get('/api/aml/hits?limit=1000').set(admin).expect(400);
    });

    it('serves screenings by id within the organisation only', async () => {
      const screened = (await screen(matchBody()).expect(201)).body;
      await http().get(`/api/aml/screenings/${screened.id}`).set(headers('officer-1', ['OFFICER'])).expect(200);
      await http().get(`/api/aml/screenings/${screened.id}`).set(headers('officer-1', ['OFFICER'], 'org-2')).expect(404);
      await http().get('/api/aml/customers/nobody/latest').set(admin).expect(404);
    });
  });

  describe('a blocking screening cannot be superseded by a different identity', () => {
    const matchBody = (over: Record<string, unknown> = {}, subjectOver: Record<string, unknown> = {}) => screenBody(over, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', ...subjectOver });
    const admin = headers('admin-1', ['ADMIN']);
    const review = (hitId: string, body: unknown, h = admin) => http().post(`/api/aml/hits/${hitId}/review`).set(h).send(body as object);

    it('answers 409 and stores nothing when the register differs from a REVIEW_REQUIRED screening; the same identity may be re-screened', async () => {
      const first = (await screen(matchBody()).expect(201)).body;
      expect(first.status).toBe('REVIEW_REQUIRED');
      const before = (await events()).length;

      const swapped = await screen(screenBody({}, { registerNo: OTHER_REGISTER, lastName: 'Тест', firstName: 'Хэрэглэгч' })).expect(409);
      expect(swapped.body.message).toMatch(/resolve the open hits first/);
      expect(await events()).toHaveLength(before);
      expect((await http().get('/api/aml/customers/cust-1/latest').set(admin).expect(200)).body).toMatchObject({ id: first.id, status: 'REVIEW_REQUIRED', blocking: true });

      const again = await screen(matchBody()).expect(201); // ижил субъект
      expect(again.body.status).toBe('REVIEW_REQUIRED');
      // Өөр харилцагч (customerId) нөлөөлөхгүй.
      await screen(screenBody({ customerId: 'cust-2' }, { registerNo: OTHER_REGISTER })).expect(201);
    });

    it('also answers 409 after a CONFIRMED_MATCH, and keeps it when the same customer is screened again with a lists subset', async () => {
      const first = (await screen(matchBody()).expect(201)).body;
      await review(first.hits[0].id, { decision: 'CONFIRMED', comment: 'Identity documents match' }, headers('approver-1', ['APPROVER'])).expect(200);
      await screen(screenBody({ lists: ['FATF'] }, { registerNo: OTHER_REGISTER })).expect(409);
      await screen(screenBody({}, { registerNo: OTHER_REGISTER, countries: ['KP'] })).expect(409);

      const again = (await screen(matchBody({ lists: ['FATF'] })).expect(201)).body;
      expect(again).toMatchObject({ status: 'CONFIRMED_MATCH', blocking: true, riskScore: 100 });
      expect(again.hits[0]).toMatchObject({ status: 'CONFIRMED', reviewedBy: 'approver-1' });
      expect((await http().get('/api/aml/customers/cust-1/latest').set(admin).expect(200)).body).toMatchObject({ id: again.id, status: 'CONFIRMED_MATCH', blocking: true });
    });

    it('lets a different identity through once the latest screening is not blocking, without inheriting the old decisions', async () => {
      const first = (await screen(matchBody()).expect(201)).body;
      await review(first.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Different person entirely' }).expect(200);
      const res = await screen(matchBody({}, { registerNo: OTHER_REGISTER })).expect(201);
      // Өөр регистр → өөр субъект: өмнөх FALSE_POSITIVE шийдвэр дамжихгүй.
      expect(res.body).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });
      expect(res.body.hits[0]).toMatchObject({ status: 'OPEN', reviewedBy: null });
      expect(res.body.hits[0].details).not.toHaveProperty('carriedOverFrom');
    });

    it.each([
      ['a different name', { lastName: 'Иванов', firstName: 'Иван' }],
      ['a different first name only', { firstName: 'Бат' }],
      ['a different birth date', { birthDate: '1990-01-01' }],
      ['a different subject type', { subjectType: 'LEGAL_ENTITY' }],
      ['different countries', { countries: ['KZ'] }],
      ['a different alias list', { aliases: ['Another Name'] }],
    ])('answers 409 for the same register with %s while the latest screening is blocking, and stores nothing', async (_what, change) => {
      const first = (await screen(matchBody()).expect(201)).body;
      const before = (await events()).length;
      const res = await screen(matchBody({}, change)).expect(409);
      expect(res.body.message).toMatch(/resolve the open hits first/);
      expect(await events()).toHaveLength(before);
      expect((await http().get('/api/aml/customers/cust-1/latest').set(admin).expect(200)).body).toMatchObject({ id: first.id, status: 'REVIEW_REQUIRED', blocking: true });
      const queue = (await http().get('/api/aml/hits?status=OPEN').set(admin).expect(200)).body;
      expect(queue.items.map((i: { hit: { id: string } }) => i.hit.id)).toEqual([first.hits[0].id]);
    });

    it('lets the same identity through when only text formatting, alias order, flags, application or trigger differ', async () => {
      const first = (await screen(matchBody({}, { aliases: ['Bat Erdene', 'B. Ganbold'], countries: ['MN', 'KZ'] })).expect(201)).body;
      const again = await screen(matchBody({ applicationId: 'app-2', trigger: 'MANUAL' }, {
        lastName: 'ГАНБОЛД', firstName: '  бат-эрдэнэ ', aliases: ['b.  ganbold', 'Bat Erdene'], countries: ['kz', 'mn'], isPep: true, isRelatedParty: true,
      })).expect(201);
      expect(again.body).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true, applicationId: 'app-2', trigger: 'MANUAL' });
      expect(again.body.id).not.toBe(first.id);
    });

    it('keeps a CONFIRMED_MATCH through a rejected name swap: screening the true name again carries the confirmation', async () => {
      const first = (await screen(matchBody()).expect(201)).body;
      await review(first.hits[0].id, { decision: 'CONFIRMED', comment: 'Identity documents match' }, headers('approver-1', ['APPROVER'])).expect(200);
      await screen(matchBody({}, { lastName: 'Иванов', firstName: 'Иван' })).expect(409);
      const again = (await screen(matchBody()).expect(201)).body;
      expect(again).toMatchObject({ status: 'CONFIRMED_MATCH', blocking: true });
      expect(again.hits[0]).toMatchObject({ status: 'CONFIRMED', reviewedBy: 'approver-1', details: { carriedOverFrom: first.hits[0].id } });
      await review(again.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Trying to reverse it' }, headers('admin-2', ['ADMIN'])).expect(409);
    });
  });

  describe('concurrent screenings of one customer', () => {
    const admin = headers('admin-1', ['ADMIN']);
    const sanctioned = (over: Record<string, unknown> = {}) => screenBody(over, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' });
    const clean = (over: Record<string, unknown> = {}) => screenBody(over, { registerNo: OTHER_REGISTER });
    const latest = async (customerId: string) => (await http().get(`/api/aml/customers/${customerId}/latest`).set(admin).expect(200)).body;

    /** Хадгалалт бүрийн оролдлого (амжилттай / ScreeningRaceError) ба хүлээж байсан өмнөх id-г commit-ийн дарааллаар бүртгэнэ. */
    function trackSaves() {
      const saves: { id: string; expected: string | null | undefined; ok: boolean }[] = [];
      const original = repo.saveScreening.bind(repo);
      vi.spyOn(repo, 'saveScreening').mockImplementation(async (screening, event, options) => {
        try {
          await original(screening, event, options);
          saves.push({ id: screening.id, expected: options?.expectedPreviousId, ok: true });
        } catch (e) {
          saves.push({ id: screening.id, expected: options?.expectedPreviousId, ok: false });
          throw e;
        }
      });
      return saves;
    }
    /** Эхний `count` дуудлага бүгд "өмнөх screening"-ээ уншсаны дараа л үргэлжилнэ: хэн нь ч хадгалахаас өмнө бүгд ижил төлвийг харна. */
    function interleaveFirstReads(count: number) {
      const original = repo.findLatestForCustomer.bind(repo);
      const gate = deferred<void>();
      let arrived = 0;
      vi.spyOn(repo, 'findLatestForCustomer').mockImplementation(async (orgId, customerId) => {
        const result = await original(orgId, customerId);
        if (arrived < count) {
          arrived += 1;
          if (arrived === count) gate.resolve();
          await gate.promise;
        }
        return result;
      });
    }
    /** commit-ийн дараалал бүр өмнөх амжилттай commit-ийн id-г хүлээсэн байх ёстой (хоёр "өмнөх нь адилхан" commit байхгүй). */
    const expectChain = (saves: { id: string; expected: string | null | undefined; ok: boolean }[], base: string | null = null) => {
      const committed = saves.filter((x) => x.ok);
      committed.forEach((x, i) => expect(x.expected).toBe(i === 0 ? base : committed[i - 1]?.id));
      return committed;
    };

    it('forced interleaving: both screens read "no previous screening" before either saves; the loser is recomputed against the winner or refused with 409, never stored on a stale base', async () => {
      const saves = trackSaves();
      interleaveFirstReads(2);
      const customerId = 'cust-race';
      const [matching, notMatching] = await Promise.all([screen(sanctioned({ customerId })), screen(clean({ customerId }))]);
      expect(matching.status).toBe(201);
      expect([201, 409]).toContain(notMatching.status);
      expect(saves.some((x) => !x.ok)).toBe(true); // уралдаан үнэхээр үүсч, илрүүлэгдсэн
      expect(expectChain(saves)).toHaveLength(notMatching.status === 201 ? 2 : 1);
      // Блоклосон шалгалт ҮРГЭЛЖ сүүлийнх: цэвэр нь түүнийг дарж чадахгүй.
      expect(await latest(customerId)).toMatchObject({ id: matching.body.id, status: 'REVIEW_REQUIRED', blocking: true });
      if (notMatching.status === 409) expect(notMatching.body.message).toMatch(/resolve the open hits first/);
    });

    it('without any forced interleaving the clean screen never ends up on top of the sanctioned one', async () => {
      for (let i = 0; i < 6; i++) {
        const customerId = `cust-race-${i}`;
        const [matching, notMatching] = await Promise.all([screen(sanctioned({ customerId })), screen(clean({ customerId }))]);
        expect(matching.status).toBe(201);
        expect([201, 409]).toContain(notMatching.status);
        expect(await latest(customerId)).toMatchObject({ id: matching.body.id, status: 'REVIEW_REQUIRED', blocking: true });
      }
    });

    it('recomputes the carry-over against the winner: two simultaneous re-screens of a cleared customer both keep the decision, the later one from the earlier one', async () => {
      const first = (await screen(sanctioned()).expect(201)).body;
      await http().post(`/api/aml/hits/${first.hits[0].id}/review`).set(admin).send({ decision: 'FALSE_POSITIVE', comment: 'Different person entirely' }).expect(200);
      const saves = trackSaves();
      interleaveFirstReads(2);
      const [a, b] = await Promise.all([screen(sanctioned()), screen(sanctioned())]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(expectChain(saves, first.id)).toHaveLength(2);
      const [early, late] = [a.body, b.body].sort((x, y) => (x.screenedAt < y.screenedAt ? -1 : 1));
      for (const r of [early, late]) expect(r).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false });
      expect(early.hits[0].details.carriedOverFrom).toBe(first.hits[0].id);
      expect(late.hits[0].details.carriedOverFrom).toBe(early.hits[0].id);
      expect((await latest('cust-1')).id).toBe(late.id);
    });

    it('gives up with 409 after three lost races, re-reading the previous screening each time but computing the lists once, and stores nothing', async () => {
      const failing = vi.spyOn(repo, 'saveScreening').mockRejectedValue(new ScreeningRaceError());
      const reads = vi.spyOn(repo, 'findLatestForCustomer');
      const res = await screen(sanctioned()).expect(409);
      expect(res.body.message).toMatch(/concurrent screening, retry/);
      expect(failing).toHaveBeenCalledTimes(3);
      expect(reads).toHaveBeenCalledTimes(3);
      expect(unClient.fetchSnapshot).toHaveBeenCalledTimes(1);
      expect(await events()).toHaveLength(0);
    });

    it('succeeds on the second attempt after one lost race, expecting the id of what is stored by then', async () => {
      const winner = (await screen(clean()).expect(201)).body;
      const original = repo.saveScreening.bind(repo);
      const seen: (string | null | undefined)[] = [];
      vi.spyOn(repo, 'saveScreening').mockImplementation(async (screening, event, options) => {
        seen.push(options?.expectedPreviousId);
        if (seen.length === 1) throw new ScreeningRaceError();
        await original(screening, event, options);
      });
      const res = await screen(clean()).expect(201);
      expect(seen).toEqual([winner.id, winner.id]);
      expect((await latest('cust-1')).id).toBe(res.body.id);
    });
  });

  describe('hits of superseded screenings', () => {
    const admin = headers('admin-1', ['ADMIN']);
    const matchBody = () => screenBody({}, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' });
    const review = (hitId: string, body: unknown, h = admin) => http().post(`/api/aml/hits/${hitId}/review`).set(h).send(body as object);
    const queue = async (query = '') => (await http().get(`/api/aml/hits${query}`).set(admin).expect(200)).body;
    const SUPERSEDED = /superseded by a newer one; review the hits of the latest screening/;

    /** S1 (OPEN hit), UN list bump, rescreen → S2 (new OPEN hit). */
    async function supersede() {
      const s1 = (await screen(matchBody()).expect(201)).body;
      un = unSnapshot('un-v2');
      now = new Date(now.getTime() + 2 * HOUR);
      expect((await http().post('/api/aml/rescreen').set(admin).send({}).expect(200)).body).toMatchObject({ rescreened: 1 });
      const s2 = (await http().get('/api/aml/customers/cust-1/latest').set(admin).expect(200)).body;
      expect(s2.id).not.toBe(s1.id);
      return { s1, s2 };
    }

    it('shows only the latest screening in the review queue and refuses to review a hit of a superseded one (409)', async () => {
      const { s1, s2 } = await supersede();
      for (const query of ['', '?status=OPEN', '?list=UN_SC']) {
        const q = await queue(query);
        expect(q.total).toBe(1);
        expect(q.items.map((i: { hit: { id: string } }) => i.hit.id)).toEqual([s2.hits[0].id]);
      }
      const res = await review(s1.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }, headers('admin-2', ['ADMIN'])).expect(409);
      expect(res.body.message).toMatch(SUPERSEDED);
      await review(s1.hits[0].id, { decision: 'CONFIRMED', comment: 'Confirmed by compliance' }, headers('approver-1', ['APPROVER'])).expect(409);
      expect((await repo.findHit('org-1', s1.hits[0].id))?.hit).toMatchObject({ status: 'OPEN', reviewedBy: null });
      expect(await events('AmlHitReviewed')).toHaveLength(0);
      // Сүүлийн screening-ийнх хэвийн шийдвэрлэгдэнэ; харилцагч блоклосон хэвээр байх ёстой байсан тул зөв event гарна.
      await review(s2.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }, headers('admin-2', ['ADMIN'])).expect(200);
      expect(await events('AmlHitReviewed')).toHaveLength(1);
      expect((await queue('?status=OPEN')).total).toBe(0);
    });

    it('does not leave the superseded hits visible after a decided hit is carried over either', async () => {
      const s1 = (await screen(matchBody()).expect(201)).body;
      await review(s1.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Different person entirely' }, headers('admin-2', ['ADMIN'])).expect(200);
      un = unSnapshot('un-v2');
      now = new Date(now.getTime() + 2 * HOUR);
      await http().post('/api/aml/rescreen').set(admin).send({}).expect(200);
      expect(await queue()).toMatchObject({ total: 1 }); // зөвхөн шинэ screening-ийн (FALSE_POSITIVE-ээр дамжсан) hit
      expect((await queue('?status=OPEN')).total).toBe(0);
      expect((await queue('?status=FALSE_POSITIVE')).items[0].screening.id).not.toBe(s1.id);
    });

    it('enforces it inside the repository transaction as well: a review that passed the pre-check but lost to a newer screening is refused', async () => {
      const { s1 } = await supersede();
      vi.spyOn(repo, 'findLatestForCustomer').mockResolvedValueOnce(await repo.findScreening('org-1', s1.id)); // өмнөх шалгалтыг "хуурч" давуулна
      const apply = vi.spyOn(repo, 'applyHitReview');
      const res = await review(s1.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }, headers('admin-2', ['ADMIN'])).expect(409);
      expect(res.body.message).toMatch(SUPERSEDED);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(await apply.mock.results[0]?.value).toEqual({ outcome: 'superseded' });
      expect((await repo.findHit('org-1', s1.hits[0].id))?.hit.status).toBe('OPEN');
      expect(await events('AmlHitReviewed')).toHaveLength(0);
    });
  });

  describe('list availability (fail closed)', () => {
    it('answers 503 and stores nothing when a list cannot be loaded', async () => {
      unFails = true;
      const res = await screen(screenBody()).expect(503);
      expect(res.body.message).toContain('UN_SC');
      expect(await events()).toHaveLength(0);
      await http().get('/api/aml/customers/cust-1/latest').set(headers('admin-1', ['ADMIN'])).expect(404);
    });

    it('falls back to a stale cache within maxStaleListHours and marks the screening', async () => {
      await screen(screenBody()).expect(201);
      unFails = true;
      now = new Date(now.getTime() + 2 * HOUR);
      const res = await screen(screenBody()).expect(201);
      expect(res.body.listVersions).toMatchObject({ UN_SC: 'un-v1+stale', FATF: 'fatf-v1' });
      now = new Date(now.getTime() + 100 * HOUR);
      await screen(screenBody()).expect(503);
    });

    it('reports list status and refreshes on demand', async () => {
      const admin = headers('admin-1', ['ADMIN']);
      await screen(screenBody()).expect(201);
      un = unSnapshot('un-v2');
      const res = await http().post('/api/aml/lists/refresh').set(admin).send({ list: 'UN_SC' }).expect(200);
      expect(res.body.find((s: { list: string }) => s.list === 'UN_SC')).toMatchObject({ version: 'un-v2', entryCount: 2, stale: false, lastError: null });
      expect((await http().get('/api/aml/lists').set(admin).expect(200)).body.map((s: { list: string }) => s.list).sort()).toEqual(['FATF', 'UN_SC']);
      await http().post('/api/aml/lists/refresh').set(admin).send({ list: 'BOGUS' }).expect(400);
    });

    describe('policy.maxStaleListHours is what bounds the stale cache', () => {
      const admin = headers('admin-1', ['ADMIN']);

      it('screen(): a 1 hour policy refuses a 2 hour old cache that the 72 hour default still accepts', async () => {
        policy = AmlPolicy.parse({ maxStaleListHours: 1 });
        await screen(screenBody()).expect(201);
        unFails = true;
        now = new Date(now.getTime() + 2 * HOUR);
        await screen(screenBody()).expect(503);
        policy = AmlPolicy.parse({});
        const res = await screen(screenBody()).expect(201);
        expect(res.body.listVersions).toMatchObject({ UN_SC: 'un-v1+stale' });
      });

      it('rescreen: answers 503 under a 1 hour policy and degrades under the default', async () => {
        await screen(screenBody()).expect(201);
        unFails = true;
        now = new Date(now.getTime() + 2 * HOUR);
        policy = AmlPolicy.parse({ maxStaleListHours: 1 });
        await http().post('/api/aml/rescreen').set(admin).send({}).expect(503);
        policy = AmlPolicy.parse({});
        expect((await http().post('/api/aml/rescreen').set(admin).send({}).expect(200)).body.failed).toBe(0);
      });

      it('GET /lists: the stale flag follows the caller organisation policy', async () => {
        await screen(screenBody()).expect(201);
        now = new Date(now.getTime() + 2 * HOUR);
        const stale = async () => (await http().get('/api/aml/lists').set(admin).expect(200)).body.map((l: { stale: boolean }) => l.stale);
        expect(await stale()).toEqual([false, false]);
        policy = AmlPolicy.parse({ maxStaleListHours: 1 });
        expect(await stale()).toEqual([true, true]);
      });
    });
  });

  describe('rescreen after a list update', () => {
    const admin = headers('admin-1', ['ADMIN']);
    const rescreen = (h = admin, body: object = {}) => http().post('/api/aml/rescreen').set(h).send(body);
    const review = (hitId: string, body: unknown, h = admin) => http().post(`/api/aml/hits/${hitId}/review`).set(h).send(body as object);
    const latest = async (customerId: string, h = admin) => (await http().get(`/api/aml/customers/${customerId}/latest`).set(h).expect(200)).body;
    const matchBody = (over: Record<string, unknown> = {}) => screenBody(over, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' });
    const advance = (ms: number) => { now = new Date(now.getTime() + ms); };

    it('re-screens only customers whose latest screening used older list versions', async () => {
      await screen(screenBody({}, {})).expect(201);
      await screen(screenBody({ customerId: 'cust-2' }, { registerNo: OTHER_REGISTER, lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' })).expect(201);
      expect((await rescreen().expect(200)).body).toEqual({ checked: 0, rescreened: 0, failed: 0, skipped: 0 });

      un = unSnapshot('un-v2');
      advance(2 * HOUR);
      const res = await rescreen(admin, { limit: 10 }).expect(200);
      expect(res.body).toEqual({ checked: 2, rescreened: 2, failed: 0, skipped: 0 });

      // screenedBy нь анхны шалгалтыг эхлүүлсэн хүн (officer-1); rescreen-ийг дуудсан admin-1 биш (SoD).
      expect(await latest('cust-2')).toMatchObject({ trigger: 'LIST_UPDATE', status: 'REVIEW_REQUIRED', listVersions: { UN_SC: 'un-v2' }, screenedBy: 'officer-1', registerNoMasked: maskRegisterNoStrict(OTHER_REGISTER) });
      expect((await rescreen().expect(200)).body.checked).toBe(0);
    });

    it('keeps the original maker barred from reviewing a rescreened hit; the admin who ran the rescreen is only the event actor', async () => {
      const maker = headers('admin-1', ['ADMIN']);
      const other = headers('admin-2', ['ADMIN']);
      await screen(matchBody(), maker).expect(201);
      un = unSnapshot('un-v2');
      advance(2 * HOUR);
      expect((await rescreen(other).expect(200)).body).toEqual({ checked: 1, rescreened: 1, failed: 0, skipped: 0 });

      const rescreened = await latest('cust-1', other);
      expect(rescreened).toMatchObject({ trigger: 'LIST_UPDATE', screenedBy: 'admin-1', status: 'REVIEW_REQUIRED' });
      const completed = await events('AmlScreeningCompleted');
      expect(completed.map((e) => e.actorId)).toEqual(['admin-1', 'admin-2']);

      const body = { decision: 'FALSE_POSITIVE', comment: 'Different person entirely' };
      await review(rescreened.hits[0].id, body, maker).expect(403); // rescreen-ээр maker өөрийнхөө тохирлыг цэвэрлэж чадахгүй
      await review(rescreened.hits[0].id, body, other).expect(200);
    });

    describe('review decisions survive a rescreen', () => {
      const extraEntry = () => unEntry('T-NAME-2', 'Bat Erdene Ganbold');

      it('carries a FALSE_POSITIVE over: the rescreened hit stays cleared and the customer stays unblocked', async () => {
        const screened = (await screen(matchBody()).expect(201)).body;
        const reviewed = (await review(screened.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Different date of birth confirmed' }).expect(200)).body;
        un = unSnapshot('un-v2');
        advance(2 * HOUR);
        expect((await rescreen().expect(200)).body).toEqual({ checked: 1, rescreened: 1, failed: 0, skipped: 0 });

        const after = await latest('cust-1');
        expect(after.id).not.toBe(screened.id);
        expect(after).toMatchObject({ trigger: 'LIST_UPDATE', status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, riskLevel: 'LOW', riskFactors: [], listVersions: { UN_SC: 'un-v2' } });
        expect(after.hits).toHaveLength(1);
        expect(after.hits[0]).toMatchObject({
          entryRef: 'T-NAME', listVersion: 'un-v2', status: 'FALSE_POSITIVE', reviewedBy: 'admin-1', reviewComment: 'Different date of birth confirmed',
          reviewedAt: reviewed.hits[0].reviewedAt, details: { carriedOverFrom: screened.hits[0].id },
        });
        expect(after.hits[0].reviewedAt).not.toBe(now.toISOString()); // шийдвэрийн цаг дахин тамгалагдахгүй
        expect(after.hits[0].id).not.toBe(screened.hits[0].id);
        expect((await http().get('/api/aml/hits?status=OPEN').set(admin).expect(200)).body.total).toBe(0);
        expect((await events('AmlScreeningCompleted')).pop()).toMatchObject({ screeningId: after.id, status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, hitCount: 1 });
        // Дахин шалгалтаар ч нөхцөл өөрчлөгдөхгүй: дараагийн list шинэчлэлт дээр дахин дамжина.
        un = unSnapshot('un-v3');
        advance(2 * HOUR);
        await rescreen().expect(200);
        expect(await latest('cust-1')).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false, listVersions: { UN_SC: 'un-v3' } });
      });

      it('keeps a CONFIRMED match confirmed and blocking, and it cannot be reversed afterwards', async () => {
        const screened = (await screen(matchBody()).expect(201)).body;
        await review(screened.hits[0].id, { decision: 'CONFIRMED', comment: 'Identity documents match' }, headers('approver-1', ['APPROVER'])).expect(200);
        un = unSnapshot('un-v2');
        advance(2 * HOUR);
        await rescreen().expect(200);

        const after = await latest('cust-1');
        expect(after).toMatchObject({ trigger: 'LIST_UPDATE', status: 'CONFIRMED_MATCH', blocking: true, riskScore: 100, riskLevel: 'HIGH' });
        expect(after.hits[0]).toMatchObject({ status: 'CONFIRMED', reviewedBy: 'approver-1', reviewComment: 'Identity documents match', details: { carriedOverFrom: screened.hits[0].id } });
        await review(after.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Trying to reverse it' }, headers('admin-2', ['ADMIN'])).expect(409);
        expect(await latest('cust-1')).toMatchObject({ status: 'CONFIRMED_MATCH', blocking: true });
      });

      it('leaves a hit that was never decided OPEN, so a new match still needs a review', async () => {
        const screened = (await screen(matchBody()).expect(201)).body;
        await review(screened.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Different date of birth confirmed' }).expect(200);
        un = unSnapshot('un-v2', [extraEntry()]);
        advance(2 * HOUR);
        await rescreen().expect(200);

        const after = await latest('cust-1');
        expect(after).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true, riskScore: 60 });
        const byRef = Object.fromEntries(after.hits.map((h: { entryRef: string }) => [h.entryRef, h]));
        expect(byRef['T-NAME']).toMatchObject({ status: 'FALSE_POSITIVE', details: { carriedOverFrom: screened.hits[0].id } });
        expect(byRef['T-NAME-2']).toMatchObject({ status: 'OPEN', reviewedBy: null, reviewedAt: null, reviewComment: null });
        expect(byRef['T-NAME-2'].details).not.toHaveProperty('carriedOverFrom');
        expect((await http().get('/api/aml/hits?status=OPEN').set(admin).expect(200)).body.total).toBe(1);
      });

      it('does not touch a screening of the same customer made without any decision to carry', async () => {
        await screen(matchBody()).expect(201);
        un = unSnapshot('un-v2');
        advance(2 * HOUR);
        await rescreen().expect(200);
        const after = await latest('cust-1');
        expect(after.hits[0]).toMatchObject({ status: 'OPEN' });
        expect(after.hits[0].details).not.toHaveProperty('carriedOverFrom');
      });
    });

    describe('a decision survives only while the evidence it was made on is unchanged', () => {
      const BIRTH = '1980-05-17';
      const body = (subjectOver: Record<string, unknown> = {}) => screenBody({}, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', birthDate: BIRTH, ...subjectOver });
      /** T-NAME-ийг сольж, бусад бичилтийг хэвээр үлдээнэ. */
      const withTName = (version: string, tName: UnEntry): UnSanctionsSnapshot => ({ ...unSnapshot(version), entries: [tName, ...unSnapshot(version).entries.slice(1)] });
      const tName = (over: Partial<UnEntry> = {}): UnEntry => ({ ...unEntry('T-NAME', 'Bat Erdene Ganbold'), ...over });
      const clear = async (hitId: string) => (await review(hitId, { decision: 'FALSE_POSITIVE', comment: 'Different date of birth confirmed' }).expect(200)).body;
      const reopened = (hit: { status: string; details: Record<string, unknown> }) => {
        expect(hit.status).toBe('OPEN');
        expect(hit.details).toMatchObject({ reopenedBecause: 'EVIDENCE_CHANGED' });
        expect(hit.details).not.toHaveProperty('carriedOverFrom');
      };

      it('re-opens a cleared hit when the list adds a date of birth that now matches the customer (mismatch became match)', async () => {
        un = withTName('un-v1', tName({ datesOfBirth: ['1960-01-01'] }));
        const s1 = (await screen(body()).expect(201)).body;
        expect(s1.hits[0].details).toMatchObject({ dateOfBirth: 'MISMATCH' });
        expect((await clear(s1.hits[0].id)).status).toBe('CLEARED_AFTER_REVIEW');

        un = withTName('un-v2', tName({ datesOfBirth: ['1960-01-01', BIRTH] }));
        advance(2 * HOUR);
        expect((await rescreen().expect(200)).body).toMatchObject({ rescreened: 1, failed: 0 });
        const after = await latest('cust-1');
        expect(after).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });
        expect(after.hits[0].details).toMatchObject({ dateOfBirth: 'MATCH' });
        reopened(after.hits[0]);
        expect((await http().get('/api/aml/hits?status=OPEN').set(admin).expect(200)).body.total).toBe(1);
      });

      it('keeps the decision when only the list version changed and the evidence is identical', async () => {
        un = withTName('un-v1', tName({ datesOfBirth: ['1960-01-01'] }));
        const s1 = (await screen(body()).expect(201)).body;
        await clear(s1.hits[0].id);
        un = withTName('un-v2', tName({ datesOfBirth: ['1960-01-01'] }));
        advance(2 * HOUR);
        await rescreen().expect(200);
        const after = await latest('cust-1');
        expect(after).toMatchObject({ status: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, listVersions: { UN_SC: 'un-v2' } });
        expect(after.hits[0]).toMatchObject({ status: 'FALSE_POSITIVE', details: { carriedOverFrom: s1.hits[0].id } });
      });

      it('re-opens when the customer birth date is edited so that it now matches the listed one (plain re-screen)', async () => {
        un = withTName('un-v1', tName({ datesOfBirth: ['1960-01-01'] }));
        const s1 = (await screen(body()).expect(201)).body;
        await clear(s1.hits[0].id);
        const again = (await screen(body({ birthDate: '1960-01-01' })).expect(201)).body;
        expect(again).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });
        expect(again.hits[0].details).toMatchObject({ dateOfBirth: 'MATCH' });
        reopened(again.hits[0]);
      });

      it('re-opens when anything about the identity changed, even if the matched evidence is byte-identical', async () => {
        un = withTName('un-v1', tName({ datesOfBirth: ['1960-01-01'] }));
        const s1 = (await screen(body()).expect(201)).body;
        await clear(s1.hits[0].id);
        const again = (await screen(body({ aliases: ['Some Unrelated Alias'] })).expect(201)).body;
        expect(again.hits[0].details.evidenceDigest).toBe(s1.hits[0].details.evidenceDigest);
        expect(again).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });
        reopened(again.hits[0]);
      });

      it('re-opens a cleared FATF hit when the category escalates to a blocking one', async () => {
        policy = AmlPolicy.parse({ blockOnFatfCallForAction: true });
        const kp = (version: string, category: 'INCREASED_MONITORING' | 'CALL_FOR_ACTION'): FatfSnapshot => ({
          version, publishedAt: '2026-10-01T00:00:00.000Z', entries: [{ countryCode: 'KP', countryName: 'Fixtureland North', category, listedOn: '2024-06-28' }],
        });
        fatf = kp('fatf-v1', 'INCREASED_MONITORING');
        const s1 = (await screen(body({ lastName: 'Тест', firstName: 'Хэрэглэгч', countries: ['KP'] })).expect(201)).body;
        expect(s1).toMatchObject({ status: 'WARNING', blocking: false });
        expect((await clear(s1.hits[0].id)).status).toBe('CLEARED_AFTER_REVIEW');

        fatf = kp('fatf-v2', 'CALL_FOR_ACTION');
        advance(2 * HOUR);
        expect((await rescreen().expect(200)).body).toMatchObject({ rescreened: 1, failed: 0 });
        const after = await latest('cust-1');
        expect(after).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true, riskScore: 40 });
        expect(after.hits[0]).toMatchObject({ list: 'FATF', severity: 'BLOCKING', details: { category: 'CALL_FOR_ACTION' } });
        reopened(after.hits[0]);
      });

      it('keeps a CONFIRMED match when an amendment turns the name match into a register match', async () => {
        const s1 = (await screen(body()).expect(201)).body;
        expect(s1.hits[0]).toMatchObject({ entryRef: 'T-NAME', matchType: 'NAME_EXACT' });
        await review(s1.hits[0].id, { decision: 'CONFIRMED', comment: 'Identity documents match' }, headers('approver-1', ['APPROVER'])).expect(200);

        un = withTName('un-v2', tName({ identifiers: [{ type: 'National Identification Number', value: REGISTER, country: 'MN' }] }));
        advance(2 * HOUR);
        await rescreen().expect(200);
        const after = await latest('cust-1');
        expect(after.hits).toHaveLength(1);
        expect(after.hits[0]).toMatchObject({ entryRef: 'T-NAME', matchType: 'REGISTER_EXACT', status: 'CONFIRMED', reviewedBy: 'approver-1', details: { carriedOverFrom: s1.hits[0].id } });
        expect(after).toMatchObject({ status: 'CONFIRMED_MATCH', blocking: true, riskScore: 100 });
        // Ганц reviewer үүнийг "цэвэрлэж" чадахгүй.
        await review(after.hits[0].id, { decision: 'FALSE_POSITIVE', comment: 'Trying to clear it' }, headers('admin-2', ['ADMIN'])).expect(409);
        expect(await latest('cust-1')).toMatchObject({ status: 'CONFIRMED_MATCH', blocking: true });
      });

      it('keeps a CONFIRMED match when an amendment turns the exact name match into a fuzzy one', async () => {
        const s1 = (await screen(body()).expect(201)).body;
        await review(s1.hits[0].id, { decision: 'CONFIRMED', comment: 'Identity documents match' }, headers('approver-1', ['APPROVER'])).expect(200);

        un = withTName('un-v2', { ...tName(), names: [{ value: 'Bat Erdene Ganbolt', quality: 'PRIMARY' }] });
        advance(2 * HOUR);
        await rescreen().expect(200);
        const after = await latest('cust-1');
        expect(after.hits[0]).toMatchObject({ entryRef: 'T-NAME', matchType: 'NAME_FUZZY', status: 'CONFIRMED', details: { carriedOverFrom: s1.hits[0].id } });
        expect(after).toMatchObject({ status: 'CONFIRMED_MATCH', blocking: true });
      });

      it('lets a CONFIRMED match disappear when its entry no longer produces a hit (known limitation: delisting)', async () => {
        const s1 = (await screen(body()).expect(201)).body;
        await review(s1.hits[0].id, { decision: 'CONFIRMED', comment: 'Identity documents match' }, headers('approver-1', ['APPROVER'])).expect(200);
        un = { ...unSnapshot('un-v2'), entries: unSnapshot('un-v2').entries.slice(1) }; // T-NAME хасагдсан
        advance(2 * HOUR);
        await rescreen().expect(200);
        expect(await latest('cust-1')).toMatchObject({ status: 'CLEAR', blocking: false, hits: [] });
      });
    });

    it('picks up screenings that were made from a stale cache once the list is fresh again', async () => {
      await screen(screenBody()).expect(201);
      unFails = true;
      advance(2 * HOUR);
      await screen(screenBody()).expect(201);
      unFails = false;
      advance(2 * HOUR);
      expect((await rescreen().expect(200)).body).toEqual({ checked: 1, rescreened: 1, failed: 0, skipped: 0 });
      expect((await latest('cust-1')).listVersions.UN_SC).toBe('un-v1');
    });

    it('does not re-screen again and again while the list stays degraded; recovery re-screens exactly once', async () => {
      await screen(screenBody()).expect(201);
      unFails = true;
      advance(2 * HOUR);
      // Жагсаалт доройтсон нь шинэ мэдээлэл: нэг удаа "+stale" тамгатай дахин шалгана.
      expect((await rescreen().expect(200)).body).toEqual({ checked: 1, rescreened: 1, failed: 0, skipped: 0 });
      expect((await latest('cust-1')).listVersions.UN_SC).toBe('un-v1+stale');
      const written = (await events('AmlScreeningCompleted')).length;
      expect(written).toBe(2);

      // Тасалдал үргэлжилж байхад өөрчлөгдөөгүй доройтсон төлөв дахин сонгогдохгүй: screening, event нэмэгдэхгүй.
      for (let i = 0; i < 3; i++) {
        advance(2 * HOUR);
        expect((await rescreen().expect(200)).body).toEqual({ checked: 0, rescreened: 0, failed: 0, skipped: 0 });
      }
      expect(await events('AmlScreeningCompleted')).toHaveLength(written);
      expect(await events('AmlHitReviewed')).toHaveLength(0);

      // Сэргэхэд шинэ жагсаалтаар нэг удаа шалгана.
      unFails = false;
      advance(2 * HOUR);
      expect((await rescreen().expect(200)).body).toEqual({ checked: 1, rescreened: 1, failed: 0, skipped: 0 });
      expect((await latest('cust-1')).listVersions.UN_SC).toBe('un-v1');
      expect((await rescreen().expect(200)).body.checked).toBe(0);
    });

    it('keeps going after a failing row: with two outdated customers the first fails and the second is still re-screened', async () => {
      await screen(screenBody({ customerId: 'cust-1' })).expect(201);
      advance(MINUTE);
      await screen(screenBody({ customerId: 'cust-2' }, { registerNo: OTHER_REGISTER })).expect(201);
      un = unSnapshot('un-v2');
      advance(2 * HOUR);

      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const failing = vi.spyOn(repo, 'saveScreening').mockRejectedValueOnce(Object.assign(new TypeError(`db down for ${REGISTER} Тест`), { code: 'ECONNREFUSED' })); // хамгийн хуучин (cust-1) нь эхэлж унана
      const res = await rescreen().expect(200);
      failing.mockRestore();
      expect(res.body).toEqual({ checked: 2, rescreened: 1, failed: 1, skipped: 0 });
      // Алдаа operator-д харагдана (ангийн нэр, код, харилцагчийн id, correlationId), харин мессеж / субъектийн өгөгдөл лог-д орохгүй.
      expect(logged).toHaveBeenCalledTimes(1);
      const line = String(logged.mock.calls[0]?.[0]);
      expect(line).toContain('error=TypeError');
      expect(line).toContain('code=ECONNREFUSED');
      expect(line).toContain('customerId=cust-1');
      expect(line).toContain('correlationId=corr-1');
      for (const secret of ['db down', REGISTER, 'Тест', 'Хэрэглэгч']) expect(line).not.toContain(secret);
      logged.mockRestore();
      expect(await latest('cust-1')).toMatchObject({ trigger: 'APPLICATION', listVersions: { UN_SC: 'un-v1' } }); // хуучин хэвээр
      expect(await latest('cust-2')).toMatchObject({ trigger: 'LIST_UPDATE', listVersions: { UN_SC: 'un-v2' } });

      // Дараагийн ажиллагаа зөвхөн унасан мөрийг дахин оролдоно.
      expect((await rescreen().expect(200)).body).toEqual({ checked: 1, rescreened: 1, failed: 0, skipped: 0 });
      expect(await latest('cust-1')).toMatchObject({ trigger: 'LIST_UPDATE', listVersions: { UN_SC: 'un-v2' } });
    });

    it('logs an error code that is not a short identifier as n/a, never the raw text', async () => {
      await screen(screenBody({ customerId: 'cust-1' })).expect(201);
      un = unSnapshot('un-v2');
      advance(2 * HOUR);
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      vi.spyOn(repo, 'saveScreening').mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'bad code with spaces & PII ХИ87654321' }));
      await rescreen().expect(200);
      expect(String(logged.mock.calls[0]?.[0])).toContain('code=n/a');
      logged.mockRestore();
    });

    it('skips a customer that was re-screened after the batch selected it, instead of screening the stale subject over the newer result', async () => {
      // S1: нэр нь жагсаалтад байхгүй тул CLEAR (блоклоогүй).
      const s1 = (await screen(screenBody({}, { lastName: 'Zzzz', firstName: 'Qqqq' })).expect(201)).body;
      expect(s1.status).toBe('CLEAR');
      un = unSnapshot('un-v2');
      advance(2 * HOUR);
      const select = repo.findOutdatedLatestScreenings.bind(repo);
      let newer: { id: string } | undefined;
      vi.spyOn(repo, 'findOutdatedLatestScreenings').mockImplementation(async (...args) => {
        const rows = await select(...args);
        // Багц S1-ийг сонгосны дараа, давталт эхлэхээс өмнө харилцагчийг жинхэнэ нэрээр дахин шалгана (блоклосон).
        newer = (await screen(matchBody()).expect(201)).body;
        return rows;
      });
      const res = await rescreen().expect(200);
      expect(res.body).toEqual({ checked: 1, rescreened: 0, failed: 0, skipped: 1 });
      expect(newer).toBeDefined();
      expect(await latest('cust-1')).toMatchObject({ id: newer?.id, status: 'REVIEW_REQUIRED', blocking: true });
      expect(await events('AmlScreeningCompleted')).toHaveLength(2); // хуучирсан S1-ээр LIST_UPDATE шалгалт бичигдээгүй
    });

    it('skips a customer whose newer screening lands between the batch check and its save', async () => {
      await screen(screenBody({}, { lastName: 'Zzzz', firstName: 'Qqqq' })).expect(201);
      un = unSnapshot('un-v2');
      advance(2 * HOUR);
      const save = repo.saveScreening.bind(repo);
      let injected = false;
      vi.spyOn(repo, 'saveScreening').mockImplementation(async (screening, event, options) => {
        if (!injected) {
          injected = true;
          await screen(matchBody()).expect(201); // rescreen-ийн хадгалалтаас яг өмнө шинэ шалгалт орно
        }
        return save(screening, event, options);
      });
      const res = await rescreen().expect(200);
      expect(res.body).toEqual({ checked: 1, rescreened: 0, failed: 0, skipped: 1 });
      expect(await latest('cust-1')).toMatchObject({ trigger: 'APPLICATION', status: 'REVIEW_REQUIRED', blocking: true });
    });

    it('answers 503 for the whole request, not a per-customer failure, when the lists are unavailable and nothing is cached', async () => {
      unFails = true;
      const res = await rescreen().expect(503);
      expect(res.body.message).toContain('UN_SC');
      expect(res.body).not.toHaveProperty('failed');
      expect(await events()).toHaveLength(0);
    });

    it('counts a list outage in the middle of the batch as per-customer failures (200) and fetches the failing list only once for the whole batch', async () => {
      policy = AmlPolicy.parse({ maxStaleListHours: 1 });
      await screen(screenBody({ customerId: 'cust-1' })).expect(201);
      await screen(screenBody({ customerId: 'cust-2' }, { registerNo: OTHER_REGISTER })).expect(201);
      un = unSnapshot('un-v2');
      advance(2 * HOUR);
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const select = repo.findOutdatedLatestScreenings.bind(repo);
      vi.spyOn(repo, 'findOutdatedLatestScreenings').mockImplementation(async (...args) => {
        const rows = await select(...args); // currentVersions аль хэдийн шинэ жагсаалтыг татсан
        unFails = true; // харин давталтын үед жагсаалт унана, cache нь 1 цагаас хэтэрсэн тул ашиглагдахгүй
        advance(2 * HOUR);
        return rows;
      });
      const fetchesBefore = unClient.fetchSnapshot.mock.calls.length;
      const res = await rescreen().expect(200);
      expect(res.body).toEqual({ checked: 2, rescreened: 0, failed: 2, skipped: 0 });
      // currentVersions-ийн таталт + давталтын НЭГ амжилтгүй оролдлого; хоёр дахь мөр хаалтын хугацаанд даруй унана (N мөр = N таталт биш).
      expect(unClient.fetchSnapshot.mock.calls.length - fetchesBefore).toBe(2);
      expect(logged).toHaveBeenCalledTimes(2);
      for (const call of logged.mock.calls) expect(String(call[0])).toContain('error=WatchlistUnavailableError code=HTTP_503');
      logged.mockRestore();
    });

    it('only touches the caller organisation', async () => {
      const org2 = headers('admin-9', ['ADMIN'], 'org-2');
      await screen(screenBody()).expect(201);
      await screen(screenBody({ orgId: 'org-2' }), headers('officer-9', ['OFFICER'], 'org-2')).expect(201);
      un = unSnapshot('un-v2');
      advance(2 * HOUR);
      expect((await rescreen().expect(200)).body).toEqual({ checked: 1, rescreened: 1, failed: 0, skipped: 0 });
      expect((await latest('cust-1', org2)).listVersions.UN_SC).toBe('un-v1'); // org-2 хараахан шинэчлэгдээгүй
      expect((await rescreen(org2).expect(200)).body).toEqual({ checked: 1, rescreened: 1, failed: 0, skipped: 0 });
      const completed = await events('AmlScreeningCompleted');
      expect(completed.filter((e) => e.orgId === 'org-2')).toHaveLength(2);
      expect(completed.filter((e) => e.orgId === 'org-1')).toHaveLength(2);
    });
  });

  describe('tenant isolation', () => {
    const org2Officer = headers('officer-9', ['OFFICER'], 'org-2');
    const org2Admin = headers('admin-9', ['ADMIN'], 'org-2');
    const admin = headers('admin-1', ['ADMIN']);
    const matching = (over: Record<string, unknown> = {}) => screenBody(over, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' });

    it('keeps latest results, the review queue, reviews and event org ids per organisation, even for the same customer id', async () => {
      const a = (await screen(matching()).expect(201)).body; // org-1, cust-1: блоклосон
      const b = (await screen(screenBody({ orgId: 'org-2' }, { registerNo: OTHER_REGISTER }), org2Officer).expect(201)).body; // org-2, ижил customerId, цэвэр
      expect(b).toMatchObject({ orgId: 'org-2', status: 'CLEAR' });

      const latest = async (h: Record<string, string>) => (await http().get('/api/aml/customers/cust-1/latest').set(h).expect(200)).body;
      expect(await latest(admin)).toMatchObject({ id: a.id, orgId: 'org-1', status: 'REVIEW_REQUIRED' });
      expect(await latest(org2Admin)).toMatchObject({ id: b.id, orgId: 'org-2', status: 'CLEAR' });
      await http().get(`/api/aml/screenings/${a.id}`).set(org2Admin).expect(404);
      await http().get(`/api/aml/screenings/${b.id}`).set(admin).expect(404);

      // Review queue: org-1 зөвхөн өөрийнхөө, org-2 зөвхөн өөрийнхөө.
      const queue = async (h: Record<string, string>) => (await http().get('/api/aml/hits').set(h).expect(200)).body;
      expect((await queue(admin)).total).toBe(1);
      expect((await queue(org2Admin))).toEqual({ total: 0, items: [] });
      const c = (await screen(matching({ orgId: 'org-2', customerId: 'cust-2' }), org2Officer).expect(201)).body;
      const queue1 = await queue(admin);
      const queue2 = await queue(org2Admin);
      expect(queue1.items.map((i: { hit: { id: string } }) => i.hit.id)).toEqual([a.hits[0].id]);
      expect(queue2.items.map((i: { hit: { id: string } }) => i.hit.id)).toEqual([c.hits[0].id]);

      // Org хоорондын шийдвэр: org-2-ын admin org-1-ийн hit-ийг шийдэж чадахгүй; өөрийнхийг шийдэхэд org-1 хөндөгдөхгүй.
      const body = { decision: 'FALSE_POSITIVE', comment: 'Different person entirely' };
      await http().post(`/api/aml/hits/${a.hits[0].id}/review`).set(org2Admin).send(body).expect(404);
      await http().post(`/api/aml/hits/${c.hits[0].id}/review`).set(org2Admin).send(body).expect(200);
      expect(await latest(admin)).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });
      expect((await queue(admin)).total).toBe(1);

      // Event бүр өөрийн org-ыг агуулна.
      const orgOfScreening = Object.fromEntries((await events('AmlScreeningCompleted')).map((e) => [(e as { screeningId: string }).screeningId, e.orgId]));
      expect(orgOfScreening).toEqual({ [a.id]: 'org-1', [b.id]: 'org-2', [c.id]: 'org-2' });
      const reviewed = await events('AmlHitReviewed');
      expect(reviewed.map((e) => [e.orgId, e.actorId])).toEqual([['org-2', 'admin-9']]);
    });

    it('resolves the policy of the caller organisation for screening, review and list status', async () => {
      orgPolicies = { 'org-2': AmlPolicy.parse({ blockOnSanctionsHit: false, requireSeparateReviewer: false, maxStaleListHours: 1 }) };
      const maker1 = headers('admin-1', ['ADMIN']);
      const maker2 = headers('admin-2', ['ADMIN'], 'org-2');
      const one = (await screen(matching(), maker1).expect(201)).body;
      const two = (await screen(matching({ orgId: 'org-2' }), maker2).expect(201)).body;
      // Ижил субъект: org-1-д блоклоно, org-2-ын бодлогоор зөвхөн анхааруулга.
      expect(one).toMatchObject({ status: 'REVIEW_REQUIRED', blocking: true });
      expect(two).toMatchObject({ status: 'WARNING', blocking: false });
      expect(two.hits[0].severity).toBe('WARNING');
      expect(policyFor.mock.calls.map(([org]) => org)).toEqual(expect.arrayContaining(['org-1', 'org-2']));

      // 4 нүдний дүрэм: org-1-д эхлүүлсэн хүн цэвэрлэж чадахгүй, org-2-д (бодлого унтраасан) чадна.
      const body = { decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' };
      await http().post(`/api/aml/hits/${one.hits[0].id}/review`).set(maker1).send(body).expect(403);
      await http().post(`/api/aml/hits/${two.hits[0].id}/review`).set(maker2).send(body).expect(200);

      // maxStaleListHours: org-2 1 цаг, org-1 анхдагч 72 цаг.
      now = new Date(now.getTime() + 2 * HOUR);
      const stale = async (h: Record<string, string>) => (await http().get('/api/aml/lists').set(h).expect(200)).body.map((l: { stale: boolean }) => l.stale);
      expect(await stale(maker1)).toEqual([false, false]);
      expect(await stale(maker2)).toEqual([true, true]);
      expect(policyFor).toHaveBeenLastCalledWith('org-2');
    });

    it('refuses to screen on behalf of another organisation and never writes anything', async () => {
      await screen(screenBody({ orgId: 'org-1' }), org2Officer).expect(403);
      await screen(screenBody({ orgId: 'org-2' })).expect(403);
      expect(await events()).toHaveLength(0);
    });
  });

  describe('input hardening', () => {
    const admin = headers('admin-1', ['ADMIN']);

    it('answers 400 (never CLEAR) when no name survives normalisation', async () => {
      for (const names of [{ lastName: '---', firstName: '...' }, { lastName: '​', firstName: '()' }, { lastName: '😀', firstName: '😀' }]) {
        const res = await screen(screenBody({}, names)).expect(400);
        expect(res.body.message).toBe('Subject has no name that can be screened');
      }
      expect(await events()).toHaveLength(0);
    });

    it('rejects U+0000 anywhere in the body (top level, nested, array items, keys) with 400 and writes nothing', async () => {
      const bad = [
        screenBody({ customerId: 'cust\u00001' }),
        screenBody({ applicationId: 'app\u00001' }),
        screenBody({}, { firstName: 'Бат\u0000Эрдэнэ' }),
        screenBody({}, { registerNo: 'ХИ8765\u00004321' }),
        screenBody({}, { aliases: ['ok', 'bad\u0000alias'] }),
        { ...screenBody(), ['ex\u0000tra']: 1 },
      ];
      for (const body of bad) {
        const res = await screen(body).expect(400);
        expect(res.body.message).toBe('Validation failed');
        expect(res.body.issues).toHaveLength(1);
      }
      const nested = await screen(screenBody({}, { aliases: ['ok', 'bad\u0000alias'] })).expect(400);
      expect(nested.body.issues[0].path).toEqual(['subject', 'aliases', 1]);
      expect(await events()).toHaveLength(0);
      const screened = (await screen(screenBody({}, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' })).expect(201)).body;
      await http().post(`/api/aml/hits/${screened.hits[0].id}/review`).set(admin).send({ decision: 'FALSE_POSITIVE', comment: 'Cleared\u0000 by compliance' }).expect(400);
      await http().post('/api/aml/rescreen').set(admin).send({ limit: 5, note: 'a\u0000b' }).expect(400);
    });

    it('rejects a lone surrogate anywhere in the body with 400 (it would be a 500 from the Prisma query engine) and writes nothing', async () => {
      const bad = [
        screenBody({ customerId: 'c\ud800x' }),
        screenBody({ applicationId: 'a\ud83dz' }),
        screenBody({}, { lastName: 'Те\udc00ст' }),
        screenBody({}, { registerNo: 'ХИ\ud8008765' }),
        screenBody({}, { aliases: ['ok', 'bad\ud800'] }),
        { ...screenBody(), ['ex\udc00tra']: 1 },
      ];
      for (const body of bad) {
        const res = await screen(body).expect(400);
        expect(res.body.message).toBe('Validation failed');
        expect(res.body.issues).toHaveLength(1);
        expect(res.body.issues[0].message).toMatch(/lone surrogate/);
      }
      const nested = await screen(screenBody({}, { aliases: ['ok', 'bad\ud800'] })).expect(400);
      expect(nested.body.issues[0].path).toEqual(['subject', 'aliases', 1]);
      expect(await events()).toHaveLength(0);
      const screened = (await screen(screenBody({}, { lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' })).expect(201)).body;
      await http().post(`/api/aml/hits/${screened.hits[0].id}/review`).set(admin).send({ decision: 'FALSE_POSITIVE', comment: 'Cleared\udc00 by compliance' }).expect(400);
      await http().post('/api/aml/rescreen').set(admin).send({ limit: 5, ['note\ud800']: 'x' }).expect(400);
      await http().get('/api/aml/customers/%ED%A0%80/latest').set(admin).expect(400); // percent-кодлосон дан surrogate
      await screen(screenBody({ customerId: 'cust-2' })).expect(201); // үйлчилгээ хэвийн хэвээр
    });

    it('caps the id fields at 128 characters: 128 passes, 129 and a 3400-character incompressible id answer 400 instead of failing at the index', async () => {
      await screen(screenBody({ customerId: 'c'.repeat(128), applicationId: 'a'.repeat(128) })).expect(201);
      for (const over of [{ customerId: 'c'.repeat(129) }, { applicationId: 'a'.repeat(129) }, { customerId: randomBytes(1700).toString('hex') }]) {
        const res = await screen(screenBody(over)).expect(400);
        expect(res.body.message).toBe('Validation failed');
      }
      const longOrg = 'o'.repeat(129);
      await screen(screenBody({ orgId: longOrg }), headers('officer-1', ['OFFICER'], longOrg)).expect(400);
      expect(await events()).toHaveLength(1);
    });

    it('rejects U+0000 in path parameters with 400, and answers 404 (never 500) for unknown ids', async () => {
      await http().get('/api/aml/customers/cust%001/latest').set(admin).expect(400);
      await http().get('/api/aml/screenings/%00').set(admin).expect(400);
      await http().post('/api/aml/hits/%00/review').set(admin).send({ decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }).expect(400);
      await http().get('/api/aml/screenings/not-a-uuid').set(admin).expect(404);
      await http().get('/api/aml/screenings/00000000-0000-4000-8000-0000000fffff').set(admin).expect(404);
      await http().get(`/api/aml/customers/${'x'.repeat(5000)}/latest`).set(admin).expect(404);
      await http().get('/api/aml/customers/nobody/latest').set(admin).expect(404);
      await http().post('/api/aml/hits/not-a-uuid/review').set(admin).send({ decision: 'FALSE_POSITIVE', comment: 'Cleared by compliance' }).expect(404);
    });

    it('rejects U+0000 in the query and caps the paging offset', async () => {
      await http().get('/api/aml/hits?status=OPEN%00').set(admin).expect(400);
      await http().get('/api/aml/hits?list=UN_SC%00').set(admin).expect(400);
      await http().get('/api/aml/hits?offset=1e20').set(admin).expect(400);
      await http().get('/api/aml/hits?offset=1000001').set(admin).expect(400);
      await http().get('/api/aml/hits?offset=-1').set(admin).expect(400);
      expect((await http().get('/api/aml/hits?offset=1000000').set(admin).expect(200)).body).toEqual({ total: 0, items: [] });
    });

    it('maps database input errors to 400 / 404, never 500', async () => {
      const prismaError = (name: string, message: string, extra: object = {}) => Object.assign(new Error(message), { name, ...extra });
      const failWith = (error: Error) => vi.spyOn(repo, 'findLatestForCustomer').mockRejectedValueOnce(error);
      failWith(prismaError('PrismaClientUnknownRequestError', 'QueryError(PostgresError { code: "22021", message: "invalid byte sequence" })'));
      await http().get('/api/aml/customers/cust-1/latest').set(admin).expect(400);
      failWith(prismaError('PrismaClientValidationError', 'Unable to fit value 100000000000000000000 into a 64-bit signed integer for field `skip`'));
      const res = await http().get('/api/aml/customers/cust-1/latest').set(admin).expect(400);
      expect(JSON.stringify(res.body)).not.toContain('100000000000000000000'); // DB-ийн дотоод текст алдагдахгүй
      failWith(prismaError('PrismaClientKnownRequestError', 'not found', { code: 'P2025' }));
      await http().get('/api/aml/customers/cust-1/latest').set(admin).expect(404);
    });

    it.skipIf(!useDb)('classifies the real Prisma error for a NUL byte and for an oversized skip as 400 inputs', async () => {
      const nul = await repo.findLatestForCustomer('org-1', 'a\u0000b').catch((e: unknown) => e);
      expect(nul).toBeInstanceOf(Error);
      expect(mapDbInputError(nul)).toBeInstanceOf(BadRequestException);
      const skip = await repo.listHits('org-1', { limit: 5, offset: 1e20 }).catch((e: unknown) => e);
      expect(mapDbInputError(skip)).toBeInstanceOf(BadRequestException);
    });
  });

  describe('documented paging limits', () => {
    const admin = headers('admin-1', ['ADMIN']);

    it('GET /aml/hits: limit defaults to 20 and may be 1..100; offset defaults to 0', async () => {
      const listHits = vi.spyOn(repo, 'listHits');
      const lastFilter = () => listHits.mock.calls.at(-1)?.[1];
      await http().get('/api/aml/hits').set(admin).expect(200);
      expect(lastFilter()).toMatchObject({ limit: 20, offset: 0 });
      for (const limit of [1, 100]) {
        await http().get(`/api/aml/hits?limit=${limit}`).set(admin).expect(200);
        expect(lastFilter()).toMatchObject({ limit });
      }
      const calls = listHits.mock.calls.length;
      for (const limit of ['0', '101', '-1', '1.5', 'abc']) await http().get(`/api/aml/hits?limit=${limit}`).set(admin).expect(400);
      expect(listHits.mock.calls.length).toBe(calls); // буруу хүсэлт repository хүртэл хүрэхгүй
    });

    it('GET /aml/hits returns at most 20 items by default, the total counting all of them', async () => {
      for (let i = 0; i < 21; i++) await screen(screenBody({ customerId: `cust-page-${i}` }, { countries: ['KP'] })).expect(201);
      const page = (await http().get('/api/aml/hits').set(admin).expect(200)).body;
      expect(page.total).toBe(21);
      expect(page.items).toHaveLength(20);
      expect((await http().get('/api/aml/hits?limit=100').set(admin).expect(200)).body.items).toHaveLength(21);
    });

    it('POST /aml/rescreen: limit defaults to 50 and may be 1..500, whole numbers only', async () => {
      const outdated = vi.spyOn(repo, 'findOutdatedLatestScreenings');
      const lastLimit = () => outdated.mock.calls.at(-1)?.[2];
      await http().post('/api/aml/rescreen').set(admin).send({}).expect(200);
      expect(lastLimit()).toBe(50);
      for (const limit of [1, 500]) {
        await http().post('/api/aml/rescreen').set(admin).send({ limit }).expect(200);
        expect(lastLimit()).toBe(limit);
      }
      const calls = outdated.mock.calls.length;
      for (const limit of [0, 501, -1, 1.5, '10']) await http().post('/api/aml/rescreen').set(admin).send({ limit }).expect(400);
      expect(outdated.mock.calls.length).toBe(calls);
    });
  });
});
