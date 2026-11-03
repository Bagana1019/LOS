import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { ApplicationModule } from './application.module';

// NFR-1: хүсэлтийн жагсаалт, хайлт, шүүлт, алхам/төлөв шилжилт ≤ 2с (10,000 хүсэлт).
const N = 10_000;
const LIMIT_MS = 2000;

describe.skipIf(!hasTestDb)(`applications: гүйцэтгэл (NFR-1), ${N} хүсэлт`, () => {
  let t: TestApp;
  let url: string;
  const officer = actors.officer('officer-1');
  const admin = actors.admin();
  beforeAll(async () => {
    t = await createTestApp([ApplicationModule]);
    await t.app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    await resetDb(t.prisma);
    await t.prisma.$executeRawUnsafe(`
      INSERT INTO origination.loan_application (id, org_id, app_no, status, branch_id, officer_id, amount, currency, source, version, created_at, updated_at)
      SELECT gen_random_uuid(), '${ORG}', 'LA-2026-' || lpad(g::text, 6, '0'),
             (ARRAY['DRAFT','SUBMITTED','IN_APPROVAL','APPROVED','RETURNED','ACTIVE'])[1 + g % 6],
             'branch-' || (1 + g % 5), 'officer-' || (1 + g % 20), 1000000 + g, 'MNT', 'WEB', 1, now() - (g || ' minutes')::interval, now()
      FROM generate_series(1, ${N}) g`);
    await t.prisma.$executeRawUnsafe('ANALYZE');
  }, 120_000);
  afterAll(async () => { await resetDb(t.prisma); await t.close(); });

  async function expectFast(label: string, path: string, headers: Record<string, string>) {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const res = await request(url).get(path).set(headers);
      times.push(performance.now() - t0);
      expect(res.status, `${label}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
    }
    console.info(`[perf] ${label}: ${times.map((x) => Math.round(x)).join(' / ')} мс`);
    expect(Math.max(...times), label).toBeLessThan(LIMIT_MS);
  }

  it('жагсаалт, хуудаслалт, шүүлт, хайлт, дүрээр хүрээлсэн жагсаалт ≤ 2с', async () => {
    await expectFast('list admin', '/api/applications?pageSize=50', admin);
    await expectFast('list page 100', '/api/applications?pageSize=50&page=100', admin);
    await expectFast('filter status', '/api/applications?status=APPROVED&pageSize=50', admin);
    await expectFast('search appNo', '/api/applications?q=LA-2026-00123', admin);
    await expectFast('officer scope', '/api/applications?pageSize=50', officer);
    await expectFast('branch manager scope', '/api/applications?pageSize=50', actors.branchManager('bm-1', 'branch-1'));
  });
});
