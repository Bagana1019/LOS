import { randomUUID } from 'node:crypto';
import { PrismaClient } from '.prisma/client-kyc';
import { hasTestDatabase } from '@los/config/vitest/test-db.mjs';
import { purgeAuditLogForTests } from '@los/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// M10 — kyc.audit_log append-only (DB trigger): UPDATE/DELETE/TRUNCATE хориотой, INSERT хэвээр.
describe.skipIf(!hasTestDatabase())('kyc.audit_log is append-only (M10)', () => {
  let db: PrismaClient;
  const run = (sql: string, ...p: unknown[]) => db.$executeRawUnsafe(sql, ...p);
  beforeAll(() => { db = new PrismaClient(); });
  afterAll(async () => { await db.$disconnect(); });

  it('INSERT works; UPDATE / DELETE / TRUNCATE raise and the row is unchanged', async () => {
    const id = randomUUID();
    await db.auditLog.create({ data: { id, orgId: 'org-immut', entity: 'aml_hit', entityId: 'x', action: 'PROBE', afterJson: { v: 1 } } });
    await expect(run(`UPDATE kyc.audit_log SET action = 'TAMPERED' WHERE id = $1`, id)).rejects.toThrow(/append-only/);
    await expect(run(`DELETE FROM kyc.audit_log WHERE id = $1`, id)).rejects.toThrow(/append-only/);
    await expect(db.auditLog.deleteMany({ where: { id } })).rejects.toThrow(/append-only/);
    await expect(run(`TRUNCATE kyc.audit_log`)).rejects.toThrow(/append-only/);
    expect(await db.auditLog.findUniqueOrThrow({ where: { id } })).toMatchObject({ action: 'PROBE', afterJson: { v: 1 } });
    await purgeAuditLogForTests(db, (tx) => tx.auditLog.deleteMany({ where: { orgId: 'org-immut' } }));
    expect(await db.auditLog.count({ where: { id } })).toBe(0);
  });
});
