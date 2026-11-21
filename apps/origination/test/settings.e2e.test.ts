import { type INestApplication } from '@nestjs/common';
import { SETTING_KEYS } from '@los/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma.service';
import { HAS_DB, as, createApp } from './app';

describe.skipIf(!HAS_DB)('origination settings (FR-13, CLAUDE.md §3.2.8)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const api = () => request(app.getHttpServer());
  beforeAll(async () => { app = await createApp(); db = app.get(PrismaService); });
  afterAll(async () => { await app.close(); });

  it('GET /api/health is 200 without identity', async () => {
    const res = await api().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ service: 'origination', ok: true });
    expect((await api().get('/api/health/ready')).body.checks).toEqual({ db: 'up' });
  });

  it('requires gateway identity headers', async () => {
    expect((await api().get('/api/settings')).status).toBe(401);
  });

  it('lists every registered setting, seeded with the DEMO defaults (BR-1 DTI 0.55, BR-3 LTV 0.7)', async () => {
    const res = await api().get('/api/settings').set(as('officerA'));
    expect(res.status).toBe(200);
    expect(res.body.map((s: { key: string }) => s.key)).toEqual(SETTING_KEYS);
    const get = (k: string) => res.body.find((s: { key: string }) => s.key === k);
    expect(get('br1.dti_max')).toMatchObject({ value: 0.55, isDefault: false });
    expect(get('br3.ltv_max').value).toBe(0.7);
  });

  it('GET /api/settings/:key (what other services call) and 404 for unknown keys', async () => {
    const res = await api().get('/api/settings/br2.dscr_min').set(as('approver'));
    expect(res.body).toMatchObject({ key: 'br2.dscr_min', value: 1.25 });
    expect((await api().get('/api/settings/nope.nope').set(as('approver'))).status).toBe(404);
  });

  it('only ADMIN may change a setting', async () => {
    for (const u of ['officerA', 'manager', 'approver'] as const) {
      expect((await api().put('/api/settings/inquiry.stale_days').set(as(u)).send({ value: 10 })).status).toBe(403);
    }
  });

  it('validates the value against the registry schema (400); an out-of-range credit-risk ratio is a 422 that names the range (F9-22)', async () => {
    expect((await api().put('/api/settings/br1.dti_max').set(as('admin')).send({})).status).toBe(400);
    expect((await api().put('/api/settings/br1.dti_max').set(as('admin')).send({ value: 'high' })).status).toBe(400);
    expect((await api().put('/api/settings/inquiry.stale_days').set(as('admin')).send({ value: -1 })).status).toBe(400);
    for (const value of [5, 0, 0.04, 1.01]) {
      const bad = await api().put('/api/settings/br1.dti_max').set(as('admin')).send({ value });
      expect(bad.status, String(value)).toBe(422);
      expect(bad.body).toMatchObject({ code: 'SETTING_OUT_OF_RANGE', details: { key: 'br1.dti_max', min: 0.05, max: 1 } });
      expect(bad.body.message).toContain('br1.dti_max');
    }
  });

  it('a change is saved, audited with before/after, and queued as SettingsChanged — atomically', async () => {
    const before = await db.outbox.count({ where: { type: 'SettingsChanged' } });
    const res = await api().put('/api/settings/inquiry.stale_days').set(as('admin')).set('x-correlation-id', 'corr-set-1').send({ value: 45 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'inquiry.stale_days', value: 45 });
    expect((await api().get('/api/settings/inquiry.stale_days').set(as('officerA'))).body.value).toBe(45);

    const audit = await db.auditLog.findFirstOrThrow({ where: { entity: 'SETTING', entityId: 'inquiry.stale_days', correlationId: 'corr-set-1' } });
    expect(audit).toMatchObject({ action: 'SETTING_UPDATED', beforeJson: { value: 30 }, afterJson: { value: 45 } });
    const events = await db.outbox.findMany({ where: { type: 'SettingsChanged' }, orderBy: { createdAt: 'desc' } });
    expect(events.length).toBe(before + 1);
    expect(events[0]!.payload).toMatchObject({ type: 'SettingsChanged', key: 'inquiry.stale_days', correlationId: 'corr-set-1', version: 1 });
    expect(events[0]!.publishedAt).toBeNull(); // OUTBOX_RELAY=off
  });

  it('a rejected change leaves no audit row and no event', async () => {
    const counts = async () => [await db.auditLog.count(), await db.outbox.count()];
    const [a, o] = await counts();
    await api().put('/api/settings/br1.dti_max').set(as('admin')).send({ value: 'high' });
    await api().put('/api/settings/br1.dti_max').set(as('admin')).send({ value: 0 }); // F9-22: хүрээнээс гарсан санал ч мөр үлдээхгүй
    expect(await counts()).toEqual([a, o]);
  });

  // F9-22: ӨОХ/ӨТЧХ/LTV/аргын босго/олголтын хязгаар нэг админаар шууд хадгалагддаг байсан → одоо санал → өөр хүний баталгаа
  describe('credit-risk thresholds need four eyes (F9-22)', () => {
    const propose = (key: string, value: unknown) => api().put(`/api/settings/${key}`).set(as('admin')).send({ value, reason: 'F9-22 тест' });
    const current = async (key: string) => (await api().get(`/api/settings/${key}`).set(as('officerA'))).body.value;

    it.each(['br1.dti_max', 'br2.dscr_min', 'br3.ltv_max', 'br4.method_weight_threshold', 'br10.disburse_not_exceed_approved'])('%s: a change becomes a PENDING request and the stored value does not move', async (key) => {
      const before = await current(key);
      const value = typeof before === 'boolean' ? !before : key === 'br2.dscr_min' ? 1.5 : 0.6;
      const res = await propose(key, value);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ outcome: 'PENDING', request: { targetId: key, status: 'PENDING' } });
      expect(await current(key)).toEqual(before);
      expect((await api().post(`/api/maker-checker/requests/${res.body.request.id}/cancel`).set(as('admin')).send({})).status).toBe(200); // DB-г цэвэр үлдээнэ
    });

    it('the maker cannot approve their own change; an approver applies it, and it is audited', async () => {
      const res = await propose('br1.dti_max', 0.65);
      expect(res.status).toBe(202);
      const id = res.body.request.id as string;
      const self = await api().post(`/api/maker-checker/requests/${id}/approve`).set(as('admin')).send({});
      expect(self.status).toBe(403);
      expect(self.body).toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
      expect(await current('br1.dti_max')).toBe(0.55);

      expect((await api().post(`/api/maker-checker/requests/${id}/approve`).set(as('approver')).send({})).status).toBe(200);
      expect(await current('br1.dti_max')).toBe(0.65);
      const audit = await db.auditLog.findFirstOrThrow({ where: { entity: 'SETTING', entityId: 'br1.dti_max' }, orderBy: { at: 'desc' } });
      expect(audit).toMatchObject({ action: 'SETTING_UPDATED', beforeJson: { value: 0.55 }, afterJson: { value: 0.65 } });

      // бусад тестэд нөлөөлөхгүй байхаар анхны утгыг сэргээнэ (мөн 4 нүдээр)
      const back = await propose('br1.dti_max', 0.55);
      expect((await api().post(`/api/maker-checker/requests/${back.body.request.id}/approve`).set(as('approver')).send({})).status).toBe(200);
      expect(await current('br1.dti_max')).toBe(0.55);
    });

    it('br9 stays a direct change path only for its single allowed value, and a non-credit key is still direct', async () => {
      expect((await api().put('/api/settings/inquiry.stale_days').set(as('admin')).send({ value: 30 })).status).toBe(200);
      expect((await api().put('/api/settings/br9.blacklist_mode').set(as('admin')).send({ value: 'WARN_ONLY' })).status).toBe(200);
    });
  });
});
