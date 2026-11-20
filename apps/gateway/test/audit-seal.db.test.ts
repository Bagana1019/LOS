// Audit seal · gateway `iam.audit_log` (нэмэлт ip / user_agent, org_id nullable, id/at клиентэд үүснэ). Бодит Postgres + миграц.
// Гинжний бүрэн хамрах хүрээ (тамперын бүх төрөл, зэрэгцээ бичилт, түгжээ) origination/test/audit-seal.db.test.ts-д.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GATEWAY_AUDIT_SEAL_COLUMNS, auditKeyringFromEnv, insertAuditRow, insertAuditRows, purgeAuditLogForTests, sealAuditLog, verifyAuditChain, type AuditKeyring } from '@los/database';
import { PrismaService } from '../src/prisma.service';

const S = 'iam';
const CFG = { schema: S, columns: GATEWAY_AUDIT_SEAL_COLUMNS };
const K = auditKeyringFromEnv({ AUDIT_HMAC_KEY: 'gateway-test-audit-hmac-key-0123456789abcdef' }) as AuditKeyring;

describe.skipIf(!process.env.TEST_DATABASE_URL)('audit seal (gateway iam, Postgres)', () => {
  let db: PrismaService;
  const row = (action: string, over: Record<string, unknown> = {}) => ({
    id: randomUUID(), at: new Date('2026-11-19T10:00:00.123Z'), orgId: null, entity: 'HTTP', entityId: 'POST /api/x', action, actorId: 'u1',
    afterJson: { status: 201 }, beforeJson: null, applicationId: null, correlationId: 'c1', ip: '10.0.0.1', userAgent: 'vitest', ...over,
  });
  const tamper = (sql: string, ...v: unknown[]) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."audit_log" DISABLE TRIGGER "audit_log_append_only"`);
    await tx.$executeRawUnsafe(sql, ...v);
    await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."audit_log" ENABLE TRIGGER "audit_log_append_only"`);
  });

  beforeAll(() => { db = new PrismaService(); });
  afterAll(async () => {
    await purgeAuditLogForTests(db, (tx) => tx.$executeRawUnsafe(`TRUNCATE "${S}"."audit_log", "${S}"."audit_seal"`));
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await purgeAuditLogForTests(db, (tx) => tx.$executeRawUnsafe(`TRUNCATE "${S}"."audit_log", "${S}"."audit_seal"`));
  });

  it('seals every iam.audit_log column (no drift) and verifies', async () => {
    const cols = await db.$queryRawUnsafe<{ c: string }[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'audit_log'`, S);
    expect(cols.map((c) => c.c).sort()).toEqual(GATEWAY_AUDIT_SEAL_COLUMNS.map((c) => c.name).sort());
    await insertAuditRow(db, row('LOGIN_SUCCESS', { orgId: 'org-1' }));
    await insertAuditRows(db, [row('HTTP_1'), row('HTTP_2')], { skipDuplicates: true }); // fallback drain-ийн зам
    expect((await sealAuditLog(db, CFG, K)).seals).toEqual([expect.objectContaining({ seq: '1', rows: 3 })]);
    expect(await verifyAuditChain(db, CFG, K)).toMatchObject({ ok: true, seals: 1, sealedRows: 3, unsealedRows: 0 });
  });

  it('detects a rewritten ip / user agent (gateway-only columns) and a deleted login row', async () => {
    const login = row('LOGIN_FAILED');
    await insertAuditRows(db, [login, row('HTTP_1')]);
    await sealAuditLog(db, CFG, K);
    await tamper(`UPDATE "${S}"."audit_log" SET ip = '203.0.113.9' WHERE id = $1`, login.id);
    expect((await verifyAuditChain(db, CFG, K)).firstBroken).toEqual({ seq: '1', reason: 'MAC_MISMATCH' });
    await tamper(`UPDATE "${S}"."audit_log" SET ip = '10.0.0.1', user_agent = 'curl' WHERE id = $1`, login.id);
    expect((await verifyAuditChain(db, CFG, K)).firstBroken).toEqual({ seq: '1', reason: 'MAC_MISMATCH' });
    await tamper(`DELETE FROM "${S}"."audit_log" WHERE id = $1`, login.id);
    expect((await verifyAuditChain(db, CFG, K)).firstBroken).toMatchObject({ seq: '1', reason: 'ROW_COUNT_MISMATCH' });
  });
});
