import { type INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { XypAssetsResponse, XypPropertyAsset } from '@los/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENCUMBRANCE_REGISTRY } from '../src/integrations/encumbrance/encumbrance.registry';
import { as, createLightApp } from './app';

// CLAUDE.md §6.5: регистр, өмчлөгчийн нэр, улсын дугаар лог-д орохгүй. Nest-ийн Logger болон stdout/stderr-ийн бүх бичлэгийг цуглуулж шалгана
// (амжилттай хариу ба 404/422/503/501 алдааны замууд). DB шаардахгүй.
const LEVELS = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;

describe('kyc · xyp assets / property / encumbrance never log personal data', () => {
  let app: INestApplication;
  const captured: string[] = [];
  const post = (path: string, body: unknown) => request(app.getHttpServer()).post(path).set(as('officerA')).send(body as object);

  beforeAll(async () => {
    app = await createLightApp((b) =>
      // Тодорхойгүй алдааг (хувийн мэдээлэл агуулсан мессежтэй) дуурайх registry-г "ERRX" дугаарт ашиглана.
      b.overrideProvider(ENCUMBRANCE_REGISTRY).useFactory({ factory: () => ({ check: async (_t: string, id: string) => { if (id.endsWith('BOOM')) throw new TypeError(`boom for ${id} of УБ90010112`); return [{ source: 'ZMS', status: 'CLEAR', pledgee: null, registeredAt: null, note: null }, { source: 'EB', status: 'CLEAR', pledgee: null, registeredAt: null, note: null }]; } }) }),
    );
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    captured.length = 0;
    for (const level of LEVELS) vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => { captured.push(JSON.stringify(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : a)))); });
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => { captured.push(String(chunk)); return (original as (...a: unknown[]) => boolean)(chunk, ...rest); }) as never);
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('success, 404, 503, 422 and 400 responses leave no register, plate, property id or owner name in any log line', async () => {
    const pii = new Set<string>(['ЖИ00000002', '5678УНА', 'MOCK-ЖИ00000002-9', 'УБ00000000', 'УБ99999999', 'УЕН5246ERR', 'MOCK-УБ99999999-1', 'MOCK-УБ90010112-2', '0000001', '1234УБА', 'УБ90010112']);

    const assets = await post('/api/xyp/assets', { registerNo: 'ЖИ00000002' });
    expect(assets.status).toBe(200);
    const parsed = XypAssetsResponse.parse(assets.body);
    for (const p of parsed.properties) for (const o of p.owners) { pii.add(o.name); pii.add(o.registerNo); }
    const prop = XypPropertyAsset.parse((await post('/api/xyp/property', { propertyId: 'MOCK-ЖИ00000002-9' })).body);
    for (const o of prop.owners) { pii.add(o.name); pii.add(o.registerNo); }

    expect((await post('/api/xyp/assets', { registerNo: 'УБ00000000' })).status).toBe(404);
    expect((await post('/api/xyp/assets', { registerNo: 'УБ99999999' })).status).toBe(503);
    expect((await post('/api/xyp/assets', { registerNo: 'AB123' })).status).toBe(400);
    expect((await post('/api/xyp/property', { propertyId: 'MOCK-УБ90010112-2' })).status).toBe(404);
    expect((await post('/api/xyp/property', { propertyId: 'MOCK-УБ99999999-1' })).status).toBe(503);
    expect((await post('/api/collateral-checks/encumbrance', { assetType: 'VEHICLE', identifier: '5678УНА' })).status).toBe(200);
    expect((await post('/api/collateral-checks/encumbrance', { assetType: 'VEHICLE', identifier: 'УЕН5246ERR' })).status).toBe(200); // override registry: ERR энд тусгай биш
    expect((await post('/api/collateral-checks/encumbrance', { assetType: 'OTHER', identifier: '1234УБА' })).status).toBe(422);
    expect((await post('/api/collateral-checks/encumbrance', { assetType: 'VEHICLE', identifier: '1234УБАBOOM' })).status).toBe(503); // тодорхойгүй алдаа → 503
    expect((await post('/api/collateral-checks/encumbrance', { assetType: 'VEHICLE', identifier: '' })).status).toBe(400);

    const logs = captured.join('\n');
    expect(logs.length).toBeGreaterThan(0); // 5xx алдаа лог-д бичигдсэн (тест хоосон үр дүнд хуурагдахгүй)
    expect(logs).toMatch(/XYP_UNAVAILABLE|ХУР түр ажиллахгүй/);
    expect(logs).toContain('TypeError'); // тодорхойгүй алдааны ЗӨВХӨН нэр
    for (const secret of pii) expect(logs, secret).not.toContain(secret);
    expect(logs).not.toContain('boom for');
    expect(logs).not.toContain('1234УБАBOOM');
  });
});
