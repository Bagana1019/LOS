import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CollateralListResponse, CollateralCandidatesResponse, ValuationHistoryResponse,
} from '@los/contracts';
import { hasTestDb, resetDb, createCustomer, createBorrower, createApplication, ORG } from '../src/test-utils/factories';
import {
  actors, apartmentDescription, apartmentProperty, bootCollateralKit, collateralApi, REGISTER, seedScenario, stepOf, url, vehicleDescription, type CollateralKit,
} from '../src/modules/collateral/testing/collateral-test-kit';

// Модуль 6 core · барьцаа HTTP түвшний integration тест (supertest + бодит Postgres, портууд fake). docs/05 §3.1, §6; docs/04 M6 AC.
describe.skipIf(!hasTestDb)('collateral API (DB)', () => {
  let k: CollateralKit;
  const officer = actors.officer();
  const prisma = () => k.t.prisma;

  beforeAll(async () => { k = await bootCollateralKit(); });
  afterAll(async () => { await resetDb(prisma()); await k.close(); });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDb(prisma());
    k.kyc.reset(); k.valuation.reset(); k.files.reset();
    k.t.clock.set('2026-10-28T02:00:00Z');
  });

  // ── туслахууд ────────────────────────────────────────────────────────────────────────
  const { post, get, ok, mutation, codes, registerVehicle, addVehicle, verifyOwnership, checkEncumbrance, value, attachAll, events, audits, completeVehicle } = collateralApi(() => k);

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('бүрэн зам (FR-6.1 -> FR-6.7 -> G0)', () => {
    it('ХУР -> нэмэх -> өмчлөл -> ачаалал -> үнэлгээ -> баримт -> G0 хангагдаж 5-р алхам COMPLETED', async () => {
      const s = await seedScenario(prisma(), { amount: 10_000_000 });
      k.kyc.assets.set(REGISTER, { properties: [], vehicles: [{ plateNo: '1234УБА', vin: null, make: 'Toyota', model: 'Prius', manufactureYear: 2015, importYear: 2018, engineCc: 1800, fuelType: 'HYBRID', color: null }], fetchedAt: k.t.clock.now().toISOString() });
      registerVehicle();

      // FR-6.3 ХУР-ын candidate
      const cand = ok(await get(`${url(s.app.id, 'xyp-assets')}?ownerCustomerId=${s.owner.id}`), 200, (b) => CollateralCandidatesResponse.parse(b));
      expect(cand.items).toHaveLength(1);
      expect(cand.items[0]).toMatchObject({ assetType: 'VEHICLE', xypRef: '1234УБА', alreadyPledged: false });
      expect(k.kyc.calls.filter((c) => c.op === 'assets')).toHaveLength(1);

      // нэмэх (candidate-ийн description-аар)
      const created = mutation(await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, source: 'XYP', xypRef: cand.items[0]!.xypRef, description: { ...cand.items[0]!.description, mileageKm: 90_000 } }), 201);
      const cid = created.collateral.id;
      expect(created.collateral).toMatchObject({ kind: 'MOVABLE', assetType: 'VEHICLE', source: 'XYP', owner: { customerId: s.owner.id, role: 'PRIMARY', displayName: 'Бат Болд' } });
      expect(codes(created)).toEqual(['OWNERSHIP_NOT_CHECKED', 'ENCUMBRANCE_NOT_CHECKED', 'CHECKLIST_INCOMPLETE', 'NOT_VALUED']);
      expect(created.gate.complete).toBe(false);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');

      // FR-6.5 өмчлөл
      const own = await verifyOwnership(s, cid);
      expect(own.collateral.ownership).toMatchObject({ status: 'VERIFIED', method: 'REGISTRY', source: 'ATUT', owners: [{ matchedCustomerId: s.owner.id, role: 'PRIMARY', registerMasked: 'УЕ****0001' }] });
      expect(JSON.stringify(own)).not.toContain(REGISTER);

      // FR-6.6 ачаалал
      const enc = await checkEncumbrance(s, cid);
      expect(enc.collateral.encumbrance).toMatchObject({ status: 'CLEAR', method: 'REGISTRY' });
      expect(enc.collateral.encumbrance?.sources.map((x) => x.source).sort()).toEqual(['EB', 'ZMS']);

      // FR-14: санал -> хадгалах
      const suggest = ok(await post(url(s.app.id, cid, 'valuation/suggest'), { mileageKm: 90_000 }), 200, (b) => b as { suggestion: { marketValue: number }; haircut: { rate: number } });
      expect(suggest.suggestion.marketValue).toBe(30_000_000);
      expect(suggest.haircut.rate).toBe(0.7);
      const valued = await value(s, cid, { mileageKm: 90_000 });
      expect(valued.collateral.valuation).toMatchObject({ source: 'INTERNAL', marketValue: 30_000_000, haircutRate: 0.7, collateralValue: 21_000_000, expired: false, externalRequired: false, externalSatisfied: true });
      expect(valued.summary).toMatchObject({ count: 1, totalMarketValue: 30_000_000, totalCollateralValue: 21_000_000, loanAmount: 10_000_000, ltvLimit: 0.7, ltvPass: true });
      expect(valued.summary.ltv).toBeCloseTo(10_000_000 / 21_000_000, 6);
      expect((await prisma().collateral.findUniqueOrThrow({ where: { id: cid } })).nextRevaluationAt?.toISOString().slice(0, 10)).toBe('2027-10-28'); // + 365 хоног
      expect(valued.collateral.nextRevaluationAt).toBe('2027-10-28');

      // FR-6.7 баримт: нэг нэгээр нэмэхэд checklist-ийн satisfied, сүүлд G0
      const noDocs = await get(url(s.app.id));
      expect(codes(CollateralListResponse.parse(noDocs.body))).toEqual(['CHECKLIST_INCOMPLETE']);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');
      const done = await attachAll(s, cid, ['vehicle_certificate', 'traffic_registry_extract', 'insurance']);
      expect(done.gate).toMatchObject({ complete: true, skipped: false, issues: [] });
      expect(done.collateral.checklist.map((c) => `${c.key}:${c.satisfied}`)).toEqual(['vehicle_certificate:true', 'traffic_registry_extract:true', 'insurance:true']);
      expect(done.collateral.checklist[0]).toMatchObject({ label: 'Тээврийн хэрэгслийн гэрчилгээ', required: true });

      const step = await stepOf(prisma(), s.app.id, 'collateral');
      expect(step.status).toBe('COMPLETED');
      expect(step.completedAt).not.toBeNull();
      // 5-аас хойших алхмуудад хүрээгүй
      expect((await stepOf(prisma(), s.app.id, 'score')).status).toBe('LOCKED');

      // GET нь мутацийн хариутай нийцнэ
      const list = ok(await get(url(s.app.id)), 200, (b) => CollateralListResponse.parse(b));
      expect(list.gate.complete).toBe(true);
      expect(list.items[0]!.issues).toEqual([]);
      expect(list.items).toHaveLength(1);
      expect(list.warnings).toEqual([]);

      // valuation history
      const hist = ok(await get(url(s.app.id, cid, 'valuations')), 200, (b) => ValuationHistoryResponse.parse(b));
      expect(hist.items).toHaveLength(1);

      // outbox: CollateralChanged дараалал, нэг л удаа бүрийн мутацид
      expect((await events()).map((e) => e.change)).toEqual(['ADDED', 'OWNERSHIP_CHECKED', 'ENCUMBRANCE_CHECKED', 'VALUED', 'DOCUMENT_CHANGED', 'DOCUMENT_CHANGED', 'DOCUMENT_CHANGED']);
      expect((await events()).every((e) => e.applicationId === s.app.id && e.collateralId === cid && e.assetType === 'VEHICLE')).toBe(true);
      expect((await audits()).map((a) => a.action)).toEqual([
        'COLLATERAL_CREATED', 'COLLATERAL_OWNERSHIP_CHECKED', 'COLLATERAL_ENCUMBRANCE_CHECKED', 'COLLATERAL_VALUED', 'COLLATERAL_DOCUMENT_ATTACHED', 'COLLATERAL_DOCUMENT_ATTACHED', 'COLLATERAL_DOCUMENT_ATTACHED',
      ]);
    });

    it('үл хөдлөх (орон сууц): ХУР-ын өмчлөх эрхээр өмчлөл, ХУР-ын candidate-ээс бүртгэсэн ачаалал', async () => {
      const s = await seedScenario(prisma(), { amount: 20_000_000 });
      k.kyc.properties.set('P-001', apartmentProperty('P-001', [{ registerNo: REGISTER, name: 'Бат Болд' }]));
      const c = mutation(await post(url(s.app.id), { assetType: 'APARTMENT', ownerCustomerId: s.owner.id, description: apartmentDescription('P-001') }), 201).collateral;
      expect(c.kind).toBe('IMMOVABLE');
      const own = await verifyOwnership(s, c.id);
      expect(own.collateral.ownership).toMatchObject({ status: 'VERIFIED', source: 'XYP' });
      expect(k.kyc.calls.some((x) => x.op === 'property' && x.arg === 'P-001')).toBe(true);
      const enc = await checkEncumbrance(s, c.id);
      expect(enc.collateral.encumbrance?.status).toBe('CLEAR');
      expect(k.kyc.calls.find((x) => x.op === 'encumbrance')?.arg).toEqual({ assetType: 'APARTMENT', identifier: 'P-001' });
      const valued = await value(s, c.id);
      expect(valued.collateral.valuation).toMatchObject({ marketValue: 30_000_000, haircutRate: 0.8, collateralValue: 24_000_000 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('docs/04 Модуль 6 AC', () => {
    it('AC1: зах зээл 30,000,000 x haircut 0.7 = 21,000,000', async () => {
      const s = await seedScenario(prisma());
      registerVehicle();
      const c = await addVehicle(s);
      expect((await value(s, c.id)).collateral.valuation?.collateralValue).toBe(21_000_000);
    });

    it('AC2: LTV 50M/21M > 70% -> LTV_EXCEEDED, 5-р алхам бүрдэхгүй (PENDING)', async () => {
      const s = await seedScenario(prisma(), { amount: 50_000_000 });
      const done = await completeVehicle(s);
      expect(codes(done)).toEqual(['LTV_EXCEEDED']);
      expect(done.gate.complete).toBe(false);
      expect(done.summary).toMatchObject({ ltvPass: false, ltvLimit: 0.7 });
      expect(done.gate.issues[0]!.message).toContain('70%');
      const step = await stepOf(prisma(), s.app.id, 'collateral');
      expect(step.status).toBe('PENDING');
      expect(step.completedAt).toBeNull();
    });

    it('AC2b: LTV яг дээд хязгаарт (14,700,000 / 21,000,000 = 70%) хангана; зээлийн дүн нэмэгдвэл recheck-ээр алхам буцаж PENDING', async () => {
      const s = await seedScenario(prisma(), { amount: 14_700_000 });
      expect((await completeVehicle(s)).gate.complete).toBe(true);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('COMPLETED');
      // Модуль 5: зээлийн дүн нэмэгдэв
      await prisma().loanApplication.update({ where: { id: s.app.id }, data: { amount: 14_700_001 } });
      const r = ok(await post(url(s.app.id, 'recheck')), 200, (b) => CollateralListResponse.parse(b));
      expect(codes(r)).toEqual(['LTV_EXCEEDED']);
      const step = await stepOf(prisma(), s.app.id, 'collateral');
      expect(step.status).toBe('PENDING');
      expect(step.completedAt).toBeNull();
      // идемпотент: дахин recheck -> өөр аудит нэмэгдэхгүй
      const before = await prisma().auditLog.count({ where: { entity: 'COLLATERAL_GATE' } });
      expect(before).toBe(1);
      await post(url(s.app.id, 'recheck'));
      expect(await prisma().auditLog.count({ where: { entity: 'COLLATERAL_GATE' } })).toBe(before);
    });

    it('AC3: өмчлөгч өөр регистр -> OWNER_NOT_ON_APPLICATION, "Барьцаалагч бүртгэнэ үү"', async () => {
      const s = await seedScenario(prisma());
      registerVehicle('1234УБА', 'ЖИ00000002'); // АТҮТ-д өөр хүн
      const c = await addVehicle(s);
      const res = await verifyOwnership(s, c.id);
      expect(res.collateral.ownership).toMatchObject({ status: 'OWNER_NOT_ON_APPLICATION', owners: [{ matchedCustomerId: null, role: null }] });
      expect(res.collateral.ownership?.message).toContain('Барьцаалагч бүртгэнэ үү');
      expect(res.collateral.issues.map((i) => i.code)).toContain('OWNER_NOT_ON_APPLICATION');
      expect(res.collateral.issues.find((i) => i.code === 'OWNER_NOT_ON_APPLICATION')?.message).toContain('Барьцаалагч бүртгэнэ үү');
      expect((await prisma().collateral.findUniqueOrThrow({ where: { id: c.id } })).ownershipVerified).toBe(false);
    });

    it('AC3b: бүртгэлийн өмчлөгч хүсэлтэд PLEDGOR-оор бүртгэгдсэн бол сонгосон барьцаалагч нь таарвал VERIFIED, таараагүй бол OWNER_MISMATCH', async () => {
      const s = await seedScenario(prisma());
      const pledgor = await createCustomer(prisma(), { registerNo: 'ЖИ00000002', lastName: 'Дорж', firstName: 'Сүх' });
      await createBorrower(prisma(), s.app.id, pledgor.id, 'PLEDGOR');
      registerVehicle('1234УБА', 'ЖИ00000002');
      const mismatch = await addVehicle(s); // барьцаалагч = үндсэн зээлдэгч, АТҮТ-ийн өмчлөгч = PLEDGOR
      expect((await verifyOwnership(s, mismatch.id)).collateral.ownership?.status).toBe('OWNER_MISMATCH');
      const fixed = mutation(await k.http().patch(url(s.app.id, mismatch.id)).set(officer).send({ ownerCustomerId: pledgor.id }));
      expect(fixed.collateral.owner).toMatchObject({ customerId: pledgor.id, role: 'PLEDGOR' });
      expect((await verifyOwnership(s, mismatch.id)).collateral.ownership?.status).toBe('VERIFIED');
    });

    it('AC4: checklist дутуу -> CHECKLIST_INCOMPLETE, алхам PENDING', async () => {
      const s = await seedScenario(prisma());
      registerVehicle();
      const c = await addVehicle(s);
      await verifyOwnership(s, c.id); await checkEncumbrance(s, c.id); await value(s, c.id);
      const partial = await attachAll(s, c.id, ['vehicle_certificate', 'insurance']);
      expect(codes(partial)).toEqual(['CHECKLIST_INCOMPLETE']);
      expect(partial.gate.issues[0]!.details).toEqual({ missing: ['traffic_registry_extract'] });
      expect(partial.collateral.checklist.find((x) => x.key === 'traffic_registry_extract')).toMatchObject({ satisfied: false, documents: [] });
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');
    });

    it('AC5: ижил registry_no-той хөрөнгө өөр идэвхтэй хүсэлтэд -> 409', async () => {
      const s = await seedScenario(prisma());
      const other = await seedScenario(prisma(), { status: 'IN_APPROVAL', registerNo: 'АБ12345678', product: s.product });
      await prisma().collateral.create({ data: { orgId: ORG, applicationId: other.app.id, kind: 'MOVABLE', assetType: 'EQUIPMENT', ownerCustomerId: other.owner.id, descriptionJson: { name: 'Станок' }, registryNo: 'EB-777' } });
      const res = await post(url(s.app.id), { assetType: 'EQUIPMENT', ownerCustomerId: s.owner.id, description: { name: 'Өөр станок' }, registryNo: 'EB-777' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'COLLATERAL_ALREADY_PLEDGED' });
      expect(res.body.details).toEqual({ applicationNos: [other.app.appNo] });
      expect(await prisma().collateral.count({ where: { applicationId: s.app.id } })).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('G0 тоглолт: барьцаагүй бүтээгдэхүүн, бүтээгдэхүүнгүй хүсэлт (FR-6.4)', () => {
    it('барьцаа шаардахгүй бүтээгдэхүүн + барьцаа алга: skipped, 5-р алхам COMPLETED (recheck)', async () => {
      const s = await seedScenario(prisma(), { productOver: { requiresCollateral: false } });
      const r = ok(await post(url(s.app.id, 'recheck')), 200, (b) => CollateralListResponse.parse(b));
      expect(r.gate).toMatchObject({ complete: true, skipped: true, issues: [] });
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('COMPLETED');
      expect(r.summary.requiresCollateral).toBe(false);
    });

    it('барьцаа шаардах бүтээгдэхүүн + барьцаа алга: NO_COLLATERAL; бүтээгдэхүүн сонгоогүй: PRODUCT_MISSING', async () => {
      const s = await seedScenario(prisma());
      expect(codes(ok(await get(url(s.app.id)), 200, (b) => CollateralListResponse.parse(b)))).toEqual(['NO_COLLATERAL']);
      const noProduct = await createApplication(prisma(), {});
      await createBorrower(prisma(), noProduct.id, s.owner.id, 'PRIMARY');
      expect(codes(ok(await get(url(noProduct.id)), 200, (b) => CollateralListResponse.parse(b)))).toEqual(['PRODUCT_MISSING']);
    });

    it('барьцааг устгавал gate дахин тооцогдож COMPLETED алхам PENDING болно, score STALE', async () => {
      const s = await seedScenario(prisma(), { amount: 10_000_000 });
      await prisma().loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: s.app.id, stepKey: 'score' } }, data: { status: 'COMPLETED' } });
      const done = await completeVehicle(s);
      expect(done.gate.complete).toBe(true);
      // барьцаа нэмэх/үнэлэх нь COMPLETED score-г STALE болгосон
      expect(await stepOf(prisma(), s.app.id, 'score')).toMatchObject({ status: 'STALE', staleReason: 'COLLATERAL_CHANGED' });
      const del = await k.http().delete(url(s.app.id, done.collateral.id)).set(officer);
      expect(del.status).toBe(204);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');
      expect(await prisma().collateralDocument.count()).toBe(0); // cascade
      expect((await events()).at(-1)).toMatchObject({ change: 'REMOVED', collateralId: done.collateral.id });
    });

    it('өмчлөл/ачааллын шалгалт COMPLETED score-г STALE болгохгүй (зөвхөн бүрдэл, үнэлгээ)', async () => {
      const s = await seedScenario(prisma());
      registerVehicle();
      const c = await addVehicle(s);
      await prisma().loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: s.app.id, stepKey: 'score' } }, data: { status: 'COMPLETED' } });
      await verifyOwnership(s, c.id);
      await checkEncumbrance(s, c.id);
      expect((await stepOf(prisma(), s.app.id, 'score')).status).toBe('COMPLETED');
      await value(s, c.id);
      expect((await stepOf(prisma(), s.app.id, 'score')).status).toBe('STALE');
    });

    it('LOCKED 5-р алхамд хүрэхгүй (Модуль 2 нээгээгүй)', async () => {
      const s = await seedScenario(prisma(), { withSteps: false });
      await prisma().loanApplicationStep.create({ data: { orgId: ORG, applicationId: s.app.id, stepKey: 'collateral', status: 'LOCKED' } });
      await completeVehicle(s);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('LOCKED');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('өмчлөл ба ачаалал: шалгалтын дүрмүүд (FR-6.5, FR-6.6, FR-6.8)', () => {
    it('ачаалал: сүүлийн цифр 7 -> ENCUMBERED, 9 -> ENCUMBRANCE_DISPUTED (шалгалт хадгалагдана, G0 хангагдахгүй)', async () => {
      const s = await seedScenario(prisma(), { amount: 5_000_000 });
      const enc = mutation(await post(url(s.app.id), { assetType: 'EQUIPMENT', ownerCustomerId: s.owner.id, description: { name: 'Станок', serialNo: 'SN-007' } }), 201).collateral;
      const r1 = await checkEncumbrance(s, enc.id);
      expect(r1.collateral.encumbrance).toMatchObject({ status: 'ENCUMBERED', sources: expect.arrayContaining([expect.objectContaining({ source: 'ZMS', pledgee: 'Жишээ ББСБ' })]) });
      expect(r1.collateral.issues.map((i) => i.code)).toContain('ENCUMBERED');
      const dis = mutation(await post(url(s.app.id), { assetType: 'EQUIPMENT', ownerCustomerId: s.owner.id, description: { name: 'Өөр', serialNo: 'SN-009' } }), 201).collateral;
      expect((await checkEncumbrance(s, dis.id)).collateral.issues.map((i) => i.code)).toContain('ENCUMBRANCE_DISPUTED');
    });

    it('ачаалал шалгах эх сурвалж унавал (fail closed) шалгалт хадгалагдахгүй, алдаа дамжина', async () => {
      const { DomainError } = await import('@los/nest-common');
      const s = await seedScenario(prisma());
      registerVehicle();
      const c = await addVehicle(s);
      k.kyc.failWith = new DomainError('ENCUMBRANCE_UNAVAILABLE', 'ЗМС холбогдохгүй байна', 503);
      const res = await post(url(s.app.id, c.id, 'encumbrance-check'), { method: 'REGISTRY' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ENCUMBRANCE_UNAVAILABLE');
      const row = await prisma().collateral.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.encumbranceStatus).toBeNull();
      expect(row.encumbranceCheckJson).toBeNull();
    });

    it('DECLARED: бүртгэлтэй хөрөнгөд (автомашин) 422 DECLARED_NOT_ALLOWED; бүртгэлгүй (тоног төхөөрөмж ачаалал, мал өмчлөл) зөвшөөрнө', async () => {
      const s = await seedScenario(prisma());
      const v = await addVehicle(s);
      const r1 = await post(url(s.app.id, v.id, 'ownership-check'), { method: 'DECLARED' });
      expect([r1.status, r1.body.code]).toEqual([422, 'DECLARED_NOT_ALLOWED']);
      const r2 = await post(url(s.app.id, v.id, 'encumbrance-check'), { method: 'DECLARED' });
      expect([r2.status, r2.body.code]).toEqual([422, 'DECLARED_NOT_ALLOWED']);

      const live = mutation(await post(url(s.app.id), { assetType: 'LIVESTOCK', ownerCustomerId: s.owner.id, description: { livestockType: 'HORSE', headCount: 40 } }), 201).collateral;
      const own = mutation(await post(url(s.app.id, live.id, 'ownership-check'), { method: 'DECLARED', note: 'Малын тоо бүртгэл' }));
      expect(own.collateral.ownership).toMatchObject({ status: 'VERIFIED', method: 'DECLARED', source: 'DECLARED', note: 'Малын тоо бүртгэл' });
      const registryNotAvailable = await post(url(s.app.id, live.id, 'ownership-check'), { method: 'REGISTRY' });
      expect([registryNotAvailable.status, registryNotAvailable.body.code]).toEqual([422, 'REGISTRY_NOT_AVAILABLE']);
      const enc = mutation(await post(url(s.app.id, live.id, 'encumbrance-check'), { method: 'DECLARED' }));
      expect(enc.collateral.encumbrance).toMatchObject({ status: 'CLEAR', method: 'DECLARED', sources: [] });
    });

    it('тоног төхөөрөмж: серийн дугаартай бол ЗМС/ЭБ-ийн шалгалтыг DECLARED-ээр алгасахгүй (422); серийн дугааргүй бол DECLARED зөвшөөрнө', async () => {
      const s = await seedScenario(prisma());
      const withSerial = mutation(await post(url(s.app.id), { assetType: 'EQUIPMENT', ownerCustomerId: s.owner.id, description: { name: 'Экскаватор', serialNo: 'SN-0017' } }), 201).collateral;
      const r1 = await post(url(s.app.id, withSerial.id, 'encumbrance-check'), { method: 'DECLARED' });
      expect([r1.status, r1.body.code]).toEqual([422, 'DECLARED_NOT_ALLOWED']);
      const noSerial = mutation(await post(url(s.app.id), { assetType: 'EQUIPMENT', ownerCustomerId: s.owner.id, description: { name: 'Багаж' } }), 201).collateral;
      const enc = mutation(await post(url(s.app.id, noSerial.id, 'encumbrance-check'), { method: 'DECLARED' }));
      expect(enc.collateral.encumbrance).toMatchObject({ status: 'CLEAR', method: 'DECLARED' });
    });

    it('үл хөдлөхийн өмчлөл propertyId (certificateNo-гүй) байхгүй бол 422 PROPERTY_ID_REQUIRED; ХУР-д олдохгүй бол 422 REGISTRY_RECORD_NOT_FOUND', async () => {
      const s = await seedScenario(prisma());
      const noId = mutation(await post(url(s.app.id), { assetType: 'APARTMENT', ownerCustomerId: s.owner.id, description: { certificateNo: 'C-1', address: { province: 'УБ', district: 'СБД' }, areaM2: 40 } }), 201).collateral;
      const r1 = await post(url(s.app.id, noId.id, 'ownership-check'), { method: 'REGISTRY' });
      expect([r1.status, r1.body.code]).toEqual([422, 'PROPERTY_ID_REQUIRED']);
      const missing = mutation(await post(url(s.app.id), { assetType: 'APARTMENT', ownerCustomerId: s.owner.id, description: apartmentDescription('P-404') }), 201).collateral;
      const r2 = await post(url(s.app.id, missing.id, 'ownership-check'), { method: 'REGISTRY' });
      expect([r2.status, r2.body.code]).toEqual([422, 'REGISTRY_RECORD_NOT_FOUND']);
    });

    it('FR-6.8: лавлагаа stale_days (30 хоног) хэтэрвэл OWNERSHIP_STALE / ENCUMBRANCE_STALE, дахин шалгавал хангагдана', async () => {
      const s = await seedScenario(prisma(), { amount: 10_000_000 });
      const done = await completeVehicle(s);
      expect(done.gate.complete).toBe(true);
      k.t.clock.advanceMs(30 * 86_400_000); // яг 30 хоног: хүчинтэй
      expect(codes(ok(await get(url(s.app.id)), 200, (b) => CollateralListResponse.parse(b)))).toEqual([]);
      k.t.clock.advanceMs(1);
      const stale = ok(await post(url(s.app.id, 'recheck')), 200, (b) => CollateralListResponse.parse(b));
      expect(codes(stale)).toEqual(['OWNERSHIP_STALE', 'ENCUMBRANCE_STALE']);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');
      await verifyOwnership(s, done.collateral.id);
      const after = await checkEncumbrance(s, done.collateral.id);
      expect(after.gate).toMatchObject({ complete: true, issues: [] }); // дотоод үнэлгээ 90 хоногоор хүчинтэй
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('COMPLETED');
    });

    it('дотоод үнэлгээ 90 хоногийн дараа VALUATION_EXPIRED (яг valid_until хүртэл хүчинтэй), дахин үнэлвэл хангагдана', async () => {
      const s = await seedScenario(prisma(), { amount: 10_000_000 });
      const done = await completeVehicle(s);
      const { valuationValidUntil } = await prisma().collateral.findUniqueOrThrow({ where: { id: done.collateral.id } });
      expect(valuationValidUntil?.toISOString()).toBe('2027-01-26T02:00:00.000Z'); // 2026-10-28T02:00Z + 90 хоног
      k.t.clock.set(valuationValidUntil as Date);
      // лавлагаанууд 90 хоногт хуучирсан тул дахин шалгана
      await verifyOwnership(s, done.collateral.id); await checkEncumbrance(s, done.collateral.id);
      expect(codes(ok(await get(url(s.app.id)), 200, (b) => CollateralListResponse.parse(b)))).toEqual([]);
      k.t.clock.advanceMs(1);
      expect(codes(ok(await post(url(s.app.id, 'recheck')), 200, (b) => CollateralListResponse.parse(b)))).toEqual(['VALUATION_EXPIRED']);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('PENDING');
      const again = await value(s, done.collateral.id);
      expect(again.gate.complete).toBe(true);
      expect((await stepOf(prisma(), s.app.id, 'collateral')).status).toBe('COMPLETED');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('үнэлгээ (FR-14)', () => {
    it('системийн саналаас ялгаатай дүнд шалтгаан заавал (valuation-ий код дамжина), шалтгаантай бол хадгалагдана', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      const bad = await post(url(s.app.id, c.id, 'valuation'), { marketValue: 28_000_000 });
      expect([bad.status, bad.body.code]).toEqual([422, 'OVERRIDE_REASON_REQUIRED']);
      const good = await value(s, c.id, { marketValue: 28_000_000, overrideReason: 'Гэмтэлтэй' });
      expect(good.collateral.valuation).toMatchObject({ marketValue: 28_000_000, collateralValue: 19_600_000, overrideReason: 'Гэмтэлтэй' });
    });

    it('барьцааны үнэ ЗЭЗ оруулах төрөл (тоног төхөөрөмж): marketValue заавал (MARKET_VALUE_REQUIRED)', async () => {
      const s = await seedScenario(prisma());
      const e = mutation(await post(url(s.app.id), { assetType: 'EQUIPMENT', ownerCustomerId: s.owner.id, description: { name: 'Станок', serialNo: 'S1' } }), 201).collateral;
      const r = await post(url(s.app.id, e.id, 'valuation'), {});
      expect([r.status, r.body.code]).toEqual([422, 'MARKET_VALUE_REQUIRED']);
      expect((await value(s, e.id, { marketValue: 8_000_000 })).collateral.valuation).toMatchObject({ marketValue: 8_000_000, haircutRate: 0.6, collateralValue: 4_800_000 });
    });

    it('гүйлт зөвхөн автомашинд (MILEAGE_NOT_APPLICABLE); автомашины гүйлт тодорхойлолтыг шинэчилнэ', async () => {
      const s = await seedScenario(prisma());
      const a = mutation(await post(url(s.app.id), { assetType: 'APARTMENT', ownerCustomerId: s.owner.id, description: apartmentDescription() }), 201).collateral;
      const r = await post(url(s.app.id, a.id, 'valuation'), { mileageKm: 10 });
      expect([r.status, r.body.code]).toEqual([422, 'MILEAGE_NOT_APPLICABLE']);
      const v = await addVehicle(s);
      const valued = await value(s, v.id, { mileageKm: 120_000 });
      expect(valued.collateral.description).toMatchObject({ mileageKm: 120_000 });
      expect(k.valuation.saveRequests.at(-1)).toMatchObject({ description: { mileageKm: 120_000 }, productHaircutRate: 0.7, validityDays: 90, externalValuationThreshold: 100_000_000 });
    });

    it('гадны үнэлгээний босго: зах зээлийн үнэ >= 100,000,000 -> EXTERNAL_VALUATION_REQUIRED; тайлантай гадны үнэлгээгээр хангагдана (FR-14.3)', async () => {
      const s = await seedScenario(prisma(), { amount: 50_000_000 });
      registerVehicle();
      const c = await addVehicle(s);
      const big = await value(s, c.id, { marketValue: 120_000_000, overrideReason: 'Тансаг загвар' });
      expect(big.collateral.valuation).toMatchObject({ externalRequired: true, externalSatisfied: false });
      expect(big.collateral.issues.map((i) => i.code)).toContain('EXTERNAL_VALUATION_REQUIRED');

      const reportFileId = '11111111-1111-4111-8111-111111111111';
      const noFile = await post(url(s.app.id, c.id, 'valuation/external'), { appraiser: 'Үнэлгээ ХХК', licenseNo: 'L-1', valuedAt: '2026-10-27', marketValue: 120_000_000, reportFileId });
      expect([noFile.status, noFile.body.code]).toEqual([422, 'REPORT_FILE_NOT_FOUND']);
      expect(k.valuation.externalRequests).toHaveLength(0);
      k.files.add({ id: reportFileId, name: 'report.pdf' });
      const future = await post(url(s.app.id, c.id, 'valuation/external'), { appraiser: 'Үнэлгээ ХХК', valuedAt: '2026-10-29', marketValue: 120_000_000, reportFileId });
      expect([future.status, future.body.code]).toEqual([422, 'VALUATION_DATE_IN_FUTURE']);
      const ext = mutation(await post(url(s.app.id, c.id, 'valuation/external'), { appraiser: 'Үнэлгээ ХХК', licenseNo: 'L-1', valuedAt: '2026-10-27', marketValue: 120_000_000, reportFileId }));
      expect(ext.collateral.valuation).toMatchObject({ source: 'EXTERNAL_LICENSED', marketValue: 120_000_000, externalRequired: true, externalSatisfied: true });
      expect(ext.collateral.issues.map((i) => i.code)).not.toContain('EXTERNAL_VALUATION_REQUIRED');
      const hist = ok(await get(url(s.app.id, c.id, 'valuations')), 200, (b) => ValuationHistoryResponse.parse(b));
      expect(hist.items.map((h) => h.source)).toEqual(['EXTERNAL_LICENSED', 'INTERNAL']);
    });

    it('valuation сервис унавал: 502 UPSTREAM_ERROR, барьцаа хөндөгдөхгүй', async () => {
      const { UpstreamError } = await import('@los/nest-common');
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      k.valuation.failWith = new UpstreamError('valuation', 500, 'valuation алдаа буцаалаа (500)', 502);
      const res = await post(url(s.app.id, c.id, 'valuation'), {});
      expect(res.status).toBe(502);
      expect((await prisma().collateral.findUniqueOrThrow({ where: { id: c.id } })).valuationId).toBeNull();
    });

    it('үнэлгээ дуудлага хийгдэж байх хугацаанд барьцаа өөрчлөгдвөл 409 COLLATERAL_CHANGED, хуучин үнэ хэрэглэгдэхгүй', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      const original = k.valuation.save.bind(k.valuation);
      vi.spyOn(k.valuation, 'save').mockImplementation(async (ctx, req) => {
        const res = await original(ctx, req);
        // valuation хариу өгч байх хооронд ЗЭЗ тодорхойлолтыг өөрчилсөн
        await prisma().collateral.update({ where: { id: c.id }, data: { descriptionJson: { ...vehicleDescription(), make: 'Lexus' } } });
        return res;
      });
      const res = await post(url(s.app.id, c.id, 'valuation'), {});
      expect([res.status, res.body.code]).toEqual([409, 'COLLATERAL_CHANGED']);
      expect((await prisma().collateral.findUniqueOrThrow({ where: { id: c.id } })).valuationId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('ХУР-ын хөрөнгө (FR-6.3)', () => {
    it('барьцаалагч хүсэлтийн оролцогч биш бол 422 OWNER_NOT_ON_APPLICATION; зөвхөн батлан даагч бол 422 OWNER_NOT_PLEDGOR', async () => {
      const s = await seedScenario(prisma());
      const stranger = await createCustomer(prisma(), { registerNo: 'ЖИ00000002' });
      const r1 = await get(`${url(s.app.id, 'xyp-assets')}?ownerCustomerId=${stranger.id}`);
      expect([r1.status, r1.body.code]).toEqual([422, 'OWNER_NOT_ON_APPLICATION']);
      expect(r1.body.message).toContain('Барьцаалагч бүртгэнэ үү');
      await createBorrower(prisma(), s.app.id, stranger.id, 'GUARANTOR');
      const r2 = await get(`${url(s.app.id, 'xyp-assets')}?ownerCustomerId=${stranger.id}`);
      expect([r2.status, r2.body.code]).toEqual([422, 'OWNER_NOT_PLEDGOR']);
      expect(k.kyc.calls).toHaveLength(0);
    });

    it('ХУР унавал (XYP_UNAVAILABLE 503) шууд дамжина; ownerCustomerId буруу бол 400', async () => {
      const { DomainError } = await import('@los/nest-common');
      const s = await seedScenario(prisma());
      k.kyc.failWith = new DomainError('XYP_UNAVAILABLE', 'ХУР түр ажиллахгүй байна', 503);
      const r = await get(`${url(s.app.id, 'xyp-assets')}?ownerCustomerId=${s.owner.id}`);
      expect([r.status, r.body.code]).toEqual([503, 'XYP_UNAVAILABLE']);
      expect((await get(`${url(s.app.id, 'xyp-assets')}?ownerCustomerId=nope`)).status).toBe(400);
    });

    it('alreadyPledged: энэ хүсэлтэд бүртгэгдсэн ба өөр идэвхтэй хүсэлтэд барьцаалагдсан хөрөнгөнд true; өөр ноорогт false', async () => {
      const s = await seedScenario(prisma());
      const other = await seedScenario(prisma(), { status: 'APPROVED', registerNo: 'АБ12345678', product: s.product });
      const draft = await seedScenario(prisma(), { status: 'DRAFT', registerNo: 'АВ12345678', product: s.product });
      const v = (plateNo: string) => ({ plateNo, vin: null, make: 'Toyota', model: 'Prius', manufactureYear: 2015, importYear: null, engineCc: null, fuelType: null, color: null });
      k.kyc.assets.set(REGISTER, { properties: [], vehicles: [v('1111УБА'), v('2222УБА'), v('3333УБА'), v('4444УБА')], fetchedAt: k.t.clock.now().toISOString() });
      await addVehicle(s, '1111УБА');
      const row = (appId: string, ownerId: string, plate: string, extra: Record<string, unknown> = {}) => prisma().collateral.create({ data: { orgId: ORG, applicationId: appId, kind: 'MOVABLE', assetType: 'VEHICLE', ownerCustomerId: ownerId, descriptionJson: vehicleDescription(plate), assetKey: `VEHICLE:${plate}`, ...extra } });
      await row(other.app.id, other.owner.id, '2222УБА');
      await row(draft.app.id, draft.owner.id, '3333УБА');
      const res = ok(await get(`${url(s.app.id, 'xyp-assets')}?ownerCustomerId=${s.owner.id}`), 200, (b) => CollateralCandidatesResponse.parse(b));
      expect(Object.fromEntries(res.items.map((i) => [i.xypRef, i.alreadyPledged]))).toEqual({ '1111УБА': true, '2222УБА': true, '3333УБА': false, '4444УБА': false });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('баримт (FR-6.2, FR-6.7)', () => {
    it('checklist-д байхгүй түлхүүр 422 UNKNOWN_CHECKLIST_KEY; "other" нэмэлт баримт зөвшөөрнө, checklist-ийг хангахгүй', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      k.files.add({ id: '22222222-2222-4222-8222-222222222222', name: 'x.pdf' });
      const bad = await post(url(s.app.id, c.id, 'documents'), { checklistKey: 'cadastral_plan', fileId: '22222222-2222-4222-8222-222222222222' });
      expect([bad.status, bad.body.code]).toEqual([422, 'UNKNOWN_CHECKLIST_KEY']);
      const other = mutation(await post(url(s.app.id, c.id, 'documents'), { checklistKey: 'other', fileId: '22222222-2222-4222-8222-222222222222', note: 'Урд тал' }), 201);
      expect(other.collateral.extraDocuments).toHaveLength(1);
      expect(other.collateral.extraDocuments[0]).toMatchObject({ checklistKey: 'other', fileName: 'x.pdf', mime: 'application/pdf', size: 1234, note: 'Урд тал' });
      expect(other.collateral.checklist.every((x) => !x.satisfied)).toBe(true);
    });

    it('dms-д олдохгүй файл 422 FILE_NOT_FOUND; давхар файл 409; хасахад checklist дахин дутуу болно', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      const fileId = '33333333-3333-4333-8333-333333333333';
      const nf = await post(url(s.app.id, c.id, 'documents'), { checklistKey: 'insurance', fileId });
      expect([nf.status, nf.body.code]).toEqual([422, 'FILE_NOT_FOUND']);
      k.files.add({ id: fileId });
      const first = mutation(await post(url(s.app.id, c.id, 'documents'), { checklistKey: 'insurance', fileId }), 201);
      const dup = await post(url(s.app.id, c.id, 'documents'), { checklistKey: 'insurance', fileId });
      expect([dup.status, dup.body.code]).toEqual([409, 'COLLATERAL_DOCUMENT_DUPLICATE']);
      const docId = first.collateral.checklist.find((x) => x.key === 'insurance')!.documents[0]!.id;
      const removed = mutation(await k.http().delete(url(s.app.id, c.id, 'documents', docId)).set(officer));
      expect(removed.collateral.checklist.find((x) => x.key === 'insurance')?.satisfied).toBe(false);
      const missing = await k.http().delete(url(s.app.id, c.id, 'documents', docId)).set(officer);
      expect([missing.status, missing.body.code]).toEqual([404, 'COLLATERAL_DOCUMENT_NOT_FOUND']);
    });

    it('баримтын дээд тоо (20) хэтэрвэл 409 DOCUMENT_LIMIT_EXCEEDED', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      await prisma().collateralDocument.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ orgId: ORG, collateralId: c.id, checklistKey: 'other', fileId: `f-${i}` })) });
      k.files.add({ id: '44444444-4444-4444-8444-444444444444' });
      const r = await post(url(s.app.id, c.id, 'documents'), { checklistKey: 'other', fileId: '44444444-4444-4444-8444-444444444444' });
      expect([r.status, r.body.code]).toEqual([409, 'DOCUMENT_LIMIT_EXCEEDED']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('эрх, баталгаажуулалт, төлөв (NFR-3, FR-10.4)', () => {
    const matrix = (appId: string, cid: string) => [
      ['GET', url(appId)], ['POST', url(appId)], ['PATCH', url(appId, cid)], ['DELETE', url(appId, cid)], ['GET', `${url(appId, 'xyp-assets')}?ownerCustomerId=${cid}`], ['POST', url(appId, 'recheck')],
      ['POST', url(appId, cid, 'ownership-check')], ['POST', url(appId, cid, 'encumbrance-check')], ['POST', url(appId, cid, 'valuation/suggest')], ['POST', url(appId, cid, 'valuation')],
      ['POST', url(appId, cid, 'valuation/external')], ['GET', url(appId, cid, 'valuations')], ['POST', url(appId, cid, 'documents')], ['DELETE', url(appId, cid, 'documents', 'd1')],
      ['POST', url(appId, cid, 'registry')], ['POST', url(appId, cid, 'release')], ['GET', '/api/collaterals/monitoring'],
    ] as const;
    const FILE = '66666666-6666-4666-8666-666666666666';
    /** Баталгаажуулалтын алдаа (400) эрхийн шалгалтыг халхлахгүйн тулд хүчинтэй body. */
    const bodyFor = (method: string, path: string, ownerId: string): object => {
      if (method === 'PATCH') return { note: 'x' };
      if (path.endsWith('/collaterals')) return { assetType: 'VEHICLE', ownerCustomerId: ownerId, description: vehicleDescription('7777УБА') };
      if (path.endsWith('ownership-check') || path.endsWith('encumbrance-check')) return { method: 'REGISTRY' };
      if (path.endsWith('valuation/external')) return { appraiser: 'A', valuedAt: '2026-10-01', marketValue: 1000, reportFileId: FILE };
      if (path.endsWith('/documents')) return { checklistKey: 'insurance', fileId: FILE };
      if (path.endsWith('/registry')) return { registryNo: 'X-1', registryDate: '2026-10-01' };
      return {};
    };
    let ownerId = '';
    const send = (method: string, path: string, headers: Record<string, string>) => {
      const agent = k.http();
      switch (method) {
        case 'GET': return agent.get(path).set(headers);
        case 'DELETE': return agent.delete(path).set(headers);
        case 'PATCH': return agent.patch(path).set(headers).send(bodyFor(method, path, ownerId));
        default: return agent.post(path).set(headers).send(bodyFor(method, path, ownerId));
      }
    };
    const WRITE_ONLY = new Set(['POST', 'PATCH', 'DELETE']);
    const isRead = (method: string, path: string) => method === 'GET' && !path.includes('xyp-assets');

    it('нэвтрээгүй -> 401 UNAUTHENTICATED (бүх endpoint)', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      for (const [m, p] of matrix(s.app.id, c.id)) {
        const res = await send(m, p, actors.anonymous());
        expect([m, p, res.status, res.body.code]).toEqual([m, p, 401, 'UNAUTHENTICATED']);
      }
    });

    it('CUSTOMER дүр -> 403 (бүх endpoint)', async () => {
      const s = await seedScenario(prisma());
      const c = await addVehicle(s);
      for (const [m, p] of matrix(s.app.id, c.id)) {
        const res = await send(m, p, actors.customer(s.owner.id));
        expect([m, p, res.status]).toEqual([m, p, 403]);
      }
    });

    it('өөр ЗЭЗ -> 403 FORBIDDEN (унших ба бичих), өгөгдөл өөрчлөгдөөгүй', async () => {
      const s = await seedScenario(prisma(), { officerId: 'officer-1' });
      const c = await addVehicle(s);
      ownerId = s.owner.id;
      const stranger = actors.officer('officer-2');
      for (const [m, p] of matrix(s.app.id, c.id).filter(([m2, p2]) => (m2 === 'GET' && isRead(m2, p2)) || WRITE_ONLY.has(m2))) {
        if (p.includes('monitoring')) continue;
        const res = await send(m, p, stranger);
        expect([m, p, res.status, res.body.code]).toEqual([m, p, 403, 'FORBIDDEN']);
      }
      expect(await prisma().collateral.count({ where: { applicationId: s.app.id } })).toBe(1);
    });

    it('BRANCH_MANAGER (өөрийн салбар) ба APPROVER унших боломжтой (200), бичих 403; өөр салбарын захирал унших 403', async () => {
      const s = await seedScenario(prisma(), { officerId: 'officer-1', branchId: 'branch-1' });
      const c = await addVehicle(s);
      ownerId = s.owner.id;
      for (const actor of [actors.branchManager('bm', 'branch-1'), actors.approver(), actors.admin()]) {
        expect((await get(url(s.app.id), actor)).status).toBe(200);
        expect((await get(url(s.app.id, c.id, 'valuations'), actor)).status).toBe(200);
      }
      expect((await get(url(s.app.id), actors.branchManager('bm', 'branch-2'))).status).toBe(403);
      for (const actor of [actors.branchManager('bm', 'branch-1'), actors.approver()]) {
        for (const [m, p] of matrix(s.app.id, c.id).filter(([m2, p2]) => WRITE_ONLY.has(m2) || p2.includes('xyp-assets'))) {
          const res = await send(m, p, actor);
          expect([m, p, res.status]).toEqual([m, p, 403]);
        }
      }
      expect(await prisma().collateral.count({ where: { applicationId: s.app.id } })).toBe(1);
    });

    it('ADMIN бичиж чадна (өөр ЗЭЗ-ийн хүсэлтэд)', async () => {
      const s = await seedScenario(prisma(), { officerId: 'officer-1' });
      const res = await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription() }, actors.admin());
      expect(res.status).toBe(201);
    });

    it('хүсэлт олдохгүй 404 APPLICATION_NOT_FOUND; өөр байгууллагын хүсэлт 404; барьцаа олдохгүй 404 COLLATERAL_NOT_FOUND', async () => {
      const s = await seedScenario(prisma());
      const nf = await get(url('00000000-0000-4000-8000-000000000000'));
      expect([nf.status, nf.body.code]).toEqual([404, 'APPLICATION_NOT_FOUND']);
      const other = await createApplication(prisma(), { orgId: 'other-org' });
      expect((await get(url(other.id))).status).toBe(404);
      const cnf = await post(url(s.app.id, '00000000-0000-4000-8000-000000000000', 'ownership-check'), { method: 'REGISTRY' });
      expect([cnf.status, cnf.body.code]).toEqual([404, 'COLLATERAL_NOT_FOUND']);
      // өөр хүсэлтийн барьцааг энэ хүсэлтийн замаар хандахгүй
      const s2 = await seedScenario(prisma(), { registerNo: 'АБ12345678', product: s.product });
      const c2 = await addVehicle(s2, '9999УБА');
      expect((await k.http().patch(url(s.app.id, c2.id)).set(officer).send({ note: 'x' })).status).toBe(404);
    });

    it.each(['SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'DISBURSING', 'CLOSED', 'CANCELLED', 'REJECTED'])('хүсэлт %s: засах бүх үйлдэл 409 APPLICATION_NOT_EDITABLE', async (status) => {
      const s = await seedScenario(prisma(), { status });
      const row = await prisma().collateral.create({ data: { orgId: ORG, applicationId: s.app.id, kind: 'MOVABLE', assetType: 'VEHICLE', ownerCustomerId: s.owner.id, descriptionJson: vehicleDescription(), assetKey: 'VEHICLE:1234УБА' } });
      const attempts: Array<[string, string, object]> = [
        ['POST', url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription('5555УБА') }],
        ['PATCH', url(s.app.id, row.id), { note: 'x' }], ['DELETE', url(s.app.id, row.id), {}], ['POST', url(s.app.id, 'recheck'), {}],
        ['POST', url(s.app.id, row.id, 'ownership-check'), { method: 'REGISTRY' }], ['POST', url(s.app.id, row.id, 'encumbrance-check'), { method: 'REGISTRY' }],
        ['POST', url(s.app.id, row.id, 'documents'), { checklistKey: 'insurance', fileId: '55555555-5555-4555-8555-555555555555' }], ['GET', `${url(s.app.id, 'xyp-assets')}?ownerCustomerId=${s.owner.id}`, {}],
        ...(status === 'CLOSED' || status === 'DISBURSING' ? [] : ([['POST', url(s.app.id, row.id, 'valuation'), {}], ['POST', url(s.app.id, row.id, 'valuation/suggest'), {}]] as Array<[string, string, object]>)),
      ];
      for (const [m, p, body] of attempts) {
        const res = m === 'GET' ? await get(p) : m === 'DELETE' ? await k.http().delete(p).set(officer) : m === 'PATCH' ? await k.http().patch(p).set(officer).send(body) : await post(p, body);
        expect([m, p, res.status, res.body.code]).toEqual([m, p, 409, 'APPLICATION_NOT_EDITABLE']);
        expect(res.body.message).toBeTruthy();
      }
      expect(await prisma().collateral.count({ where: { applicationId: s.app.id } })).toBe(1);
      expect(await prisma().outbox.count({ where: { type: 'CollateralChanged' } })).toBe(0);
    });

    it('RETURNED хүсэлтэд засаж болно', async () => {
      const s = await seedScenario(prisma(), { status: 'RETURNED' });
      expect((await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription() })).status).toBe(201);
    });

    it('баталгаажуулалт: буруу тодорхойлолт 400 VALIDATION_FAILED (монгол мессеж); дугаар/ownerCustomerId буруу; хоосон PATCH', async () => {
      const s = await seedScenario(prisma());
      const bad = await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: { plateNo: 'ABC123', make: 'x', model: 'y', manufactureYear: 2015 } });
      expect([bad.status, bad.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      const noOwner = await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: 'x', description: vehicleDescription() });
      expect(noOwner.status).toBe(400);
      const unknown = await post(url(s.app.id), { assetType: 'SPACESHIP', ownerCustomerId: s.owner.id, description: {} });
      expect(unknown.status).toBe(400);
      const c = await addVehicle(s);
      expect((await k.http().patch(url(s.app.id, c.id)).set(officer).send({})).status).toBe(400);
      expect(await prisma().collateral.count({ where: { applicationId: s.app.id } })).toBe(1);
    });

    it('барьцаалагч хүсэлтийн оролцогч биш -> 422 OWNER_NOT_ON_APPLICATION; зөвхөн батлан даагч -> 422 OWNER_NOT_PLEDGOR (нэмэх, засах)', async () => {
      const s = await seedScenario(prisma());
      const stranger = await createCustomer(prisma(), { registerNo: 'ЖИ00000002' });
      const body = { assetType: 'VEHICLE', ownerCustomerId: stranger.id, description: vehicleDescription() };
      const r1 = await post(url(s.app.id), body);
      expect([r1.status, r1.body.code]).toEqual([422, 'OWNER_NOT_ON_APPLICATION']);
      expect(r1.body.message).toContain('Барьцаалагч бүртгэнэ үү');
      await createBorrower(prisma(), s.app.id, stranger.id, 'GUARANTOR');
      const r2 = await post(url(s.app.id), body);
      expect([r2.status, r2.body.code]).toEqual([422, 'OWNER_NOT_PLEDGOR']);
      const c = await addVehicle(s);
      const r3 = await k.http().patch(url(s.app.id, c.id)).set(officer).send({ ownerCustomerId: stranger.id });
      expect([r3.status, r3.body.code]).toEqual([422, 'OWNER_NOT_PLEDGOR']);
    });
  });
});
