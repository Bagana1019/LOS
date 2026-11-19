// M10 (dms): retention sweeper — retention_policy-г хэрэглэж хугацаа нь дууссан файлыг storage-оос устгаж `purged_at` тэмдэглэнэ.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SEED } from '@los/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { OBJECT_STORAGE, type MemoryStorage } from '../src/modules/file/storage';
import { RetentionService } from '../src/modules/retention/retention.service';
import { RetentionSweeper, parseRetentionConfig } from '../src/modules/retention/retention.sweeper';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const ORG = SEED.org.id;
const YEAR_MS = 366 * 24 * 3600 * 1000;

describe('parseRetentionConfig', () => {
  it('interval: default 3600s, "0" disables, invalid → default + warning, clamped; batch: default 100, 1..1000', () => {
    expect(parseRetentionConfig({})).toMatchObject({ seconds: 3600, batch: 100 });
    expect(parseRetentionConfig({ DMS_RETENTION_SWEEP_SECONDS: '0' }).seconds).toBe(0);
    expect(parseRetentionConfig({ DMS_RETENTION_SWEEP_SECONDS: 'abc' })).toMatchObject({ seconds: 3600, warnings: [expect.stringContaining('DMS_RETENTION_SWEEP_SECONDS')] });
    expect(parseRetentionConfig({ DMS_RETENTION_SWEEP_SECONDS: '999999' }).seconds).toBe(86400);
    expect(parseRetentionConfig({ DMS_RETENTION_BATCH_SIZE: '5' }).batch).toBe(5);
    expect(parseRetentionConfig({ DMS_RETENTION_BATCH_SIZE: '0' })).toMatchObject({ batch: 100, warnings: [expect.stringContaining('DMS_RETENTION_BATCH_SIZE')] });
    expect(parseRetentionConfig({ DMS_RETENTION_BATCH_SIZE: '50000' }).batch).toBe(1000);
  });
});

