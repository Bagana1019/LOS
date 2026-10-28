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

  it('validates the value against the registry schema (400)', async () => {
    const bad = await api().put('/api/settings/br1.dti_max').set(as('admin')).send({ value: 5 });
    expect(bad.status).toBe(400);
    expect((await api().put('/api/settings/br1.dti_max').set(as('admin')).send({})).status).toBe(400);
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
    expect(await counts()).toEqual([a, o]);
  });
});
