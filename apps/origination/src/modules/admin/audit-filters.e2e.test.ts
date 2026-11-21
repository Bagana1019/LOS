import { purgeAuditLogForTests } from '@los/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb } from '../../test-utils/factories';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { AdminModule } from './admin.module';

// F9-24 follow-up · /settings/audit "Зээлийн систем" таб: объект/үйлдлийн шүүлт том/жижиг үсэг үл ялгах + хэсэгчилсэн (gateway-тэй ижил helper).
// Маркер мөрүүд (ZQ_PROBE, ZQXPROBE, PCT%PROBE, BS\PROBE) нь "_", "%", "\" wildcard болохгүйг ялгана. Мөр бүр өвөрмөц org-д.
const ORG = `org-aud-w5-${process.pid}`;
const OTHER_ORG = `org-aud-w5-other-${process.pid}`;
const LEAK_ID = 'other-org-leak'; // OTHER_ORG мөрүүдийн entityId: хариу org-ийг агуулдаггүй тул энэ маркераар ил гарсныг илрүүлнэ
const admin = (orgId: string) => ({ 'x-user-id': 'admin-w5', 'x-roles': 'ADMIN', 'x-org-id': orgId });
const row = (orgId: string, entity: string, action: string, extra: { entityId?: string; actorId?: string } = {}) =>
  ({ orgId, entity, entityId: extra.entityId ?? `w5-${action}`, action, actorId: extra.actorId ?? null });

