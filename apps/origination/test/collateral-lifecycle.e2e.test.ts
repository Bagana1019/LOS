import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollateralListResponse, CollateralMonitoringResponse, ValuationHistoryResponse } from '@los/contracts';
import { CollateralGateService } from '../src/modules/collateral/collateral-gate.service';
import { hasTestDb, resetDb, createCustomer, createBorrower, ORG } from '../src/test-utils/factories';
import {
  actors, bootCollateralKit, collateralApi, seedScenario, stepOf, url, vehicleDescription, type CollateralKit, type Scenario,
} from '../src/modules/collateral/testing/collateral-test-kit';

// Модуль 6 core · давхар барьцаа, зэрэгцээ хүсэлт, PATCH-ийн хүчингүйжүүлэлт, идэвхтэй зээлийн дахин үнэлгээ, ЭБ бүртгэл/чөлөөлөлт, мониторинг.
describe.skipIf(!hasTestDb)('collateral lifecycle (DB)', () => {
  let k: CollateralKit;
  const prisma = () => k.t.prisma;
  const { officer, post, get, patch, del, mutation, ok, codes, registerVehicle, addVehicle, value, events, audits, completeVehicle } = collateralApi(() => k);

  beforeAll(async () => { k = await bootCollateralKit(); });
  afterAll(async () => { await resetDb(prisma()); await k.close(); });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDb(prisma());
    k.kyc.reset(); k.valuation.reset(); k.files.reset();
    k.t.clock.set('2026-10-28T02:00:00Z');
  });

  /** Өөр хүсэлтийн (шууд DB-ээр) автомашины барьцаа. */
  const pledge = (appId: string, ownerId: string, plate: string, extra: Record<string, unknown> = {}) =>
    prisma().collateral.create({ data: { orgId: ORG, applicationId: appId, kind: 'MOVABLE', assetType: 'VEHICLE', ownerCustomerId: ownerId, descriptionJson: vehicleDescription(plate), assetKey: `VEHICLE:${plate}`, ...extra } });
  const other = (o: Parameters<typeof seedScenario>[1] = {}, registerNo = 'АБ12345678') => seedScenario(prisma(), { registerNo, ...o });
  const setStatus = (appId: string, status: string) => prisma().loanApplication.update({ where: { id: appId }, data: { status } });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('давхар барьцаа (FR-6.6)', () => {
    it('энэ хүсэлтэд аль хэдийн байгаа хөрөнгө (улсын дугаар тэмдэгтийн хэлбэр өөр ч) -> 409 COLLATERAL_DUPLICATE', async () => {
      const s = await seedScenario(prisma());
      await addVehicle(s, '1234УБА');
      for (const plate of ['1234УБА', '1234 уба', '1234-УБА']) {
        const res = await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription(plate) });
        expect([plate, res.status, res.body.code]).toEqual([plate, 409, 'COLLATERAL_DUPLICATE']);
      }
      expect(await prisma().collateral.count({ where: { applicationId: s.app.id } })).toBe(1);
    });

    it.each(['SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'DISBURSING', 'ACTIVE', 'MIGRATED'])('өөр %s хүсэлтэд барьцаалагдсан -> 409 COLLATERAL_ALREADY_PLEDGED (зөвхөн тэр хүсэлтийн дугаар)', async (status) => {
      const s = await seedScenario(prisma());
      const o = await other({ status, product: s.product });
      await pledge(o.app.id, o.owner.id, '1234УБА');
      const res = await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription('1234УБА') });
      expect([res.status, res.body.code]).toEqual([409, 'COLLATERAL_ALREADY_PLEDGED']);
      expect(res.body.details).toEqual({ applicationNos: [o.app.appNo] });
      expect(res.body.message).toContain(o.app.appNo);
      expect(await prisma().collateral.count({ where: { applicationId: s.app.id } })).toBe(0);
    });

    it.each(['CLOSED', 'CANCELLED', 'REJECTED'])('өөр %s (идэвхгүй) хүсэлтэд байсан хөрөнгө дахин барьцаалагдана', async (status) => {
      const s = await seedScenario(prisma());
      const o = await other({ status, product: s.product });
      await pledge(o.app.id, o.owner.id, '1234УБА');
      expect((await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription('1234УБА') })).status).toBe(201);
    });

    it('чөлөөлөгдсөн барьцаа (ACTIVE хүсэлтэд ч) дахин зөрчил үүсгэхгүй; чөлөөлөх хүртэл 409', async () => {
      const s = await seedScenario(prisma());
      const o = await other({ status: 'ACTIVE', product: s.product });
      const row = await pledge(o.app.id, o.owner.id, '1234УБА');
      const body = { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription('1234УБА') };
      expect((await post(url(s.app.id), body)).status).toBe(409);
      await prisma().collateral.update({ where: { id: row.id }, data: { releasedAt: new Date() } });
      expect((await post(url(s.app.id), body)).status).toBe(201);
    });

    it('өөр ноорог/буцаасан хүсэлтэд байвал хориглохгүй, IN_OTHER_DRAFT анхааруулгатай (хоёр талд); устгавал анхааруулга алга болно', async () => {
      const a = await seedScenario(prisma());
      const b = await other({ status: 'RETURNED', product: a.product });
      registerVehicle();
      const first = await addVehicle(a, '1234УБА');
      const res = mutation(await post(url(b.app.id), { assetType: 'VEHICLE', ownerCustomerId: b.owner.id, description: vehicleDescription('1234УБА') }), 201);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toMatchObject({ code: 'IN_OTHER_DRAFT', collateralId: res.collateral.id });
      expect(res.warnings[0]!.message).toContain(a.app.appNo);
      expect(res.gate.issues.map((i) => i.code)).not.toContain('DUPLICATE_PLEDGE');
      const listA = ok(await get(url(a.app.id)), 200, (x) => CollateralListResponse.parse(x));
      expect(listA.warnings.map((w) => [w.code, w.collateralId])).toEqual([['IN_OTHER_DRAFT', first.id]]);
      expect(listA.warnings[0]!.message).toContain(b.app.appNo);
      expect((await del(url(b.app.id, res.collateral.id))).status).toBe(204);
      expect(ok(await get(url(a.app.id)), 200, (x) => CollateralListResponse.parse(x)).warnings).toEqual([]);
    });

    it('G1 дахин шалгалт: нэг ноорог илгээгдэхэд (IN_APPROVAL) нөгөө ноорогийн G0-д DUPLICATE_PLEDGE гарч алхам PENDING болно; CollateralGateService.evaluate мөн адил', async () => {
      const a = await seedScenario(prisma(), { amount: 10_000_000 });
      const b = await other({ status: 'DRAFT', product: a.product });
      await completeVehicle(a);
      const bc = await pledge(b.app.id, b.owner.id, '1234УБА');
      expect(bc.assetKey).toBe('VEHICLE:1234УБА');
      expect((await stepOf(prisma(), a.app.id, 'collateral')).status).toBe('COMPLETED');

      await setStatus(b.app.id, 'IN_APPROVAL');
      const gate = k.t.app.get(CollateralGateService);
      const ev = await gate.evaluate(prisma(), ORG, a.app.id);
      expect(ev.gate.issues.map((i) => i.code)).toEqual(['DUPLICATE_PLEDGE']);
      expect(ev.gate.issues[0]!.details).toEqual({ applicationNos: [b.app.appNo] });
      expect(ev.gate.complete).toBe(false);

      const r = ok(await post(url(a.app.id, 'recheck')), 200, (x) => CollateralListResponse.parse(x));
      expect(codes(r)).toEqual(['DUPLICATE_PLEDGE']);
      expect((await stepOf(prisma(), a.app.id, 'collateral')).status).toBe('PENDING');
      expect(r.warnings).toEqual([]);
    });

    it('PATCH-ээр улсын дугаар солих: өөр идэвхтэй хүсэлтийн хөрөнгө рүү -> 409, энэ хүсэлтийн өөр барьцаа руу -> 409; мөр өөрчлөгдөхгүй', async () => {
      const s = await seedScenario(prisma());
      const o = await other({ status: 'APPROVED', product: s.product });
      await pledge(o.app.id, o.owner.id, '7777УБА');
      const a = await addVehicle(s, '1111УБА');
      await addVehicle(s, '2222УБА');
      const r1 = await patch(url(s.app.id, a.id), { description: vehicleDescription('7777УБА') });
      expect([r1.status, r1.body.code]).toEqual([409, 'COLLATERAL_ALREADY_PLEDGED']);
      const r2 = await patch(url(s.app.id, a.id), { description: vehicleDescription('2222УБА') });
      expect([r2.status, r2.body.code]).toEqual([409, 'COLLATERAL_DUPLICATE']);
      expect((await prisma().collateral.findUniqueOrThrow({ where: { id: a.id } })).assetKey).toBe('VEHICLE:1111УБА');
    });

    it('ЭБ-ийн бүртгэлийн дугаар (registry_no) өөр идэвхтэй хүсэлтэд -> 409 (нэмэх ба PATCH)', async () => {
      const s = await seedScenario(prisma());
      const o = await other({ status: 'DISBURSING', product: s.product });
      await pledge(o.app.id, o.owner.id, '7777УБА', { registryNo: 'EB-100' });
      const body = { assetType: 'EQUIPMENT', ownerCustomerId: s.owner.id, description: { name: 'Станок' }, registryNo: 'EB-100' };
      expect((await post(url(s.app.id), body)).body.code).toBe('COLLATERAL_ALREADY_PLEDGED');
      const c = ok(await post(url(s.app.id), { ...body, registryNo: undefined }), 201, (x) => mutationId(x));
      const r = await patch(url(s.app.id, c), { registryNo: 'EB-100' });
      expect([r.status, r.body.code]).toEqual([409, 'COLLATERAL_ALREADY_PLEDGED']);
      expect((await patch(url(s.app.id, c), { registryNo: 'EB-101' })).status).toBe(200);
    });
  });
  const mutationId = (b: unknown): string => (b as { collateral: { id: string } }).collateral.id;

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('зэрэгцээ хүсэлт (хүсэлтийн мөрийн FOR UPDATE, advisory lock)', () => {
    it('нэг хөрөнгийг нэг хүсэлтэд зэрэг 6 удаа нэмэх -> яг нэг 201, бусад 409 COLLATERAL_DUPLICATE; 1 мөр, 1 аудит, 1 event', async () => {
      const s = await seedScenario(prisma());
      const results = await Promise.all(Array.from({ length: 6 }, () => post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription('1234УБА') })));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([201, 409, 409, 409, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'COLLATERAL_DUPLICATE')).toBe(true);
      expect(await prisma().collateral.count({ where: { applicationId: s.app.id } })).toBe(1);
      expect(await audits()).toHaveLength(1);
      expect(await events()).toHaveLength(1);
    });

    it('5 өөр хөрөнгийг зэрэг нэмэх -> бүгд 201, deadlock/lost update байхгүй; event, аудит бүрэн; нийлбэр зөв', async () => {
      const s = await seedScenario(prisma());
      const plates = ['1111УБА', '2222УБА', '3333УБА', '4444УБА', '5555УБА'];
      const results = await Promise.all(plates.map((p) => post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription(p) })));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(await prisma().collateral.count({ where: { applicationId: s.app.id } })).toBe(5);
      expect(await events()).toHaveLength(5);
      expect(await audits()).toHaveLength(5);
      const list = ok(await get(url(s.app.id)), 200, (x) => CollateralListResponse.parse(x));
      expect(list.summary.count).toBe(5);
    });

    it('хоёр хүсэлтэд нэг ЭБ-ийн дугаар зэрэг бүртгэх -> яг нэг 200, нөгөө нь 409 REGISTRY_NO_IN_USE', async () => {
      const a = await seedScenario(prisma(), { status: 'APPROVED' });
      const b = await other({ status: 'APPROVED', product: a.product });
      const ca = await pledge(a.app.id, a.owner.id, '1111УБА');
      const cb = await pledge(b.app.id, b.owner.id, '2222УБА');
      const [ra, rb] = await Promise.all([
        post(url(a.app.id, ca.id, 'registry'), { registryNo: 'EB-500', registryDate: '2026-10-20' }),
        post(url(b.app.id, cb.id, 'registry'), { registryNo: 'EB-500', registryDate: '2026-10-20' }),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([200, 409]);
      expect([ra, rb].find((r) => r.status === 409)!.body.code).toBe('REGISTRY_NO_IN_USE');
      expect(await prisma().collateral.count({ where: { registryNo: 'EB-500' } })).toBe(1);
    });

    it('нэг барьцаанд өмчлөл + ачаалал + үнэлгээ + баримт зэрэг -> бүгд амжина, шалгалтууд хоорондоо дарагдахгүй (алдагдсан шинэчлэл байхгүй)', async () => {
      const s = await seedScenario(prisma());
      registerVehicle();
      const c = await addVehicle(s);
      kFiles('77777777-7777-4777-8777-777777777777');
      const [r1, r2, r3, r4] = await Promise.all([
        post(url(s.app.id, c.id, 'ownership-check'), { method: 'REGISTRY' }),
        post(url(s.app.id, c.id, 'encumbrance-check'), { method: 'REGISTRY' }),
        post(url(s.app.id, c.id, 'valuation'), {}),
        post(url(s.app.id, c.id, 'documents'), { checklistKey: 'insurance', fileId: '77777777-7777-4777-8777-777777777777' }),
      ]);
      expect([r1.status, r2.status, r3.status, r4.status], JSON.stringify([r1.body, r2.body, r3.body, r4.body])).toEqual([200, 200, 200, 201]);
      const row = await prisma().collateral.findUniqueOrThrow({ where: { id: c.id }, include: { documents: true } });
      expect(row.ownershipVerified).toBe(true);
      expect(row.encumbranceStatus).toBe('CLEAR');
      expect(Number(row.collateralValue)).toBe(21_000_000);
      expect(row.documents).toHaveLength(1);
      expect((await events()).map((e) => e.change).sort()).toEqual(['ADDED', 'DOCUMENT_CHANGED', 'ENCUMBRANCE_CHECKED', 'OWNERSHIP_CHECKED', 'VALUED']);
    });

    it('шалгалтын үед (гадны дуудлага) барьцаа өөрчлөгдвөл өмчлөл 409 COLLATERAL_CHANGED, хуучин үр дүн хадгалагдахгүй', async () => {
      const s = await seedScenario(prisma());
      registerVehicle();
      const c = await addVehicle(s);
      const original = k.valuation.lookupVehicle.bind(k.valuation);
      vi.spyOn(k.valuation, 'lookupVehicle').mockImplementation(async (ctx, plate) => {
        const res = await original(ctx, plate);
        await prisma().collateral.update({ where: { id: c.id }, data: { descriptionJson: { ...vehicleDescription(), model: 'Aqua' } } });
        return res;
      });
      const res = await post(url(s.app.id, c.id, 'ownership-check'), { method: 'REGISTRY' });
      expect([res.status, res.body.code]).toEqual([409, 'COLLATERAL_CHANGED']);
      expect((await prisma().collateral.findUniqueOrThrow({ where: { id: c.id } })).ownershipCheckJson).toBeNull();
    });
  });
  const kFiles = (id: string) => k.files.add({ id, name: 'insurance.pdf' });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('PATCH: хүчингүйжүүлэлт (FR-6.5, 6.6, FR-14)', () => {
    async function completed(over: Parameters<typeof seedScenario>[1] = {}) {
      const s = await seedScenario(prisma(), { amount: 10_000_000, ...over });
      const done = await completeVehicle(s);
      expect(done.gate.complete).toBe(true);
      return { s, cid: done.collateral.id };
    }

    it('тэмдэглэл, даатгал, ЭБ дугаар засахад шалгалт, үнэлгээ хүчингүй болохгүй; G0 хэвээр', async () => {
      const { s, cid } = await completed();
      const res = mutation(await patch(url(s.app.id, cid), { note: 'Эзэмшигч өөрчлөгдөөгүй', insuranceExpiresAt: '2027-05-01', registryNo: 'EB-1', registryDate: '2026-10-01' }));
      expect(res.gate.complete).toBe(true);
      expect(res.collateral).toMatchObject({ note: 'Эзэмшигч өөрчлөгдөөгүй', insuranceExpiresAt: '2027-05-01', registryNo: 'EB-1', registryDate: '2026-10-01' });
      expect(res.collateral.ownership?.status).toBe('VERIFIED');
      expect(res.collateral.valuation).not.toBeNull();
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('COMPLETED');
    });

    it('тодорхойлолт бодитоор өөрчлөгдвөл өмчлөл, ачаалал, үнэлгээ хүчингүй; баримт хэвээр; алхам PENDING; score STALE', async () => {
      const { s, cid } = await completed();
      await prisma().loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: s.app.id, stepKey: 'score' } }, data: { status: 'COMPLETED' } });
      const before = await prisma().outbox.count({ where: { type: 'CollateralChanged' } });
      const res = mutation(await patch(url(s.app.id, cid), { description: { ...vehicleDescription(), mileageKm: 100_000 } }));
      expect(res.collateral.ownership).toBeNull();
      expect(res.collateral.encumbrance).toBeNull();
      expect(res.collateral.valuation).toBeNull();
      expect(res.collateral.checklist.every((x) => x.satisfied)).toBe(true);
      expect(res.collateral.issues.map((i) => i.code)).toEqual(['OWNERSHIP_NOT_CHECKED', 'ENCUMBRANCE_NOT_CHECKED', 'NOT_VALUED']);
      const row = await prisma().collateral.findUniqueOrThrow({ where: { id: cid } });
      expect([row.ownershipVerified, row.ownershipCheckJson, row.encumbranceCheckJson, row.encumbranceStatus, row.valuationId, row.marketValue, row.collateralValue, row.valuedAt, row.nextRevaluationAt]).toEqual([false, null, null, null, null, null, null, null, null]);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');
      expect(await stepOf(prisma(), s.app.id, 'score')).toMatchObject({ status: 'STALE', staleReason: 'COLLATERAL_CHANGED' });
      expect(await prisma().outbox.count({ where: { type: 'CollateralChanged' } })).toBe(before + 1);
      const audit = (await audits()).at(-1)!;
      expect(audit.action).toBe('COLLATERAL_UPDATED');
      expect(audit.afterJson).toMatchObject({ changed: ['description'], invalidated: true });
    });

    it('өөрчлөлтгүй PATCH (ижил тодорхойлолт, ижил өмчлөгч, ижил тэмдэглэл) нь юу ч хийхгүй: event, аудит, updated_at өөрчлөгдөхгүй', async () => {
      const { s, cid } = await completed();
      const row = await prisma().collateral.findUniqueOrThrow({ where: { id: cid } });
      const counts = async () => [await prisma().outbox.count({ where: { type: 'CollateralChanged' } }), (await audits()).length];
      const before = await counts();
      const res = mutation(await patch(url(s.app.id, cid), { description: vehicleDescription(), ownerCustomerId: s.owner.id, note: null }));
      expect(res.gate.complete).toBe(true);
      expect(res.collateral.ownership?.status).toBe('VERIFIED');
      expect(await counts()).toEqual(before);
      expect((await prisma().collateral.findUniqueOrThrow({ where: { id: cid } })).updatedAt.getTime()).toBe(row.updatedAt.getTime());
    });

    it('улсын дугаар солигдвөл asset_key шинэчлэгдэж, ХУР-аас татсан тэмдэглэгээ (source=XYP, xypRef) арилна', async () => {
      const s = await seedScenario(prisma());
      const c = mutation(await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, source: 'XYP', xypRef: '1234УБА', description: vehicleDescription('1234УБА') }), 201).collateral;
      expect(c.source).toBe('XYP');
      const res = mutation(await patch(url(s.app.id, c.id), { description: vehicleDescription('9999УБА') }));
      expect(res.collateral).toMatchObject({ source: 'MANUAL' });
      const row = await prisma().collateral.findUniqueOrThrow({ where: { id: c.id } });
      expect([row.assetKey, row.xypRef]).toEqual(['VEHICLE:9999УБА', null]);
    });

    it('барьцаалагч солигдвөл хүчингүй; зөвхөн хүсэлтийн оролцогч руу', async () => {
      const { s, cid } = await completed();
      const pledgor = await createCustomer(prisma(), { registerNo: 'ЖИ00000002', lastName: 'Дорж', firstName: 'Сүх' });
      const rejected = await patch(url(s.app.id, cid), { ownerCustomerId: pledgor.id });
      expect([rejected.status, rejected.body.code]).toEqual([422, 'OWNER_NOT_ON_APPLICATION']);
      expect((await prisma().collateral.findUniqueOrThrow({ where: { id: cid } })).ownershipVerified).toBe(true);
      await createBorrower(prisma(), s.app.id, pledgor.id, 'PLEDGOR');
      const res = mutation(await patch(url(s.app.id, cid), { ownerCustomerId: pledgor.id }));
      expect(res.collateral.owner).toMatchObject({ customerId: pledgor.id, role: 'PLEDGOR' });
      expect(res.collateral.ownership).toBeNull();
      expect(res.collateral.valuation).toBeNull();
    });

    it('шинэ тодорхойлолт хөрөнгийн төрлийн схемд нийцэхгүй бол 400 VALIDATION_FAILED, мөр өөрчлөгдөхгүй', async () => {
      const { s, cid } = await completed();
      const res = await patch(url(s.app.id, cid), { description: { plateNo: '1234УБА', make: 'Toyota' } });
      expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect((await prisma().collateral.findUniqueOrThrow({ where: { id: cid } })).ownershipVerified).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('идэвхтэй зээлийн дахин үнэлгээ (FR-14.6)', () => {
    async function activeLoan() {
      const s = await seedScenario(prisma(), { amount: 10_000_000 });
      const done = await completeVehicle(s);
      await setStatus(s.app.id, 'ACTIVE');
      await prisma().loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: s.app.id, stepKey: 'score' } }, data: { status: 'COMPLETED' } });
      return { s, cid: done.collateral.id };
    }

    it('ACTIVE хүсэлтэд үнэлгээ хадгалагдана; LTV хэтэрсэн ч 5-р, score алхамд хүрэхгүй; түүх 2 мөр; дараагийн дахин үнэлгээ шинэчлэгдэнэ', async () => {
      const { s, cid } = await activeLoan();
      k.t.clock.set('2027-02-01T02:00:00Z');
      const res = await value(s, cid, { marketValue: 10_000_000, overrideReason: 'Зах зээл унасан' });
      expect(res.collateral.valuation).toMatchObject({ marketValue: 10_000_000, collateralValue: 7_000_000 });
      expect(res.gate.issues.map((i) => i.code)).toContain('LTV_EXCEEDED');
      expect(res.collateral.nextRevaluationAt).toBe('2028-02-01');
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('COMPLETED');
      expect((await stepOf(prisma(), s.app.id, 'score')).status).toBe('COMPLETED');
      const history = ok(await get(url(s.app.id, cid, 'valuations')), 200, (x) => ValuationHistoryResponse.parse(x));
      expect(history.items).toHaveLength(2);
      expect((await events()).at(-1)).toMatchObject({ change: 'VALUED', collateralId: cid });
    });

    it('ACTIVE хүсэлтэд гадны үнэлгээ, системийн санал боломжтой; бусад засвар 409', async () => {
      const { s, cid } = await activeLoan();
      expect((await post(url(s.app.id, cid, 'valuation/suggest'), {})).status).toBe(200);
      const reportFileId = '88888888-8888-4888-8888-888888888888';
      k.files.add({ id: reportFileId });
      const ext = mutation(await post(url(s.app.id, cid, 'valuation/external'), { appraiser: 'Үнэлгээ ХХК', valuedAt: '2026-10-27', marketValue: 25_000_000, reportFileId }));
      expect(ext.collateral.valuation).toMatchObject({ source: 'EXTERNAL_LICENSED', marketValue: 25_000_000 });
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('COMPLETED');
      for (const res of [
        await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription('5555УБА') }),
        await patch(url(s.app.id, cid), { note: 'x' }),
        await post(url(s.app.id, cid, 'ownership-check'), { method: 'REGISTRY' }),
        await del(url(s.app.id, cid)),
      ]) expect([res.status, res.body.code]).toEqual([409, 'APPLICATION_NOT_EDITABLE']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('ЭБ бүртгэл ба чөлөөлөлт (FR-6.9)', () => {
    async function withRow(status: string, o: Parameters<typeof seedScenario>[1] = {}) {
      const s = await seedScenario(prisma(), { status, ...o });
      return { s, row: await pledge(s.app.id, s.owner.id, '1234УБА') };
    }

    it('ЭБ бүртгэл зөвхөн APPROVED, DISBURSING, ACTIVE; бусад төлөвт 409 APPLICATION_NOT_APPROVED', async () => {
      for (const status of ['DRAFT', 'RETURNED', 'SUBMITTED', 'IN_APPROVAL', 'CLOSED', 'REJECTED']) {
        const { s, row } = await withRow(status, { registerNo: `АА${String(10000000 + Math.floor(Math.random() * 8e7))}` });
        const res = await post(url(s.app.id, row.id, 'registry'), { registryNo: 'EB-1', registryDate: '2026-10-01' });
        expect([status, res.status, res.body.code]).toEqual([status, 409, 'APPLICATION_NOT_APPROVED']);
      }
      for (const [i, status] of ['APPROVED', 'DISBURSING', 'ACTIVE'].entries()) {
        const { s, row } = await withRow(status, { registerNo: `АБ${String(20000000 + i)}` });
        const res = mutation(await post(url(s.app.id, row.id, 'registry'), { registryNo: `EB-OK-${i}`, registryDate: '2026-10-01' }));
        expect(res.collateral).toMatchObject({ registryNo: `EB-OK-${i}`, registryDate: '2026-10-01' });
      }
    });

    it('бүртгэл: event PLEDGE_REGISTERED, алхамд хүрэхгүй; давтан (ижил дугаар, огноо) no-op; өөр дугаарт шинэчилнэ; формат буруу 400', async () => {
      const { s, row } = await withRow('APPROVED');
      const first = mutation(await post(url(s.app.id, row.id, 'registry'), { registryNo: ' EB-9 ', registryDate: '2026-10-02' }));
      expect(first.collateral.registryNo).toBe('EB-9');
      expect((await events()).map((e) => e.change)).toEqual(['PLEDGE_REGISTERED']);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');
      mutation(await post(url(s.app.id, row.id, 'registry'), { registryNo: 'EB-9', registryDate: '2026-10-02' }));
      expect(await events()).toHaveLength(1);
      expect(await audits()).toHaveLength(1);
      mutation(await post(url(s.app.id, row.id, 'registry'), { registryNo: 'EB-10', registryDate: '2026-10-03' }));
      expect(await events()).toHaveLength(2);
      for (const body of [{ registryNo: 'EB-1', registryDate: '2026/10/02' }, { registryNo: '', registryDate: '2026-10-02' }, { registryNo: 'EB-1' }]) expect((await post(url(s.app.id, row.id, 'registry'), body)).status).toBe(400);
    });

    it('өөр ноорог хүсэлтийн барьцаанд бичигдсэн ЭБ-ийн дугаар APPROVED хүсэлтийн ЭБ бүртгэлийг хориглохгүй (зөвхөн хүлээн авсан хүсэлттэй давхцана)', async () => {
      const a = await withRow('APPROVED');
      const d = await other({ status: 'DRAFT', product: a.s.product });
      const cd = await pledge(d.app.id, d.owner.id, '7777УБА');
      await prisma().collateral.update({ where: { id: cd.id }, data: { registryNo: 'EB-88' } });
      const r = await post(url(a.s.app.id, a.row.id, 'registry'), { registryNo: 'EB-88', registryDate: '2026-10-01' });
      expect(r.status).toBe(200);
    });

    it('ижил ЭБ-ийн дугаар өөр барьцаанд бүртгэлтэй бол 409 REGISTRY_NO_IN_USE; тэр чөлөөлөгдсөний дараа боломжтой', async () => {
      const a = await withRow('ACTIVE');
      const b = await withRow('APPROVED', { registerNo: 'АБ12345678', product: a.s.product });
      await prisma().collateral.update({ where: { id: a.row.id }, data: { registryNo: 'EB-77', registryDate: new Date('2026-09-01T00:00:00Z') } });
      const body = { registryNo: 'EB-77', registryDate: '2026-10-01' };
      const r = await post(url(b.s.app.id, b.row.id, 'registry'), body);
      expect([r.status, r.body.code]).toEqual([409, 'REGISTRY_NO_IN_USE']);
      await prisma().collateral.update({ where: { id: a.row.id }, data: { releasedAt: new Date() } });
      expect((await post(url(b.s.app.id, b.row.id, 'registry'), body)).status).toBe(200);
    });

    it('чөлөөлсөн барьцаанд ЭБ бүртгэхгүй: 409 COLLATERAL_RELEASED', async () => {
      const { s, row } = await withRow('ACTIVE');
      await prisma().collateral.update({ where: { id: row.id }, data: { releasedAt: new Date() } });
      const r = await post(url(s.app.id, row.id, 'registry'), { registryNo: 'EB-1', registryDate: '2026-10-01' });
      expect([r.status, r.body.code]).toEqual([409, 'COLLATERAL_RELEASED']);
    });

    it('чөлөөлөлт зөвхөн CLOSED хүсэлтэд (бусад төлөвт 409 APPLICATION_NOT_CLOSED); event RELEASED; давтвал no-op', async () => {
      const { s, row } = await withRow('ACTIVE');
      const early = await post(url(s.app.id, row.id, 'release'));
      expect([early.status, early.body.code]).toEqual([409, 'APPLICATION_NOT_CLOSED']);
      await setStatus(s.app.id, 'CLOSED');
      k.t.clock.set('2026-12-01T02:00:00Z');
      const res = mutation(await post(url(s.app.id, row.id, 'release')));
      expect(res.collateral.releasedAt).toBe('2026-12-01T02:00:00.000Z');
      expect(res.warnings.map((w) => [w.code, w.collateralId])).toEqual([['RELEASED', row.id]]);
      expect((await events()).map((e) => e.change)).toEqual(['RELEASED']);
      k.t.clock.set('2026-12-02T02:00:00Z');
      const again = mutation(await post(url(s.app.id, row.id, 'release')));
      expect(again.collateral.releasedAt).toBe('2026-12-01T02:00:00.000Z');
      expect(await events()).toHaveLength(1);
      expect(await audits()).toHaveLength(1);
      // CLOSED хүсэлтийн 5-р алхамд хүрээгүй
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');
    });

    it('чөлөөлөлтөөс хойш хөрөнгийг өөр хүсэлтэд барьцаалах боломжтой (ACTIVE -> CLOSED + release)', async () => {
      const a = await withRow('ACTIVE');
      const b = await seedScenario(prisma(), { registerNo: 'АБ12345678', product: a.s.product });
      const body = { assetType: 'VEHICLE', ownerCustomerId: b.owner.id, description: vehicleDescription('1234УБА') };
      expect((await post(url(b.app.id), body)).status).toBe(409);
      await setStatus(a.s.app.id, 'CLOSED');
      mutation(await post(url(a.s.app.id, a.row.id, 'release')));
      expect((await post(url(b.app.id), body)).status).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('мониторинг (FR-6.9, FR-14.6)', () => {
    // clock: 2026-10-28 02:00Z = УБ 10:00 -> өнөөдөр 2026-10-28; withinDays=30 -> 2026-11-27 хүртэл
    async function activeApp(o: { officerId?: string; branchId?: string; amount?: number; registerNo?: string; product?: Scenario['product'] } = {}) {
      return seedScenario(prisma(), { status: 'ACTIVE', amount: o.amount ?? 10_000_000, withSteps: false, ...o });
    }
    const addRow = (s: Scenario, plate: string, o: { next?: string | null; insurance?: string | null; value?: number | null; released?: boolean } = {}) =>
      pledge(s.app.id, s.owner.id, plate, {
        nextRevaluationAt: o.next ? new Date(`${o.next}T00:00:00Z`) : null, insuranceExpiresAt: o.insurance ? new Date(`${o.insurance}T00:00:00Z`) : null,
        collateralValue: o.value === null ? null : (o.value ?? 21_000_000), marketValue: o.value === null ? null : ((o.value ?? 21_000_000) / 0.7), ...(o.released ? { releasedAt: new Date() } : {}),
      });
    const monitor = async (actor: Record<string, string> = officer, query = '') => ok(await get(`/api/collaterals/monitoring${query}`, actor), 200, (x) => CollateralMonitoringResponse.parse(x));
    const summary = (r: { items: Array<{ collateralId: string; reasons: string[] }> }) => Object.fromEntries(r.items.map((i) => [i.collateralId, i.reasons]));

    it('шалтгаан бүр: дахин үнэлэх, даатгал дууссан, даатгал дуусах, LTV хэтэрсэн; эрүүл ба чөлөөлсөн, ACTIVE биш орохгүй; эрэмбэ', async () => {
      const a = await activeApp({ registerNo: 'АА00000001' });
      const b = await activeApp({ registerNo: 'АА00000002', product: a.product });
      const c = await activeApp({ registerNo: 'АА00000003', product: a.product });
      const d = await activeApp({ registerNo: 'АА00000004', product: a.product, amount: 50_000_000 });
      const e = await activeApp({ registerNo: 'АА00000005', product: a.product });
      const f = await activeApp({ registerNo: 'АА00000006', product: a.product });
      const g = await seedScenario(prisma(), { status: 'APPROVED', registerNo: 'АА00000007', product: a.product, withSteps: false });
      const rA = await addRow(a, '1111УБА', { next: '2026-11-20' });
      const rB = await addRow(b, '2222УБА', { next: '2027-03-01', insurance: '2026-10-01' });
      const rC = await addRow(c, '3333УБА', { insurance: '2026-11-05' });
      const rD = await addRow(d, '4444УБА', { next: '2026-12-01' });
      await addRow(e, '5555УБА', { next: '2027-06-01', insurance: '2027-06-01' });
      await addRow(f, '6666УБА', { next: '2026-10-01', insurance: '2026-10-01', released: true });
      await addRow(g, '7777УБА', { next: '2026-10-01' });

      const res = await monitor();
      expect(summary(res)).toEqual({ [rA.id]: ['REVALUATION_DUE'], [rB.id]: ['INSURANCE_EXPIRED'], [rC.id]: ['INSURANCE_EXPIRING'], [rD.id]: ['LTV_BREACH'] });
      expect(res.asOf).toBe('2026-10-28T02:00:00.000Z');
      // эрэмбэ: дахин үнэлэх огноо ойр нь эхэнд, огноогүй нь сүүлд
      expect(res.items.map((i) => i.collateralId)).toEqual([rA.id, rD.id, rB.id, rC.id]);
      const dItem = res.items.find((i) => i.collateralId === rD.id)!;
      expect(dItem).toMatchObject({ appNo: d.app.appNo, assetType: 'VEHICLE', ltvLimit: 0.7, nextRevaluationAt: '2026-12-01' });
      expect(dItem.ltv).toBeCloseTo(50_000_000 / 21_000_000, 6);
      expect(dItem.label).toBe('Toyota Prius · 2015 · 4444УБА');
      expect(res.items.find((i) => i.collateralId === rA.id)).toMatchObject({ ltv: expect.any(Number), nextRevaluationAt: '2026-11-20', insuranceExpiresAt: null });
    });

    it('withinDays: 0 -> зөвхөн өнөөдрийн/өнгөрсөн; том утга -> холын хугацаа; буруу утга 400', async () => {
      const a = await activeApp();
      const r1 = await addRow(a, '1111УБА', { next: '2026-10-28' });
      const r2 = await addRow(a, '2222УБА', { next: '2027-03-01' });
      expect(Object.keys(summary(await monitor(officer, '?withinDays=0')))).toEqual([r1.id]);
      expect(Object.keys(summary(await monitor(officer, '?withinDays=400'))).sort()).toEqual([r1.id, r2.id].sort());
      expect(Object.keys(summary(await monitor(officer, '?withinDays=30')))).toEqual([r1.id]);
      for (const q of ['?withinDays=-1', '?withinDays=abc', '?withinDays=99999']) expect((await get(`/api/collaterals/monitoring${q}`)).status).toBe(400);
    });

    it('хүрээ (NFR-3): ЗЭЗ өөрийн, салбарын захирал өөрийн салбар, батлагч/админ бүгд; CUSTOMER 403', async () => {
      const mine = await activeApp({ officerId: 'officer-1', branchId: 'branch-1' });
      const theirs = await activeApp({ officerId: 'officer-2', branchId: 'branch-2', registerNo: 'АА00000002', product: mine.product });
      const sameBranch = await activeApp({ officerId: 'officer-3', branchId: 'branch-1', registerNo: 'АА00000003', product: mine.product });
      const r1 = await addRow(mine, '1111УБА', { next: '2026-10-30' });
      const r2 = await addRow(theirs, '2222УБА', { next: '2026-10-30' });
      const r3 = await addRow(sameBranch, '3333УБА', { next: '2026-10-30' });
      const ids = async (actor: Record<string, string>) => Object.keys(summary(await monitor(actor))).sort();
      expect(await ids(actors.officer('officer-1', 'branch-1'))).toEqual([r1.id]);
      expect(await ids(actors.officer('officer-2', 'branch-2'))).toEqual([r2.id]);
      expect(await ids(actors.branchManager('bm', 'branch-1'))).toEqual([r1.id, r3.id].sort());
      expect(await ids(actors.branchManager('bm', 'branch-2'))).toEqual([r2.id]);
      expect(await ids(actors.approver())).toEqual([r1.id, r2.id, r3.id].sort());
      expect(await ids(actors.admin())).toEqual([r1.id, r2.id, r3.id].sort());
      expect((await get('/api/collaterals/monitoring', actors.customer(mine.owner.id))).status).toBe(403);
      expect((await get('/api/collaterals/monitoring', actors.anonymous())).status).toBe(401);
    });

    it('өөр байгууллагын барьцаа харагдахгүй', async () => {
      const a = await activeApp();
      await addRow(a, '1111УБА', { next: '2026-10-30' });
      await prisma().collateral.updateMany({ where: { applicationId: a.app.id }, data: { orgId: 'other-org' } });
      expect((await monitor()).items).toEqual([]);
    });

    it('үнэлгээгүй ACTIVE зээл (LTV тооцох боломжгүй) LTV_BREACH өгөхгүй', async () => {
      const a = await activeApp({ amount: 50_000_000 });
      await addRow(a, '1111УБА', { value: null, next: '2026-10-30' });
      const res = await monitor();
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({ reasons: ['REVALUATION_DUE'], ltv: null });
    });
  });
});
