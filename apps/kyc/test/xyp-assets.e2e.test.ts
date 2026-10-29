import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ROLE_PERMISSIONS, XypAssetsResponse, XypPropertyAsset, type UserRole } from '@los/contracts';
import { SEED } from '@los/database';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IntegrationNotImplementedError } from '../src/integrations/errors';
import { XYP_CLIENT, XypUnavailableError, type XypClient } from '../src/integrations/xyp/xyp.client';
import { xypCoOwnerRegister } from '../src/integrations/xyp/xyp-assets.fixture';
import { as, createApp, createLightApp } from './app';

const headersFor = (roles: string) => ({ 'x-user-id': SEED.users.officerA.id, 'x-roles': roles, 'x-org-id': SEED.org.id });
const send = (app: INestApplication, path: string, headers: Record<string, string>, body: unknown) => request(app.getHttpServer()).post(path).set(headers).send(body as object);

describe.skipIf(!process.env.TEST_DATABASE_URL)('kyc · POST /api/xyp/assets and /api/xyp/property (FR-6.3, FR-6.5)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createApp(); });
  afterAll(async () => { await app.close(); });
  const assets = (who: Parameters<typeof as>[0], registerNo: unknown) => send(app, '/api/xyp/assets', as(who), { registerNo });
  const property = (who: Parameters<typeof as>[0], propertyId: unknown) => send(app, '/api/xyp/property', as(who), { propertyId });

  describe('assets', () => {
    it('returns the properties and vehicles owned by a register; the register is normalized (case, spaces)', async () => {
      const res = await assets('officerA', 'жи 00000002');
      expect(res.status).toBe(200);
      const body = XypAssetsResponse.parse(res.body);
      expect(body.vehicles).toEqual([expect.objectContaining({ plateNo: '5678УНА', make: 'Hyundai', model: 'Sonata', manufactureYear: 2017, fuelType: 'LPG' })]);
      expect(body.properties.map((p) => p.propertyId)).toEqual(['MOCK-ЖИ00000002-1', 'MOCK-ЖИ00000002-9']);
      expect(body.properties.every((p) => p.owners[0]!.registerNo === 'ЖИ00000002')).toBe(true);
    });

    it('a register with no vehicle has an empty vehicle list; a legal entity has one commercial property and its vehicle', async () => {
      expect(XypAssetsResponse.parse((await assets('officerA', 'УБ90010112')).body).vehicles).toEqual([]);
      const legal = XypAssetsResponse.parse((await assets('officerA', '0000001')).body);
      expect(legal.properties).toHaveLength(1);
      expect(legal.properties[0]!.owners[0]!.name).toMatch(/ХХК$/);
      expect(legal.vehicles.map((v) => v.plateNo)).toEqual(['1234УБА']);
    });

    it('is deterministic over HTTP', async () => {
      expect((await assets('officerA', 'ЖИ00000002')).body).toEqual((await assets('officerB', 'ЖИ00000002')).body);
    });

    it('404 XYP_NOT_FOUND when ХУР does not know the register (all zeros)', async () => {
      for (const reg of ['УБ00000000', '0000000']) {
        const res = await assets('officerA', reg);
        expect([res.status, res.body.code], reg).toEqual([404, 'XYP_NOT_FOUND']);
        expect(res.body.message).toMatch(/ХУР/);
      }
    });

    it('503 XYP_UNAVAILABLE when ХУР is down (all nines)', async () => {
      for (const reg of ['УБ99999999', '9999999']) {
        const res = await assets('officerA', reg);
        expect([res.status, res.body.code], reg).toEqual([503, 'XYP_UNAVAILABLE']);
      }
    });

    it('400 INVALID_REGISTER_NO (Mongolian message) for a malformed register; 400 VALIDATION_FAILED for a malformed body', async () => {
      for (const reg of ['AB123', 'УБ9001011', '12345678', 'garbage']) {
        const res = await assets('officerA', reg);
        expect([res.status, res.body.code], reg).toEqual([400, 'INVALID_REGISTER_NO']);
        expect(res.body.message).toMatch(/Регистрийн дугаар буруу/);
      }
      for (const body of [{}, { registerNo: '' }, { registerNo: '   ' }, { registerNo: 5 }, { registerNo: null }]) {
        const res = await send(app, '/api/xyp/assets', as('officerA'), body);
        expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
      }
    });

    it('does not echo the register back in an error body', async () => {
      const res = await assets('officerA', 'УБ00000000');
      expect(JSON.stringify(res.body)).not.toContain('УБ00000000');
    });
  });

  describe('property', () => {
    it('returns the property with all owners; a co-owned one (n=9) lists a second, different owner', async () => {
      const res = await property('officerA', 'MOCK-ЖИ00000002-9');
      expect(res.status).toBe(200);
      const body = XypPropertyAsset.parse(res.body);
      expect(body.propertyId).toBe('MOCK-ЖИ00000002-9');
      expect(body.owners.map((o) => o.registerNo)).toEqual(['ЖИ00000002', xypCoOwnerRegister('ЖИ00000002')]);
      expect(body.owners.map((o) => o.sharePercent)).toEqual([50, 50]);
    });

    it('the property listed by /assets is the one /property returns (same owners)', async () => {
      const listed = XypAssetsResponse.parse((await assets('officerA', 'УБ00000001')).body).properties;
      for (const p of listed) expect((await property('officerA', p.propertyId)).body).toEqual(p);
    });

    it('404 XYP_NOT_FOUND for an unknown or unlisted id', async () => {
      for (const id of ['MOCK-УБ90010112-2', 'MOCK-УБ00000000-1', 'Ү-2201001234', 'nonsense']) {
        const res = await property('officerA', id);
        expect([res.status, res.body.code], id).toEqual([404, 'XYP_NOT_FOUND']);
        expect(res.body.message).toMatch(/өмчлөх эрхийн дугаар/);
      }
    });

    it('503 XYP_UNAVAILABLE when the owner register makes ХУР fail', async () => {
      const res = await property('officerA', 'MOCK-УБ99999999-1');
      expect([res.status, res.body.code]).toEqual([503, 'XYP_UNAVAILABLE']);
    });

    it('400 VALIDATION_FAILED for a missing, empty, non-string or over-long property id', async () => {
      for (const body of [{}, { propertyId: '' }, { propertyId: '  ' }, { propertyId: 12 }, { propertyId: 'M'.repeat(61) }]) {
        const res = await send(app, '/api/xyp/property', as('officerA'), body);
        expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
      }
    });
  });

  describe('permissions (customer:read)', () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as UserRole[];

    it('every role that holds customer:read may call both endpoints; the others get 403 (the table, not an assumption)', async () => {
      expect(roles.filter((r) => ROLE_PERMISSIONS[r].includes('customer:read')).sort()).toEqual(['ADMIN', 'APPROVER', 'BRANCH_MANAGER', 'OFFICER']);
      for (const role of roles) {
        const allowed = ROLE_PERMISSIONS[role].includes('customer:read');
        for (const [path, body] of [['/api/xyp/assets', { registerNo: 'УБ90010112' }], ['/api/xyp/property', { propertyId: 'MOCK-УБ90010112-1' }]] as const) {
          const res = await send(app, path, headersFor(role), body);
          expect([role, path, res.status]).toEqual([role, path, allowed ? 200 : 403]);
        }
      }
    });

    it('the seeded users of every role can read assets (unlike /xyp/citizen, which stays customer:write)', async () => {
      for (const who of ['officerA', 'officerB', 'manager', 'approver', 'admin'] as const) expect((await assets(who, 'УБ90010112')).status, who).toBe(200);
      expect((await send(app, '/api/xyp/citizen', as('approver'), { registerNo: 'УБ90010112' })).status).toBe(403);
    });

    it('403 for an unknown role or no role; 401 anonymous or without organization', async () => {
      for (const roles of ['GUEST', '']) expect((await send(app, '/api/xyp/assets', headersFor(roles), { registerNo: 'УБ90010112' })).status, roles).toBe(403);
      expect((await send(app, '/api/xyp/assets', headersFor('GUEST'), { registerNo: 'УБ90010112' })).body.code).toBe('FORBIDDEN');
      expect((await send(app, '/api/xyp/assets', {}, { registerNo: 'УБ90010112' })).status).toBe(401);
      expect((await send(app, '/api/xyp/property', {}, { propertyId: 'MOCK-УБ90010112-1' })).status).toBe(401);
      const { 'x-org-id': _org, ...noOrg } = headersFor('OFFICER');
      const res = await send(app, '/api/xyp/assets', noOrg, { registerNo: 'УБ90010112' });
      expect([res.status, res.body.code]).toEqual([401, 'MISSING_ORG']);
    });
  });
});

