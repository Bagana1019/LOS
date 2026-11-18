import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ApplicationDetail } from '@los/contracts';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { actors, BRANCH, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { ApplicationModule } from './application.module';
import { ApplicationService } from './application.service';

const MONGOLIAN = /[А-Яа-яӨөҮү]/;
const KEY = 'idem-key-0001';

type LookupSpyTarget = { findByIdempotencyKey: (...a: unknown[]) => Promise<unknown> };

// M1 follow-up: POST /applications + `Idempotency-Key` (сервер тал). Давхар дарах, сүлжээний timeout-ын дараах retry, 2 таб → нэг хүсэлт.
describe.skipIf(!hasTestDb)('POST /applications — Idempotency-Key (DB)', () => {
  let t: TestApp;
  let baseUrl: string;
  const officerA = actors.officer('officer-a');
  const officerB = actors.officer('officer-b');

  beforeAll(async () => {
    t = await createTestApp([ApplicationModule]);
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.prisma); });
  afterEach(() => { vi.restoreAllMocks(); });

  const post = (actor: Record<string, string>, body: Record<string, unknown> = {}, key?: string) => {
    const req = request(baseUrl).post('/api/applications').set(actor);
    return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body);
  };
  const ok = (res: { status: number; body: unknown }, status: 200 | 201) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return ApplicationDetail.parse(res.body);
  };
  /** Бичлэгийн тоо + дугаарын тоолуур: replay эдгээрийн аль нэгийг ч өөрчлөх ёсгүй. */
  async function snapshot() {
    const seq = await t.prisma.applicationSequence.findMany({ where: { orgId: ORG } });
    return {
      applications: await t.prisma.loanApplication.count(),
      steps: await t.prisma.loanApplicationStep.count(),
      audit: await t.prisma.auditLog.count(),
      outbox: await t.prisma.outbox.count(),
      nextSeq: seq.map((s) => s.nextSeq),
    };
  }
  const product = () => t.prisma.product.create({ data: { orgId: ORG, code: 'P1', name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40 } });

  describe('толгойгүй (өнөөдрийн зан төлөв)', () => {
    it('толгойгүй хоёр дуудлага = хоёр өөр хүсэлт (201, 201); түлхүүр хадгалагдахгүй', async () => {
      const a = ok(await post(officerA), 201);
      const b = ok(await post(officerA), 201);
      expect(a.id).not.toBe(b.id);
      expect(a.appNo).not.toBe(b.appNo);
      const rows = await t.prisma.loanApplication.findMany();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.idempotencyKey === null && r.idempotencyRequestHash === null)).toBe(true);
    });
  });

  describe('ижил түлхүүр + ижил бие', () => {
    it('эхний дуудлага 201, дахин дуудвал 200 + ИЖИЛ хүсэлт; шинэ мөр/алхам/audit/outbox/дугаар үүсэхгүй', async () => {
      const first = ok(await post(officerA, { purpose: 'Орон сууц' }, KEY), 201);
      const before = await snapshot();
      const second = ok(await post(officerA, { purpose: 'Орон сууц' }, KEY), 200);
      expect(second.id).toBe(first.id);
      expect(second.appNo).toBe(first.appNo);
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.steps).toHaveLength(12);
      expect(await snapshot()).toEqual(before);
      expect(before.applications).toBe(1);
      expect(before.steps).toBe(12);
      expect(before.audit).toBe(1);
    });

    it('replay нь дугаар зарцуулахгүй: дараагийн шинэ хүсэлт дараагийн дугаарыг авна (цоорхойгүй)', async () => {
      const first = ok(await post(officerA, {}, KEY), 201);
      for (let i = 0; i < 3; i++) ok(await post(officerA, {}, KEY), 200);
      const next = ok(await post(officerA, {}, 'idem-key-0002'), 201);
      const seqOf = (no: string) => Number(no.split('-')[2]);
      expect(seqOf(next.appNo)).toBe(seqOf(first.appNo) + 1);
    });

    it('нормчлол: purpose-ийн хоосон зай, ЗЭЗ өөрийн салбарыг тодорхой заасан эсэх нь үр дүнгээр адил бол replay', async () => {
      const first = ok(await post(officerA, { purpose: 'Орон сууц' }, KEY), 201);
      expect(ok(await post(officerA, { purpose: '  Орон сууц  ' }, KEY), 200).id).toBe(first.id);
      const second = ok(await post(officerA, { branchId: BRANCH }, 'idem-key-0002'), 201);
      expect(ok(await post(officerA, {}, 'idem-key-0002'), 200).id).toBe(second.id);
    });

    it('анхны хүсэлт архивлагдсан байсан ч шинэ хүсэлт үүсгэхгүй, анхных руу буцаана', async () => {
      const first = ok(await post(officerA, {}, KEY), 201);
      await t.prisma.loanApplication.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
      const before = await snapshot();
      expect(ok(await post(officerA, {}, KEY), 200).id).toBe(first.id);
      expect(await snapshot()).toEqual(before);
    });

    it('replay нь анхны хүсэлтийн ОДООГИЙН төлөвийг буцаана (түүхэн хуулбар биш)', async () => {
      const first = ok(await post(officerA, {}, KEY), 201);
      await t.prisma.loanApplication.update({ where: { id: first.id }, data: { purpose: 'Хожим засварласан' } });
      expect(ok(await post(officerA, {}, KEY), 200).purpose).toBe('Хожим засварласан');
    });
  });

  describe('ижил түлхүүр + ӨӨР бие → 422 IDEMPOTENCY_KEY_REUSED', () => {
    it('purpose өөр: 422, монгол мессеж, анхны хүсэлт өөрчлөгдөөгүй, шинэ юу ч үүсээгүй', async () => {
      const first = ok(await post(officerA, { purpose: 'Орон сууц' }, KEY), 201);
      const before = await snapshot();
      const res = await post(officerA, { purpose: 'Өөр зорилго' }, KEY);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(res.body.message).toMatch(MONGOLIAN);
      expect(await snapshot()).toEqual(before);
      expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: first.id } })).purpose).toBe('Орон сууц');
    });

    it('productId нэмэгдсэн бол 422; анхны хүсэлт өөрчлөгдөөгүй', async () => {
      const p = await product();
      const first = ok(await post(officerA, {}, KEY), 201);
      const res = await post(officerA, { productId: p.id }, KEY);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: first.id } })).productId).toBeNull();
      expect(await t.prisma.loanApplication.count()).toBe(1);
    });

    it('ADMIN өөр салбар заасан бол үр дүнтэй салбар өөр → 422', async () => {
      const admin = actors.admin('admin-1');
      ok(await post(admin, { branchId: 'branch-1' }, KEY), 201);
      const res = await post(admin, { branchId: 'branch-2' }, KEY);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('зэрэгцээ (race)', () => {
    it('ижил түлхүүртэй 10 зэрэгцээ хүсэлт: яг нэг 201, үлдсэн нь 200; НЭГ хүсэлт, НЭГ audit, НЭГ дугаар', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => post(officerA, { purpose: 'Зэрэгцээ' }, KEY)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
      const ids = new Set(results.map((r) => ApplicationDetail.parse(r.body).id));
      expect(ids.size).toBe(1);
      const s = await snapshot();
      expect(s.applications).toBe(1);
      expect(s.steps).toBe(12);
      expect(s.audit).toBe(1);
      // дугаар яг нэг удаа зарцуулагдсан (буцсан tx-ийн тоолуурын нэмэгдэл хадгалагдаагүй)
      expect(s.nextSeq).toEqual([2]);
    });

    it('2 өөр түлхүүр × 5 зэрэгцээ = яг 2 хүсэлт', async () => {
      const calls = Array.from({ length: 10 }, (_, i) => post(officerA, {}, i % 2 === 0 ? 'idem-key-aaaa' : 'idem-key-bbbb'));
      const results = await Promise.all(calls);
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(await t.prisma.loanApplication.count()).toBe(2);
    });

    it('ижил түлхүүр зэрэгцээ ч ӨӨР биетэй бол ялагч нэг (201), бусад нь 422 (хэзээ ч 409/500 биш)', async () => {
      const results = await Promise.all(['a', 'b', 'c', 'd'].map((purpose) => post(officerA, { purpose }, KEY)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 422).every((r) => r.body.code === 'IDEMPOTENCY_KEY_REUSED')).toBe(true);
      expect(results.filter((r) => r.status === 201 || r.status === 422)).toHaveLength(4);
      expect(await t.prisma.loanApplication.count()).toBe(1);
    });

    // Давхардлын шалгалтыг (SELECT) алгасуулж, DB-ийн unique зөрчил (P2002) → дахин унших замыг тодорхой шалгана.
    it('P2002 замаар: SELECT алдсан ч unique зөрчлөөс сэргэж ижил хүсэлтийг 200-аар буцаана, дугаар зарцуулахгүй', async () => {
      const first = ok(await post(officerA, { purpose: 'x' }, KEY), 201);
      const before = await snapshot();
      const lookup = vi.spyOn(t.app.get(ApplicationService) as unknown as LookupSpyTarget, 'findByIdempotencyKey').mockResolvedValueOnce(null);
      const res = await post(officerA, { purpose: 'x' }, KEY);
      expect(lookup).toHaveBeenCalledTimes(2); // анхны (алдсан) + P2002-ын дараах дахин унших
      expect(ok(res, 200).id).toBe(first.id);
      expect(await snapshot()).toEqual(before);
    });

    it('P2002 замаар ч бие зөрвөл 422 IDEMPOTENCY_KEY_REUSED', async () => {
      ok(await post(officerA, { purpose: 'x' }, KEY), 201);
      vi.spyOn(t.app.get(ApplicationService) as unknown as LookupSpyTarget, 'findByIdempotencyKey').mockResolvedValueOnce(null);
      const res = await post(officerA, { purpose: 'y' }, KEY);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await t.prisma.loanApplication.count()).toBe(1);
    });
  });

  describe('хүрээ (хэрэглэгч, байгууллага)', () => {
    it('өөр ЗЭЗ ижил түлхүүр ашиглавал өөрийн хүсэлтээ үүсгэнэ — бусдын хүсэлт задрахгүй, 422 ч биш', async () => {
      const a = ok(await post(officerA, { purpose: 'А-ийн' }, KEY), 201);
      const b = ok(await post(officerB, { purpose: 'Б-ийн' }, KEY), 201);
      expect(b.id).not.toBe(a.id);
      expect(b.officerId).toBe('officer-b');
      expect(b.purpose).toBe('Б-ийн');
      expect(ok(await post(officerB, { purpose: 'Б-ийн' }, KEY), 200).id).toBe(b.id);
      expect(ok(await post(officerA, { purpose: 'А-ийн' }, KEY), 200).id).toBe(a.id);
    });

    it('өөр байгууллага ижил түлхүүр ашиглавал тусдаа хүсэлт', async () => {
      const a = ok(await post(officerA, {}, KEY), 201);
      const other = ok(await post({ ...officerA, 'x-org-id': 'org-other' }, {}, KEY), 201);
      expect(other.id).not.toBe(a.id);
      expect(await t.prisma.loanApplication.count()).toBe(2);
    });
  });

  describe('буруу түлхүүр → 400 IDEMPOTENCY_KEY_INVALID', () => {
    it.each([
      ['хоосон', ''],
      ['7 тэмдэгт', 'abcdefg'],
      ['129 тэмдэгт', 'a'.repeat(129)],
      ['зай', 'abcd efgh'],
      ['таслал (давхар толгойг Node ", "-аар нийлүүлнэ)', 'abcdefgh, ijklmnop'],
    ])('%s', async (_name, key) => {
      const res = await post(officerA, {}, key);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(res.body.message).toMatch(MONGOLIAN);
      expect(await t.prisma.loanApplication.count()).toBe(0);
      expect((await snapshot()).nextSeq).toEqual([]);
    });
  });

  describe('алдаа, эрх', () => {
    it('амжилтгүй оролдлого түлхүүрийг "шатаахгүй": буруу productId (422) → зөв биетэй дахин оролдвол 201', async () => {
      const bad = await post(officerA, { productId: '00000000-0000-0000-0000-000000000000' }, KEY);
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('PRODUCT_NOT_FOUND');
      expect(await snapshot()).toMatchObject({ applications: 0, audit: 0, nextSeq: [] });
      ok(await post(officerA, { purpose: 'зөв' }, KEY), 201);
    });

    it('эрхгүй хэрэглэгч (BRANCH_MANAGER) түлхүүртэй ч 403; юу ч хадгалагдахгүй', async () => {
      const res = await post(actors.branchManager(), {}, KEY);
      expect(res.status).toBe(403);
      expect(await snapshot()).toMatchObject({ applications: 0, audit: 0 });
    });

    it('баталгаажаагүй (x-user-id байхгүй) дуудлага 401/403; юу ч хадгалагдахгүй', async () => {
      const res = await post(actors.anonymous(), {}, KEY);
      expect([401, 403]).toContain(res.status);
      expect(await t.prisma.loanApplication.count()).toBe(0);
    });

    it('буруу биетэй (strict схем) хүсэлт 400; түлхүүр хадгалагдахгүй', async () => {
      const res = await post(officerA, { unknownField: 1 }, KEY);
      expect(res.status).toBe(400);
      expect(await t.prisma.loanApplication.count()).toBe(0);
      ok(await post(officerA, {}, KEY), 201);
    });
  });

  describe('өгөгдлийн сан', () => {
    it('түлхүүр ба hash нь хүсэлт дээр хадгалагдана (түлхүүр өөрөө, 64 тэмдэгт hex hash)', async () => {
      const created = ok(await post(officerA, { purpose: 'x' }, KEY), 201);
      const row = await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.idempotencyKey).toBe(KEY);
      expect(row.idempotencyRequestHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('unique индекс (org, creator, key) DB түвшинд мөрдөгдөнө; NULL түлхүүр олон байж болно', async () => {
      const base = { orgId: ORG, branchId: BRANCH, officerId: 'officer-a', createdBy: 'officer-a', status: 'DRAFT' };
      await t.prisma.loanApplication.create({ data: { ...base, appNo: 'LA-2026-900001', idempotencyKey: KEY, idempotencyRequestHash: 'h' } });
      await expect(t.prisma.loanApplication.create({ data: { ...base, appNo: 'LA-2026-900002', idempotencyKey: KEY, idempotencyRequestHash: 'h' } })).rejects.toMatchObject({ code: 'P2002' });
      await t.prisma.loanApplication.create({ data: { ...base, appNo: 'LA-2026-900003' } });
      await t.prisma.loanApplication.create({ data: { ...base, appNo: 'LA-2026-900004' } });
      await t.prisma.loanApplication.create({ data: { ...base, createdBy: 'officer-b', appNo: 'LA-2026-900005', idempotencyKey: KEY, idempotencyRequestHash: 'h' } });
      expect(await t.prisma.loanApplication.count()).toBe(4);
    });
  });
});
