import { randomUUID } from 'node:crypto';
import { type INestApplication, Logger } from '@nestjs/common';
import { SEED, purgeAuditLogForTests } from '@los/database';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { AUDIT_FALLBACK_QUEUE, type AuditFallbackQueue } from '../src/modules/audit/audit-fallback-queue';
import { AuditService } from '../src/modules/audit/audit.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

// M10 — iam.audit_log append-only (DB trigger) + gateway аудит fire-and-forget биш (retry → fallback queue → fail closed).
describe.skipIf(!HAS_DB)('iam.audit_log immutability + durable gateway audit (M10)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const run = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p);
  const login = () => request(app.getHttpServer()).post('/api/auth/login').send({ username: SEED.users.officerA.username, password: PASSWORD });

  // Prisma delegate-ийн `create` нь proxy-оор ирдэг тул vi.spyOn/restore биш гараар солиод сэргээнэ
  type CreateFn = (args: { data: { action: string } }) => Promise<unknown>;
  let realCreate: CreateFn;
  const stubCreate = (impl: CreateFn) => {
    const fn = vi.fn(impl);
    (prisma.auditLog as unknown as { create: CreateFn }).create = fn;
    return fn;
  };
  beforeAll(async () => {
    ({ app, prisma } = await createGateway());
    realCreate = (prisma.auditLog.create as unknown as CreateFn).bind(prisma.auditLog);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    (prisma.auditLog as unknown as { create: CreateFn }).create = realCreate;
  });
  afterAll(async () => { await app.close(); });

  describe('database trigger', () => {
    it('INSERT still works; UPDATE / DELETE / TRUNCATE are rejected and the row is unchanged', async () => {
      const id = randomUUID();
      await prisma.auditLog.create({ data: { id, entity: 'TEST', entityId: 'immut', action: 'PROBE', afterJson: { v: 1 } } });
      await expect(run(`UPDATE iam.audit_log SET action = 'TAMPERED' WHERE id = $1`, id)).rejects.toThrow(/append-only/);
      await expect(prisma.auditLog.update({ where: { id }, data: { actorId: 'x' } })).rejects.toThrow(/append-only/);
      await expect(run(`DELETE FROM iam.audit_log WHERE id = $1`, id)).rejects.toThrow(/append-only/);
      await expect(prisma.auditLog.deleteMany({ where: { id } })).rejects.toThrow(/append-only/);
      await expect(run(`TRUNCATE iam.audit_log`)).rejects.toThrow(/append-only/);
      const row = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ action: 'PROBE', actorId: null, afterJson: { v: 1 } });
    });

    it('a lone surrogate / NUL in client input is sanitized and persisted by real Postgres (not dead-lettered)', async () => {
      const correlationId = randomUUID();
      await app.get(AuditService).record({ entity: 'HTTP', entityId: 'POST /api/a\uD800b\u0000c', action: 'PROBE', correlationId, userAgent: 'ua\uDC00\u0000', afterJson: { username: 'x\uD83D\u0000y' } });
      const row = await prisma.auditLog.findFirstOrThrow({ where: { correlationId } });
      expect(row).toMatchObject({ entityId: 'POST /api/a�bc', userAgent: 'ua�', afterJson: { username: 'x�y' } });
    });

    it('test-only purge helper still lets suites clean up (refused outside NODE_ENV=test)', async () => {
      const id = randomUUID();
      await prisma.auditLog.create({ data: { id, entity: 'TEST', entityId: 'purge', action: 'PROBE' } });
      await purgeAuditLogForTests(prisma, (tx) => tx.auditLog.deleteMany({ where: { id } }));
      expect(await prisma.auditLog.count({ where: { id } })).toBe(0);
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try { await expect(purgeAuditLogForTests(prisma, async () => undefined)).rejects.toThrow(/test/); } finally { process.env.NODE_ENV = prev; }
    });
  });

  describe('login audit is durable', () => {
    const quiet = () => { vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); };

    it('a transient DB failure on the audit write is retried and the LOGIN_SUCCESS row is not lost', async () => {
      quiet();
      let failed = false;
      const spy = stubCreate(async (args) => {
        if (!failed && args.data.action === 'LOGIN_SUCCESS') { failed = true; throw new Error('Connection terminated unexpectedly'); }
        return realCreate(args);
      });
      const correlationId = randomUUID();
      const res = await login().set('x-correlation-id', correlationId);
      expect(res.status).toBe(200);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(await prisma.auditLog.count({ where: { action: 'LOGIN_SUCCESS', correlationId } })).toBe(1);
    });

    it('when the DB stays down the record is parked in the fallback queue and drained later', async () => {
      quiet();
      const queue = app.get<AuditFallbackQueue>(AUDIT_FALLBACK_QUEUE);
      stubCreate(async (args) => {
        if (args.data.action === 'LOGIN_SUCCESS') throw new Error('db down');
        return realCreate(args);
      });
      const correlationId = randomUUID();
      expect((await login().set('x-correlation-id', correlationId)).status).toBe(200);
      expect(await prisma.auditLog.count({ where: { action: 'LOGIN_SUCCESS', correlationId } })).toBe(0);
      expect(await queue.size()).toBeGreaterThanOrEqual(1);
      vi.restoreAllMocks();
      await app.get(AuditService).drainFallback();
      expect(await prisma.auditLog.count({ where: { action: 'LOGIN_SUCCESS', correlationId } })).toBe(1);
    });

    it('fails CLOSED with 503 when the audit cannot be persisted anywhere (no tokens issued)', async () => {
      quiet();
      const queue = app.get<AuditFallbackQueue>(AUDIT_FALLBACK_QUEUE);
      stubCreate(async () => { throw new Error('db down'); });
      vi.spyOn(queue, 'push').mockRejectedValue(new Error('redis down'));
      const res = await login();
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('AUDIT_UNAVAILABLE');
      expect(res.body.accessToken).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('a failed login is also fail-closed (503, not a silent 401) when unauditable', async () => {
      quiet();
      stubCreate(async () => { throw new Error('db down'); });
      vi.spyOn(app.get<AuditFallbackQueue>(AUDIT_FALLBACK_QUEUE), 'push').mockRejectedValue(new Error('redis down'));
      const res = await request(app.getHttpServer()).post('/api/auth/login').send({ username: SEED.users.officerA.username, password: 'wrong-Passw0rd!' });
      expect(res.status).toBe(503);
      await prisma.user.updateMany({ data: { failedLoginCount: 0, lockedUntil: null } });
    });
  });
});
