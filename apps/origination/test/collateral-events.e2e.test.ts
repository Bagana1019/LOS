import { randomUUID } from 'node:crypto';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@los/nest-common';
import { ValuationCompleted } from '@los/contracts';
import { CollateralValuationService } from '../src/modules/collateral/collateral-valuation.service';
import type { ValuationCompletedEvent } from '../src/modules/collateral/collateral-valuation-event';
import { hasTestDb, resetDb, ORG } from '../src/test-utils/factories';
import {
  bootCollateralKit, collateralApi, REGISTER, seedScenario, stepOf, url, vehicleDescription, type CollateralKit, type Scenario,
} from '../src/modules/collateral/testing/collateral-test-kit';

// Модуль 6 core · ValuationCompleted subscriber (docs/05 §2, §8), idempotency, хувийн мэдээлэл лог/аудитад орохгүй байх (CLAUDE.md §6.5).
describe.skipIf(!hasTestDb)('collateral events and privacy (DB)', () => {
  let k: CollateralKit;
  const prisma = () => k.t.prisma;
  const { post, get, patch, mutation, ok, registerVehicle, addVehicle, verifyOwnership, checkEncumbrance, value, attachAll, events, audits, completeVehicle } = collateralApi(() => k);

  beforeAll(async () => { k = await bootCollateralKit(); });
  afterAll(async () => { await resetDb(prisma()); await k.close(); });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDb(prisma());
    await prisma().processedEvent.deleteMany();
    k.kyc.reset(); k.valuation.reset(); k.files.reset();
    k.t.bus.published.length = 0;
    k.t.clock.set('2026-10-28T02:00:00Z');
  });

  /** Бодит цаг (DB-ийн updated_at үүгээр бичигддэг) -> event-ийн occurredAt түүнээс хойш байх ёстой. */
  const later = (ms = 1_000): string => new Date(Date.now() + ms).toISOString();
  function valuationEvent(s: Scenario, collateralId: string, over: Partial<ValuationCompletedEvent> = {}): ValuationCompletedEvent {
    return ValuationCompleted.parse({
      eventId: randomUUID(), occurredAt: later(), version: 1, orgId: ORG, actorId: null, correlationId: 'corr-event-1', type: 'ValuationCompleted', collateralId, applicationId: s.app.id,
      marketValue: 30_000_000, collateralValue: 21_000_000, valuationId: `val-${randomUUID()}`, assetType: 'VEHICLE', source: 'INTERNAL', haircutRate: 0.7,
      valuedAt: '2026-10-28T01:00:00.000Z', validUntil: '2027-01-26T01:00:00.000Z', externalRequired: false, ...over,
    });
  }
  const publish = (e: ValuationCompletedEvent) => k.t.bus.publish(e);
  const row = (id: string) => prisma().collateral.findUniqueOrThrow({ where: { id } });
  const counts = async () => ({ events: (await events()).length, audits: (await audits()).length, processed: await prisma().processedEvent.count() });

  describe('ValuationCompleted -> барьцааны үнэлгээний нөөц синк', () => {
    it('sync хариу алдагдсан барьцаанд үнэлгээг хэрэглэнэ: баганууд, дахин үнэлгээний огноо, G0, аудит, CollateralChanged(VALUED)', async () => {
      const s = await seedScenario(prisma(), { amount: 10_000_000 });
      const c = await addVehicle(s);
      const e = valuationEvent(s, c.id, { valuationId: 'val-lost-1' });
      await publish(e);

      const r = await row(c.id);
      expect([r.valuationId, r.valuationSource, Number(r.marketValue), Number(r.haircutRate), Number(r.collateralValue), r.externalValuationRequired]).toEqual(['val-lost-1', 'INTERNAL', 30_000_000, 0.7, 21_000_000, false]);
      expect(r.valuedAt?.toISOString()).toBe('2026-10-28T01:00:00.000Z');
      expect(r.valuationValidUntil?.toISOString()).toBe('2027-01-26T01:00:00.000Z');
      expect(r.nextRevaluationAt?.toISOString().slice(0, 10)).toBe('2027-10-28');
      expect(r.valuationOverrideReason).toBeNull();
      expect((await events()).at(-1)).toMatchObject({ change: 'VALUED', collateralId: c.id });
      const audit = (await audits()).at(-1)!;
      expect(audit.action).toBe('COLLATERAL_VALUATION_SYNCED');
      expect(audit.actorId).toBeNull();
      expect(audit.correlationId).toBe('corr-event-1');
      const list = ok(await get(url(s.app.id)), 200, (b) => b as { items: Array<{ valuation: { collateralValue: number } | null }>; summary: { totalCollateralValue: number } });
      expect(list.items[0]!.valuation?.collateralValue).toBe(21_000_000);
      expect(list.summary.totalCollateralValue).toBe(21_000_000);
    });

    it('event нь G0-г бүрдүүлбэл 5-р алхам COMPLETED болно (ноорог хүсэлт)', async () => {
      const s = await seedScenario(prisma(), { amount: 10_000_000 });
      registerVehicle();
      const c = await addVehicle(s);
      await verifyOwnership(s, c.id); await checkEncumbrance(s, c.id);
      await attachAll(s, c.id, ['vehicle_certificate', 'traffic_registry_extract', 'insurance']);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');
      await publish(valuationEvent(s, c.id));
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('COMPLETED');
    });

    it('ACTIVE хүсэлтэд үнэлгээ хэрэглэгдэнэ, харин алхамд хүрэхгүй', async () => {
      const s = await seedScenario(prisma(), { amount: 10_000_000 });
      const done = await completeVehicle(s);
      await prisma().loanApplication.update({ where: { id: s.app.id }, data: { status: 'ACTIVE' } });
      await publish(valuationEvent(s, done.collateral.id, { marketValue: 10_000_000, collateralValue: 7_000_000, valuedAt: '2026-10-28T03:00:00.000Z' }));
      expect(Number((await row(done.collateral.id)).collateralValue)).toBe(7_000_000);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('COMPLETED');
    });

    it('ижил eventId дахин хүргэгдвэл (at-least-once) нэг л удаа боловсруулагдана', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      const e = valuationEvent(s, c.id);
      const before = await counts();
      await publish(e);
      const once = await counts();
      expect(once).toEqual({ events: before.events + 1, audits: before.audits + 1, processed: before.processed + 1 });
      await publish(e);
      await publish(e);
      expect(await counts()).toEqual(once);
      expect(await prisma().processedEvent.count({ where: { consumer: 'origination-collateral', eventId: e.eventId } })).toBe(1);
    });

    it('sync хариугаар аль хэдийн хэрэглэгдсэн үнэлгээ (valuationId адил) нь шинэ eventId-тай ирвэл өөрчлөлтгүй (DUPLICATE)', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      await value(s, c.id);
      const r = await row(c.id);
      const before = await counts();
      await publish(valuationEvent(s, c.id, { valuationId: r.valuationId as string, marketValue: 99, collateralValue: 69, valuedAt: later(5000) }));
      const after = await row(c.id);
      expect([Number(after.marketValue), after.valuationId]).toEqual([30_000_000, r.valuationId]);
      expect(await counts()).toEqual({ ...before, processed: before.processed + 1 });
    });

    it('барьцааны одоогийн үнэлгээнээс хуучин (valuedAt) event хэрэглэгдэхгүй (OLDER)', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      await publish(valuationEvent(s, c.id, { valuationId: 'new', valuedAt: '2026-10-28T01:00:00.000Z' }));
      await publish(valuationEvent(s, c.id, { valuationId: 'old', valuedAt: '2026-10-27T01:00:00.000Z', marketValue: 1, collateralValue: 1 }));
      expect((await row(c.id)).valuationId).toBe('new');
      await publish(valuationEvent(s, c.id, { valuationId: 'same-time', valuedAt: '2026-10-28T01:00:00.000Z', marketValue: 2, collateralValue: 2 }));
      expect((await row(c.id)).valuationId).toBe('new');
    });

    it('барьцаа event үүссэний дараа өөрчлөгдсөн (PATCH-ээр хүчингүй болсон) бол хоцорсон event үнэлгээг амилуулахгүй (SUPERSEDED)', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      const staleEvent = valuationEvent(s, c.id, { occurredAt: new Date(Date.now() - 60_000).toISOString() });
      mutation(await patch(url(s.app.id, c.id), { description: { ...vehicleDescription(), mileageKm: 130_000 } }));
      await publish(staleEvent);
      const r = await row(c.id);
      expect([r.valuationId, r.marketValue]).toEqual([null, null]);
    });

    it('үл мэдэгдэх барьцаа, өөр хүсэлтийн барьцаа, өөр байгууллага, хуучин хэлбэр (valuationId байхгүй) -> алдаагүй үл тоомсорлоно, marker үлдэнэ', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      const o = await seedScenario(prisma(), { registerNo: 'АБ12345678', product: s.product });
      const before = await counts();
      await publish(valuationEvent(s, randomUUID()));
      await publish(valuationEvent(o, c.id));
      await publish(valuationEvent(s, c.id, { orgId: 'other-org' }));
      await publish(valuationEvent(s, c.id, { valuationId: undefined }));
      await publish(valuationEvent(s, c.id, { source: undefined }));
      await publish(valuationEvent(s, c.id, { assetType: 'LAND' }));
      expect((await row(c.id)).valuationId).toBeNull();
      expect(await counts()).toEqual({ ...before, processed: before.processed + 6 });
    });

    it('handler алдаатай бол marker үлдэхгүй -> bus дахин хүргэхэд боловсруулагдана', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      const e = valuationEvent(s, c.id);
      const service = k.t.app.get(CollateralValuationService);
      vi.spyOn(service, 'handleValuationCompleted').mockRejectedValueOnce(new Error('db down'));
      await expect(publish(e)).rejects.toThrow('db down');
      expect(await prisma().processedEvent.count({ where: { eventId: e.eventId } })).toBe(0);
      expect((await row(c.id)).valuationId).toBeNull();
      await publish(e); // redelivery
      expect((await row(c.id)).valuationId).toBe(e.valuationId);
      expect(await prisma().processedEvent.count({ where: { eventId: e.eventId } })).toBe(1);
    });

    it('handleValuationCompleted шууд: хэрэглэсэн эсэхийг буцаана', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      const service = k.t.app.get(CollateralValuationService);
      const e = valuationEvent(s, c.id);
      expect(await prisma().$transaction((tx) => service.handleValuationCompleted(tx, e))).toBe(true);
      expect(await prisma().$transaction((tx) => service.handleValuationCompleted(tx, e))).toBe(false); // DUPLICATE
      expect(await prisma().$transaction((tx) => service.handleValuationCompleted(tx, valuationEvent(s, randomUUID())))).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('хувийн мэдээлэл (CLAUDE.md §6.5, NFR-5)', () => {
    let logged: string[] = [];
    const sink = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    const capture = () => {
      logged = [];
      Logger.overrideLogger({ log: sink, error: sink, warn: sink, debug: sink, verbose: sink, fatal: sink });
      const write = ((chunk: unknown) => { sink(String(chunk)); return true; }) as never;
      vi.spyOn(process.stdout, 'write').mockImplementation(write);
      vi.spyOn(process.stderr, 'write').mockImplementation(write);
      for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(sink);
    };
    afterEach(() => { Logger.overrideLogger(new ConsoleLogger()); });

    it('бүрэн урсгалын лог, аудит, outbox, хариу, хадгалсан шалгалтын JSON-д регистр, улсын дугаар, VIN, нэр, утас ОРОХГҮЙ', async () => {
      const s = await seedScenario(prisma(), { amount: 10_000_000 });
      await prisma().customer.update({ where: { id: s.owner.id }, data: { phone: '99111001' } });
      k.kyc.assets.set(REGISTER, {
        properties: [{ propertyId: 'P-BAD', certificateNo: null, assetType: 'APARTMENT', address: { province: 'УБ', district: 'СБД' } as never, areaM2: 999_999_999, floor: null, totalFloors: null, rooms: null, buildYear: null, purpose: null, landUse: null, owners: [{ registerNo: REGISTER, name: 'Бат Болд', sharePercent: 100 }] }],
        vehicles: [{ plateNo: '1234УБА', vin: 'VIN-SECRET-001', make: 'Toyota', model: 'Prius', manufactureYear: 2015, importYear: null, engineCc: null, fuelType: null, color: null }],
        fetchedAt: k.t.clock.now().toISOString(),
      });
      registerVehicle();
      capture();
      const bodies: string[] = [];
      const track = <T extends { text: string; status: number }>(res: T): T => { bodies.push(res.text); return res; };

      const cand = track(await get(`${url(s.app.id, 'xyp-assets')}?ownerCustomerId=${s.owner.id}`));
      expect(cand.status).toBe(200);
      expect(cand.text).not.toContain('sharePercent');
      const created = track(await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, source: 'XYP', xypRef: '1234УБА', description: { ...vehicleDescription('1234УБА'), vin: 'VIN-SECRET-001' } }));
      expect(created.status).toBe(201);
      const cid = created.body.collateral.id as string;
      track(await post(url(s.app.id, cid, 'ownership-check'), { method: 'REGISTRY' }));
      track(await post(url(s.app.id, cid, 'encumbrance-check'), { method: 'REGISTRY' }));
      track(await post(url(s.app.id, cid, 'valuation'), {}));
      track(await patch(url(s.app.id, cid), { registryNo: 'EB-1', note: 'x' }));
      track(await get(url(s.app.id)));
      track(await post(url(s.app.id, cid, 'valuation/suggest'), {}));
      // алдаа: ХУР унавал, давхар
      k.kyc.failWith = new DomainError('XYP_UNAVAILABLE', 'ХУР түр ажиллахгүй', 503);
      track(await get(`${url(s.app.id, 'xyp-assets')}?ownerCustomerId=${s.owner.id}`));
      k.kyc.failWith = null;
      track(await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription('1234УБА') }));
      await publish(valuationEvent(s, cid, { valuationId: 'v-late' }));

      const stored = {
        audit: await prisma().auditLog.findMany(),
        outbox: await prisma().outbox.findMany(),
        collateral: await prisma().collateral.findMany({ select: { ownershipCheckJson: true, encumbranceCheckJson: true, note: true, valuationOverrideReason: true } }),
      };
      const logs = logged.join('\n');
      const audit = JSON.stringify(stored.audit);
      const outbox = JSON.stringify(stored.outbox);
      const checks = JSON.stringify(stored.collateral);
      const responses = bodies.join('\n');
      const IDENTIFIERS = [REGISTER, '00000001', 'VIN-SECRET-001'];
      const PLATE = '1234УБА';
      const PERSON = ['Бат Болд', 'Болд', '99111001'];
      // 1) Регистр бүх хариу, лог, аудит, outbox, хадгалсан шалгалтад огт орохгүй (зөвхөн далдлагдсан хэлбэр)
      for (const [name, text] of Object.entries({ responses, logs, audit, outbox, checks })) for (const secret of IDENTIFIERS.filter((x) => name === 'responses' ? x === REGISTER || x === '00000001' : true)) expect([name, secret, text.includes(secret)]).toEqual([name, secret, false]);
      // 2) Лог, аудит, outbox: улсын дугаар, нэр, утас ч орохгүй. (Хадгалсан өмчлөлийн JSON нь гэрээгээр өмчлөгчийн нэрийг агуулна, улсын дугаар агуулахгүй.)
      for (const [name, text] of Object.entries({ logs, audit, outbox })) for (const secret of [PLATE, ...PERSON]) expect([name, secret, text.includes(secret)]).toEqual([name, secret, false]);
      expect(checks.includes(PLATE)).toBe(false);
      // 3) Ажилтны хариуд (барьцааны тодорхойлолт) улсын дугаар гарна, харин далдлагдсан өмчлөгчтэй
      expect(responses).toContain(PLATE);
      expect(logs).toContain('xyp assets skipped'); // логийн суваг ажиллаж байна: зөвхөн тоо бичигдсэн (хувийн мэдээлэлгүй)
      expect(JSON.stringify(stored.collateral)).toContain('УЕ****0001'); // далдлагдсан регистр
      expect((await prisma().auditLog.findMany({ where: { entity: 'COLLATERAL' } })).length).toBeGreaterThanOrEqual(5);
    });

    it('ХУР-ын candidate-д өмчлөгчийн регистр, нэр, эзлэх хувь орохгүй', async () => {
      const s = await seedScenario(prisma());
      k.kyc.assets.set(REGISTER, {
        properties: [{ propertyId: 'P-001', certificateNo: 'GER-1', assetType: 'APARTMENT', address: { province: 'Улаанбаатар', district: 'СБД' } as never, areaM2: 50, floor: null, totalFloors: null, rooms: null, buildYear: null, purpose: 'RESIDENTIAL', landUse: null, owners: [{ registerNo: REGISTER, name: 'Бат Болд', sharePercent: 50 }] }],
        vehicles: [], fetchedAt: k.t.clock.now().toISOString(),
      });
      const res = await get(`${url(s.app.id, 'xyp-assets')}?ownerCustomerId=${s.owner.id}`);
      expect(res.status).toBe(200);
      for (const secret of [REGISTER, 'Бат Болд', 'sharePercent', 'owners']) expect(res.text.includes(secret), secret).toBe(false);
      expect(res.body.items).toHaveLength(1);
    });
  });
});