describe.skipIf(!hasTestDb)('origination audit-log filters (DB, F9-24 follow-up)', () => {
  let t: TestApp;
  const list = async (query: Record<string, string>, orgId = ORG) => {
    const res = await request(t.app.getHttpServer()).get('/api/audit-logs').query({ pageSize: '200', ...query }).set(admin(orgId));
    expect(res.status).toBe(200);
    return res.body as { total: number; items: Array<{ entity: string; action: string; entityId: string }> };
  };
  const entities = async (query: Record<string, string>, orgId = ORG) => (await list(query, orgId)).items.map((i) => i.entity).sort();
  const actions = async (query: Record<string, string>) => (await list(query)).items.map((i) => i.action).sort();

  const clean = () => purgeAuditLogForTests(t.prisma, (tx) => tx.auditLog.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } }));
  beforeAll(async () => {
    t = await createTestApp([AdminModule]);
    await clean();
    await t.prisma.auditLog.createMany({
      data: [
        row(ORG, 'SETTING', 'SETTING_UPDATED', { entityId: 'inquiry.stale_days', actorId: 'u-w5-1' }),
        row(ORG, 'SETTING', 'SETTING_CREATED'),
        row(ORG, 'CONTRACT_NUMBER_TEMPLATE', 'CONTRACT_TEMPLATE_UPDATED'),
        row(ORG, 'ZQ_PROBE', 'ZQ_PROBE_SEEN'),
        row(ORG, 'ZQXPROBE', 'ZQXPROBE_SEEN'),
        row(ORG, 'PCT%PROBE', 'PCT%PROBE_SEEN'),
        row(ORG, 'BS\\PROBE', 'BS\\PROBE_SEEN'),
        // Өөр байгууллагын мөрүүд: ямар ч шүүлтээр ORG-д харагдах ёсгүй
        row(OTHER_ORG, 'SETTING', 'SETTING_UPDATED', { entityId: LEAK_ID }),
        row(OTHER_ORG, 'ZQ_PROBE', 'ZQ_PROBE_SEEN', { entityId: LEAK_ID }),
        row(OTHER_ORG, 'PCT%PROBE', 'PCT%PROBE_SEEN', { entityId: LEAK_ID }),
      ],
    });
  });
  afterAll(async () => {
    await clean();
    await t.close();
  });

  describe('объект (entity)', () => {
    it('"setting" нь SETTING мөрүүдийг олно (хуучин: яг таарахгүй тул 0)', async () => {
      expect(await entities({ entity: 'setting' })).toEqual(['SETTING', 'SETTING']);
    });
    it('том/жижиг үсэг үл ялгана: "SETTING", "SeTtInG" хоёул ижил', async () => {
      expect((await list({ entity: 'SETTING' })).total).toBe(2);
      expect((await list({ entity: 'SeTtInG' })).total).toBe(2);
    });
    it('хэсэгчилсэн: эхэн "sett", дунд "ttin", төгсгөл "ing"', async () => {
      for (const part of ['sett', 'ttin', 'ing']) expect(await entities({ entity: part })).toEqual(['SETTING', 'SETTING']);
    });
    it('таарахгүй текст → 0', async () => {
      expect((await list({ entity: 'nope-nothing' })).total).toBe(0);
    });
    it('зөвхөн зай → шүүлтгүй (7 мөр)', async () => {
      expect((await list({ entity: '   ' })).total).toBe(7);
    });
  });

  describe('үйлдэл (action)', () => {
    it('"updated" нь SETTING_UPDATED, CONTRACT_TEMPLATE_UPDATED хоёуланг олно', async () => {
      expect(await actions({ action: 'updated' })).toEqual(['CONTRACT_TEMPLATE_UPDATED', 'SETTING_UPDATED']);
    });
    it('"setting_u" (литерал "_") нь зөвхөн SETTING_UPDATED', async () => {
      expect(await actions({ action: 'setting_u' })).toEqual(['SETTING_UPDATED']);
    });
    it('объект + үйлдэл хоёр нийлж огтлолцоно', async () => {
      expect(await actions({ entity: 'setting', action: 'created' })).toEqual(['SETTING_CREATED']);
    });
  });

  describe('"_", "%", "\\" нь wildcard биш', () => {
    it('"_" ганцаараа зөвхөн доогуур зураастай объектыг олно (ZQXPROBE, SETTING-ийг олохгүй)', async () => {
      expect(await entities({ entity: '_' })).toEqual(['CONTRACT_NUMBER_TEMPLATE', 'ZQ_PROBE']);
    });
    it('"zq_probe" нь ZQXPROBE-г олохгүй (LIKE-д escape-гүй _ = ямар ч тэмдэгт)', async () => {
      expect(await entities({ entity: 'zq_probe' })).toEqual(['ZQ_PROBE']);
      expect(await entities({ entity: 'q_p' })).toEqual(['ZQ_PROBE']);
    });
    it('"%" ганцаараа зөвхөн "%" агуулсан объектыг олно (бүх мөр биш)', async () => {
      expect(await entities({ entity: '%' })).toEqual(['PCT%PROBE']);
    });
    it('"sett%" нь SETTING-ийг олохгүй (% нь литерал)', async () => {
      expect((await list({ entity: 'sett%' })).total).toBe(0);
      expect(await entities({ entity: 'pct%p' })).toEqual(['PCT%PROBE']);
    });
    it('"\\" ганцаараа алдаа (500) өгөхгүй, литерал тэмдэгтээр хайна', async () => {
      expect(await entities({ entity: '\\' })).toEqual(['BS\\PROBE']);
      expect(await entities({ entity: 'bs\\p' })).toEqual(['BS\\PROBE']);
    });
    it('үйлдэл дээр ч ижил: "%" → зөвхөн PCT%PROBE_SEEN, "zq_" → зөвхөн ZQ_PROBE_SEEN', async () => {
      expect(await actions({ action: '%' })).toEqual(['PCT%PROBE_SEEN']);
      expect(await actions({ action: 'zq_' })).toEqual(['ZQ_PROBE_SEEN']);
    });
  });

  describe('байгууллагын хязгаар (өөр org-ийн мөр хэзээ ч ил гарахгүй)', () => {
    const cases: Array<[Record<string, string>, number]> = [
      [{}, 7], [{ entity: 'setting' }, 2], [{ entity: 'sett' }, 2], [{ entity: '_' }, 2], [{ entity: '%' }, 1], [{ action: 'updated' }, 2], [{ entity: 'zq_probe' }, 1],
    ];
    it.each(cases)('шүүлт %o: ORG-д яг %i мөр, OTHER_ORG-ийн мөр байхгүй', async (filter, expected) => {
      const res = await list(filter);
      expect(res.total).toBe(expected);
      expect(res.items.some((i) => i.entityId === LEAK_ID)).toBe(false);
    });
    it('OTHER_ORG зөвхөн өөрийн мөрийг харна (шүүлтгүй 3, "setting" 1, "%" 1)', async () => {
      const all = await list({}, OTHER_ORG);
      expect(all.total).toBe(3);
      expect(all.items.every((i) => i.entityId === LEAK_ID)).toBe(true);
      expect(await entities({ entity: 'setting' }, OTHER_ORG)).toEqual(['SETTING']);
      expect(await entities({ entity: '%' }, OTHER_ORG)).toEqual(['PCT%PROBE']);
    });
  });

  describe('бусад шүүлт өмнөх шигээ яг таарна', () => {
    it('entityId: яг таарна, хэсэгчилсэн биш', async () => {
      expect((await list({ entityId: 'inquiry.stale_days' })).total).toBe(1);
      expect((await list({ entityId: 'stale' })).total).toBe(0);
    });
    it('actorId: яг таарна, хэсэгчилсэн биш', async () => {
      expect((await list({ actorId: 'u-w5-1' })).total).toBe(1);
      expect((await list({ actorId: 'u-w5' })).total).toBe(0);
    });
    it('хуудаслалт: total нь шүүлттэй, items нь хуудастай', async () => {
      const page = await list({ entity: 'setting', pageSize: '1', page: '2' });
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(1);
    });
  });
});
