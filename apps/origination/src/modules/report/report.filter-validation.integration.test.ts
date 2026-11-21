import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReportKey } from '@los/contracts';
import { actors, hasTestDb } from '../../test-utils/factories';
import { bootReport, col, getReport, resetAndSeed, type ReportEnv } from './report.test-helpers';
import type { World } from './report.fixtures';

// F11-7 (HTTP + бодит DB): буруу branchId / officerId / productId / currency нь `status=BOGUS`-тай ижил 400 INVALID_FILTER (JSON ба Excel хоёуланд).
const BAD_FILTERS = [
  ['branchId', 'notauuid', 'Салбар'],
  ['officerId', 'notauuid', 'ЗЭЗ'],
  ['productId', 'notauuid', 'Бүтээгдэхүүн'],
  ['currency', 'EUR', 'Валют'],
] as const;
const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000009ff';

describe.skipIf(!hasTestDb)('report: шүүлтийн утгын шалгалт (HTTP, DB) — F11-7', () => {
  let env: ReportEnv;
  let world: World;
  const admin = actors.admin();

  beforeAll(async () => { env = await bootReport(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { world = await resetAndSeed(env); });

  const get = (path: string, query: Record<string, string | number>) => env.http().get(`/api/reports/${path}`).query(query).set(admin);

  describe.each(ReportKey)('%s', (key) => {
    it.each(BAD_FILTERS)('%s=%s → 400 INVALID_FILTER (монгол мессеж), JSON ба Excel', async (param, value, label) => {
      for (const path of [key, `${key}/export`]) {
        const res = await get(path, { [param]: value });
        expect(res.status, `${path} ${param}=${value}`).toBe(400);
        expect(res.body.code).toBe('INVALID_FILTER');
        // deposit-balances валютын шүүлтээ "Дансны валют" гэж нэрлэсэн — мессеж тухайн тайлангийн шүүлтийн шошгыг ашиглана
        const shown = key === 'deposit-balances' && param === 'currency' ? 'Дансны валют' : label;
        expect(res.body.message).toBe(`"${shown}" шүүлтийн утга буруу: ${value}`);
      }
    });

    it('sortBy=nope → 400 INVALID_SORT (JSON ба Excel) — эрэмбэ аль хэдийн чанга', async () => {
      for (const path of [key, `${key}/export`]) {
        const res = await get(path, { sortBy: 'nope' });
        expect(res.status, path).toBe(400);
        expect(res.body.code).toBe('INVALID_SORT');
      }
    });
  });

  it('аудит: буруу шүүлттэй экспорт report_run-д бичигдэхгүй', async () => {
    await get('outstanding-balance/export', { branchId: 'notauuid' });
    expect(await env.t.prisma.reportRun.count()).toBe(0);
  });

  it('productId: каталогийн бодит id → 200, зөвхөн тэр бүтээгдэхүүний зээл; UUID хэлбэртэй боловч каталогт байхгүй → 400', async () => {
    const all = await getReport(env, admin, 'outstanding-balance', {});
    const consumer = await getReport(env, admin, 'outstanding-balance', { productId: world.products.consumer.id });
    expect(consumer.total).toBeGreaterThan(0);
    expect(consumer.total).toBeLessThan(all.total);
    expect(new Set(col(consumer, 'productName')).size).toBe(1);
    const res = await get('outstanding-balance', { productId: UNKNOWN_UUID });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILTER');
  });

  it('UUID хэлбэртэй боловч зээлгүй (шинэ) салбар/ЗЭЗ → 200 ба 0 мөр (зөв хоосон хариу)', async () => {
    const r = await getReport(env, admin, 'outstanding-balance', { branchId: UNKNOWN_UUID, officerId: UNKNOWN_UUID });
    expect(r.total).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it('UUID биш боловч өгөгдөлд байгаа салбар/ЗЭЗ (fixture: branch-1, officer-1) → 200, мөртэй; өөр салбарын id шүүлтэд таарна', async () => {
    const b1 = await getReport(env, admin, 'outstanding-balance', { branchId: 'branch-1', officerId: 'officer-1' });
    expect(b1.total).toBeGreaterThan(0);
    const b2 = await getReport(env, admin, 'outstanding-balance', { branchId: 'branch-2' });
    expect(col(b2, 'contractNo')).toContain('B10026LC');
  });

  it('currency жижиг үсгээр (usd) → USD зээл; шүүлт хэвийн ажиллана', async () => {
    const r = await getReport(env, admin, 'outstanding-balance', { currency: 'usd' });
    expect(col(r, 'contractNo')).toEqual(['B10026LD']);
  });

  it('BRANCH_MANAGER: буруу салбар 400; өөр (зөв хэлбэртэй) салбарын шүүлт хүрээнд үл тоогдоно', async () => {
    const bm = actors.branchManager();
    const bad = await env.http().get('/api/reports/outstanding-balance').query({ branchId: 'notauuid' }).set(bm);
    expect(bad.status).toBe(400);
    const ignored = await getReport(env, bm, 'outstanding-balance', { branchId: UNKNOWN_UUID });
    expect(ignored.total).toBeGreaterThan(0); // өөрийн салбарын (branch-1) зээлүүд
  });
});