// ── DB-гүй: INTEGRATION_MODE=real ба ХУР-ын клиентийн алдааг дуурайх ───────────────────────────────────────────────────────────
describe('kyc · xyp assets/property error mapping (no database)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); });
  const fakeClient = (error: unknown): XypClient => ({
    getCitizen: async () => { throw error; },
    getAssets: async () => { throw error; },
    getProperty: async () => { throw error; },
  });
  const withClient = (client: XypClient) => createLightApp((b) => b.overrideProvider(XYP_CLIENT).useValue(client));

  it('INTEGRATION_MODE=real → 501 INTEGRATION_NOT_IMPLEMENTED for assets and property (and citizen), no guessed data', async () => {
    vi.stubEnv('INTEGRATION_MODE', 'real');
    app = await createLightApp();
    for (const [path, body, who] of [
      ['/api/xyp/assets', { registerNo: 'УБ90010112' }, 'officerA'],
      ['/api/xyp/property', { propertyId: 'MOCK-УБ90010112-1' }, 'officerA'],
      ['/api/xyp/citizen', { registerNo: 'УБ90010112' }, 'officerA'],
    ] as const) {
      const res = await send(app, path, as(who), body);
      expect([path, res.status, res.body.code]).toEqual([path, 501, 'INTEGRATION_NOT_IMPLEMENTED']);
      expect(res.body.message).toMatch(/ХУР/);
    }
  });

  it('INTEGRATION_MODE=mock serves the fixtures without a database', async () => {
    vi.stubEnv('INTEGRATION_MODE', 'mock');
    app = await createLightApp();
    expect((await send(app, '/api/xyp/assets', as('officerA'), { registerNo: 'УЕ00000001' })).body.vehicles).toHaveLength(1);
  });

  it('a client that reports ХУР down → 503 XYP_UNAVAILABLE on both endpoints', async () => {
    app = await withClient(fakeClient(new XypUnavailableError()));
    for (const [path, body] of [['/api/xyp/assets', { registerNo: 'УБ90010112' }], ['/api/xyp/property', { propertyId: 'MOCK-УБ90010112-1' }]] as const) {
      const res = await send(app, path, as('officerA'), body);
      expect([path, res.status, res.body.code]).toEqual([path, 503, 'XYP_UNAVAILABLE']);
    }
  });

  it('a client without a real adapter → 501 on both endpoints', async () => {
    app = await withClient(fakeClient(new IntegrationNotImplementedError('xyp')));
    for (const [path, body] of [['/api/xyp/assets', { registerNo: 'УБ90010112' }], ['/api/xyp/property', { propertyId: 'MOCK-УБ90010112-1' }]] as const) {
      expect((await send(app, path, as('officerA'), body)).status, path).toBe(501);
    }
  });

  it('an unexpected client error is a plain 500 INTERNAL that does not leak its message', async () => {
    app = await withClient(fakeClient(new Error('connection string postgres://secret')));
    const res = await send(app, '/api/xyp/assets', as('officerA'), { registerNo: 'УБ90010112' });
    expect([res.status, res.body.code]).toEqual([500, 'INTERNAL']);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('a client that finds nothing → 404 XYP_NOT_FOUND', async () => {
    app = await withClient({ getCitizen: async () => null, getAssets: async () => null, getProperty: async () => null });
    expect((await send(app, '/api/xyp/assets', as('officerA'), { registerNo: 'УБ90010112' })).body.code).toBe('XYP_NOT_FOUND');
    expect((await send(app, '/api/xyp/property', as('officerA'), { propertyId: 'MOCK-УБ90010112-1' })).body.code).toBe('XYP_NOT_FOUND');
  });
});