describe.skipIf(!HAS_DB)('dms retention sweeper (M10, retention_policy)', () => {
  let app: INestApplication;
  let db: PrismaService;
  let storage: MemoryStorage;
  let service: RetentionService;

  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    db = app.get(PrismaService);
    storage = app.get(OBJECT_STORAGE);
    service = app.get(RetentionService);
  });
  afterAll(async () => {
    await db.retentionPolicy.updateMany({ where: { orgId: ORG, entityType: 'APPLICATION_DOCUMENT' }, data: { retentionYears: 5, autoDelete: false } }); // seed утга
    await app.close();
  });
  beforeEach(async () => {
    await db.document.deleteMany({ where: { orgId: ORG, applicationId: { startsWith: 'ret-' } } });
    await db.file.updateMany({ where: { orgId: ORG, purgedAt: null }, data: { purgedAt: new Date() } }); // бусад тестийн файл энэ тестэд оролцохгүй
    await db.retentionPolicy.updateMany({ where: { orgId: ORG, entityType: 'APPLICATION_DOCUMENT' }, data: { retentionYears: 1, autoDelete: true } });
  });

  /** Файл + (сонголтоор) хүсэлтийн баримт. `ageYears` — хэдэн жилийн өмнө байршуулсан. */
  async function seedFile(o: { ageYears: number; attached?: boolean; legalHold?: boolean; name?: string }) {
    const storageKey = `${ORG}/ret/${randomUUID()}`;
    await storage.put(storageKey, Buffer.from('%PDF-1.7 retention'), 'application/pdf');
    const file = await db.file.create({
      data: {
        orgId: ORG, bucket: storage.bucket, storageKey, name: o.name ?? 'tsalin-Болд.pdf', mime: 'application/pdf', size: 18, sha256: 'x',
        createdAt: new Date(Date.now() - o.ageYears * YEAR_MS), legalHold: o.legalHold ?? false,
      },
    });
    if (o.attached !== false) {
      await db.document.create({ data: { orgId: ORG, applicationId: `ret-${randomUUID()}`, type: 'INCOME_PROOF', relatedEntity: 'APPLICATION', fileId: file.id } });
    }
    return file;
  }
  const row = (id: string) => db.file.findUniqueOrThrow({ where: { id } });

  it('purges an expired application document: object removed, row marked, retention_until stamped from the policy', async () => {
    const f = await seedFile({ ageYears: 2 });
    const r = await service.sweep(new Date(), 100);
    expect(r).toMatchObject({ purged: 1, failed: 0 });
    const after = await row(f.id);
    expect(after.purgedAt).not.toBeNull();
    expect(after.retentionUntil?.getTime()).toBe(new Date(f.createdAt).setUTCFullYear(f.createdAt.getUTCFullYear() + 1));
    expect(storage.objects.has(f.storageKey)).toBe(false);
  });

  it('leaves not-yet-expired files (stamped, kept) and legally held files untouched', async () => {
    const young = await seedFile({ ageYears: 0 });
    const held = await seedFile({ ageYears: 3, legalHold: true });
    const r = await service.sweep(new Date(), 100);
    expect(r.purged).toBe(0);
    const y = await row(young.id);
    expect(y.purgedAt).toBeNull();
    expect(y.retentionUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await row(held.id)).purgedAt).toBeNull();
    expect(storage.objects.has(young.storageKey) && storage.objects.has(held.storageKey)).toBe(true);
  });

  it('auto_delete=false (seed default) never purges; unattached files (possibly referenced by another service) are never touched', async () => {
    const orphan = await seedFile({ ageYears: 9, attached: false });
    const doc = await seedFile({ ageYears: 9 });
    await db.retentionPolicy.updateMany({ where: { orgId: ORG, entityType: 'APPLICATION_DOCUMENT' }, data: { autoDelete: false } });
    expect((await service.sweep(new Date(), 100)).purged).toBe(0);
    expect((await row(doc.id)).purgedAt).toBeNull();
    const o = await row(orphan.id);
    expect(o).toMatchObject({ purgedAt: null, retentionUntil: null });
    expect(storage.objects.has(orphan.storageKey)).toBe(true);
  });

  it('a file used by a contract template is never purged', async () => {
    const f = await seedFile({ ageYears: 4 });
    const tpl = await db.contractTemplate.create({ data: { orgId: ORG, type: 'LOAN_CONTRACT', name: 'ret-tpl', docxFileId: f.id } });
    try {
      expect((await service.sweep(new Date(), 100)).purged).toBe(0);
      expect((await row(f.id)).purgedAt).toBeNull();
    } finally { await db.contractTemplate.delete({ where: { id: tpl.id } }); }
  });

  it('is batch-limited and idempotent: 3 expired with batch 2 → 2, then 1, then 0', async () => {
    for (let i = 0; i < 3; i++) await seedFile({ ageYears: 2 });
    expect((await service.sweep(new Date(), 2)).purged).toBe(2);
    expect((await service.sweep(new Date(), 2)).purged).toBe(1);
    expect((await service.sweep(new Date(), 2)).purged).toBe(0);
  });

  it('a storage failure keeps the row for the next tick (no "purged" mark without deleting the object)', async () => {
    const f = await seedFile({ ageYears: 2 });
    const spy = vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error('minio down'));
    try {
      expect(await service.sweep(new Date(), 100)).toMatchObject({ purged: 0, failed: 1 });
      expect((await row(f.id)).purgedAt).toBeNull();
    } finally { spy.mockRestore(); }
    expect((await service.sweep(new Date(), 100)).purged).toBe(1);
  });

  it('two concurrent ticks (two pods) purge each file exactly once (advisory lock); logs carry counts only, no file names', async () => {
    const files = [await seedFile({ ageYears: 2, name: 'нууц-нэр.pdf' }), await seedFile({ ageYears: 2, name: 'нууц-нэр.pdf' })];
    const removes = vi.spyOn(storage, 'remove');
    const logs: string[] = [];
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    try {
      const podA = new RetentionSweeper(service, db);
      const podB = new RetentionSweeper(service, db);
      const [a, b] = await Promise.all([podA.tick(), podB.tick()]);
      expect(a.purged + b.purged).toBe(2);
      expect(removes).toHaveBeenCalledTimes(2);
      for (const f of files) expect((await row(f.id)).purgedAt).not.toBeNull();
      const joined = logs.join('\n');
      expect(joined).toMatch(/purged=2/);
      expect(joined).not.toMatch(/нууц-нэр|\/ret\//);
    } finally { removes.mockRestore(); logSpy.mockRestore(); }
  });
});
