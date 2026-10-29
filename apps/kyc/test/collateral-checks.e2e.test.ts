import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EncumbranceCheckResult, ROLE_PERMISSIONS, type EncumbranceSourceResult, type UserRole } from '@los/contracts';
import { SEED } from '@los/database';
import { Clock, FixedClock } from '@los/nest-common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENCUMBRANCE_REGISTRY, EncumbranceUnavailableError, type EncumbranceRegistry } from '../src/integrations/encumbrance/encumbrance.registry';
import { IntegrationNotImplementedError } from '../src/integrations/errors';
import { as, createApp, createLightApp } from './app';

const PATH = '/api/collateral-checks/encumbrance';
const headersFor = (roles: string) => ({ 'x-user-id': SEED.users.officerA.id, 'x-roles': roles, 'x-org-id': SEED.org.id });
const send = (app: INestApplication, headers: Record<string, string>, body: unknown) => request(app.getHttpServer()).post(PATH).set(headers).send(body as object);
const src = (source: 'ZMS' | 'EB', status: EncumbranceSourceResult['status'], over: Partial<EncumbranceSourceResult> = {}): EncumbranceSourceResult => ({ source, status, pledgee: null, registeredAt: null, note: null, ...over });

describe.skipIf(!process.env.TEST_DATABASE_URL)('kyc · POST /api/collateral-checks/encumbrance (FR-6.6)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createApp(); });
  afterAll(async () => { await app.close(); });
  const check = (who: Parameters<typeof as>[0], assetType: unknown, identifier: unknown) => send(app, as(who), { assetType, identifier });

  it('CLEAR: both sources report clear; checkedAt is a recent ISO time', async () => {
    const before = Date.now();
    const res = await check('officerA', 'VEHICLE', 'УЕН5246');
    expect(res.status).toBe(200);
    const body = EncumbranceCheckResult.parse(res.body);
    expect(body.status).toBe('CLEAR');
    expect(body.sources).toEqual([src('ZMS', 'CLEAR'), src('EB', 'CLEAR')]);
    expect(Math.abs(new Date(body.checkedAt).getTime() - before)).toBeLessThan(60_000);
  });

  it('ENCUMBERED when the last digit is 7: ЗМС names the fictional pledgee', async () => {
    const body = EncumbranceCheckResult.parse((await check('officerA', 'VEHICLE', 'УЕН5247')).body);
    expect(body.status).toBe('ENCUMBERED');
    expect(body.sources[0]).toMatchObject({ source: 'ZMS', status: 'ENCUMBERED', pledgee: 'Жишээ ББСБ' });
    expect(body.sources[1]).toMatchObject({ source: 'EB', status: 'CLEAR' });
  });

  it('DISPUTED when the last digit is 9: reported by ЭБ', async () => {
    const body = EncumbranceCheckResult.parse((await check('officerA', 'LAND', 'MOCK-УБ90010112-9')).body);
    expect(body.status).toBe('DISPUTED');
    expect(body.sources[1]).toMatchObject({ source: 'EB', status: 'DISPUTED' });
  });

  it('works for each of the five applicable asset types, normalizing the identifier (plate case/dashes)', async () => {
    for (const [type, id] of [['VEHICLE', '1234-уба'], ['APARTMENT', 'MOCK-УБ90010112-1'], ['HOUSE', 'MOCK-УБ90010111-1'], ['LAND', 'MOCK-УБ00000001-2'], ['EQUIPMENT', 'SN-0042']] as const) {
      const res = await check('officerA', type, id);
      expect([type, res.status, res.body.status]).toEqual([type, 200, 'CLEAR']);
    }
    expect((await check('officerA', 'VEHICLE', '5677 уба')).body.status).toBe('ENCUMBERED'); // нормчилсны дараа сүүлийн цифр 7
  });

  it('422 ENCUMBRANCE_CHECK_NOT_APPLICABLE for livestock, inventory and other assets (Mongolian message)', async () => {
    for (const type of ['LIVESTOCK', 'INVENTORY', 'OTHER']) {
      const res = await check('officerA', type, 'X-1');
      expect([type, res.status, res.body.code]).toEqual([type, 422, 'ENCUMBRANCE_CHECK_NOT_APPLICABLE']);
      expect(res.body.message).toMatch(/ачаалал шалгах боломжгүй/);
    }
  });

  it('503 ENCUMBRANCE_UNAVAILABLE when a source is down (identifier ends with ERR) — fail closed, no status in the body', async () => {
    const res = await check('officerA', 'VEHICLE', 'УЕН5246ERR');
    expect([res.status, res.body.code]).toEqual([503, 'ENCUMBRANCE_UNAVAILABLE']);
    expect(res.body.status).toBeUndefined();
    expect(res.body.message).toMatch(/цэвэр/);
    expect(JSON.stringify(res.body)).not.toContain('УЕН5246');
  });

  it('400 VALIDATION_FAILED for an unknown asset type, a missing/blank/over-long identifier, or a malformed body', async () => {
    for (const body of [{}, { assetType: 'VEHICLE' }, { identifier: 'X1' }, { assetType: 'SPACESHIP', identifier: 'X1' }, { assetType: 'vehicle', identifier: 'X1' }, { assetType: 'VEHICLE', identifier: '' }, { assetType: 'VEHICLE', identifier: '   ' }, { assetType: 'VEHICLE', identifier: 'X'.repeat(101) }, { assetType: 'VEHICLE', identifier: 7 }]) {
      const res = await send(app, as('officerA'), body);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  it('400 INVALID_IDENTIFIER when a plate normalizes to nothing', async () => {
    const res = await check('officerA', 'VEHICLE', '- - -');
    expect([res.status, res.body.code]).toEqual([400, 'INVALID_IDENTIFIER']);
  });

  describe('permissions (customer:read)', () => {
    it('every role that holds customer:read may call it; the others get 403 (the table, not an assumption)', async () => {
      const roles = Object.keys(ROLE_PERMISSIONS) as UserRole[];
      expect(roles.filter((r) => ROLE_PERMISSIONS[r].includes('customer:read')).sort()).toEqual(['ADMIN', 'APPROVER', 'BRANCH_MANAGER', 'OFFICER']);
      for (const role of roles) {
        const res = await send(app, headersFor(role), { assetType: 'VEHICLE', identifier: 'УЕН5246' });
        expect([role, res.status]).toEqual([role, ROLE_PERMISSIONS[role].includes('customer:read') ? 200 : 403]);
      }
    });

    it('the seeded users of every role are allowed', async () => {
      for (const who of ['officerA', 'officerB', 'manager', 'approver', 'admin'] as const) expect((await check(who, 'VEHICLE', 'УЕН5246')).status, who).toBe(200);
    });

    it('403 FORBIDDEN for an unknown or empty role; 401 anonymous or without organization', async () => {
      for (const roles of ['GUEST', '']) {
        const res = await send(app, headersFor(roles), { assetType: 'VEHICLE', identifier: 'УЕН5246' });
        expect([roles, res.status, res.body.code]).toEqual([roles, 403, 'FORBIDDEN']);
      }
      expect((await send(app, {}, { assetType: 'VEHICLE', identifier: 'УЕН5246' })).status).toBe(401);
      const { 'x-org-id': _org, ...noOrg } = headersFor('OFFICER');
      expect((await send(app, noOrg, { assetType: 'VEHICLE', identifier: 'УЕН5246' })).body.code).toBe('MISSING_ORG');
    });
  });
});

// ── DB-гүй: Clock, INTEGRATION_MODE=real, эх сурвалжийн саатал дуурайх ───────────────────────────────────────────────────────────
describe('kyc · encumbrance check behaviour that needs no database', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); });
  const withRegistry = (registry: EncumbranceRegistry, clock?: FixedClock) =>
    createLightApp((b) => { const r = b.overrideProvider(ENCUMBRANCE_REGISTRY).useValue(registry); return clock ? r.overrideProvider(Clock).useValue(clock) : r; });
  const body = { assetType: 'VEHICLE', identifier: 'УЕН5246' };

  it('checkedAt comes from the injected Clock', async () => {
    app = await createLightApp((b) => b.overrideProvider(Clock).useValue(new FixedClock(new Date('2027-01-02T03:04:05.678Z'))));
    const res = await send(app, as('officerA'), body);
    expect([res.status, res.body.checkedAt]).toEqual([200, '2027-01-02T03:04:05.678Z']);
  });

  it('INTEGRATION_MODE=real → 501 INTEGRATION_NOT_IMPLEMENTED (never a CLEAR)', async () => {
    vi.stubEnv('INTEGRATION_MODE', 'real');
    app = await createLightApp();
    const res = await send(app, as('officerA'), body);
    expect([res.status, res.body.code]).toEqual([501, 'INTEGRATION_NOT_IMPLEMENTED']);
    expect(res.body.status).toBeUndefined();
  });

  it('only ЗМС answering (ЭБ missing) → 503, even when ЗМС says CLEAR', async () => {
    app = await withRegistry({ check: async () => [src('ZMS', 'CLEAR')] });
    const res = await send(app, as('officerA'), body);
    expect([res.status, res.body.code]).toEqual([503, 'ENCUMBRANCE_UNAVAILABLE']);
  });

  it('a source that fails mid-way (adapter throws EncumbranceUnavailableError) → 503, any other error → 503 too', async () => {
    app = await withRegistry({ check: async () => { throw new EncumbranceUnavailableError(); } });
    expect((await send(app, as('officerA'), body)).body.code).toBe('ENCUMBRANCE_UNAVAILABLE');
    await app.close();
    app = await withRegistry({ check: async () => { throw new Error('timeout talking to zms'); } });
    const res = await send(app, as('officerA'), body);
    expect([res.status, res.body.code]).toEqual([503, 'ENCUMBRANCE_UNAVAILABLE']);
    expect(JSON.stringify(res.body)).not.toContain('timeout');
  });

  it('a registry stub without implementation → 501', async () => {
    app = await withRegistry({ check: async () => { throw new IntegrationNotImplementedError('encumbrance'); } });
    expect((await send(app, as('officerA'), body)).status).toBe(501);
  });

  it('the combined status follows DISPUTED > ENCUMBERED > CLEAR across several rows and sources', async () => {
    app = await withRegistry({ check: async () => [src('EB', 'ENCUMBERED', { pledgee: 'Жишээ ББСБ' }), src('ZMS', 'DISPUTED'), src('ZMS', 'CLEAR')] });
    const res = await send(app, as('officerA'), body);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISPUTED');
    expect(res.body.sources.map((s: EncumbranceSourceResult) => s.source)).toEqual(['ZMS', 'ZMS', 'EB']);
  });
});
