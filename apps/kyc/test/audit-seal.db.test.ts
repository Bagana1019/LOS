// Audit seal · `kyc.audit_log` (AML шийдвэрийн аудит). Бодит Postgres + миграц. Бүрэн хамрах хүрээ origination/test/audit-seal.db.test.ts-д.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_SEAL_COLUMNS, auditKeyringFromEnv, purgeAuditLogForTests, recordAudit, sealAuditLog, verifyAuditChain, waitUntilAuditRowsSealable, type AuditKeyring } from '@los/database';
import { PrismaService } from '../src/prisma.service';

const S = 'kyc';
const CFG = { schema: S, columns: AUDIT_SEAL_COLUMNS };
const K = auditKeyringFromEnv({ AUDIT_HMAC_KEY: 'kyc-test-audit-hmac-key-0123456789abcdef' }) as AuditKeyring;

describe.skipIf(!process.env.TEST_DATABASE_URL)('audit seal (kyc, Postgres)', () => {
  let db: PrismaService;
  const decide = (tx: Parameters<typeof recordAudit>[0], decision: string) => recordAudit(tx, {
    orgId: 'org-1', entity: 'AML_HIT', entityId: randomUUID(), action: 'AML_HIT_DECIDED', actorId: 'compliance-1', beforeJson: { status: 'OPEN' }, afterJson: { status: decision },
  });
  const purge = () => purgeAuditLogForTests(db, (tx) => tx.$executeRawUnsafe(`TRUNCATE "${S}"."audit_log", "${S}"."audit_seal"`));

  beforeAll(() => { db = new PrismaService(); });
  afterAll(async () => { await purge(); await db?.$disconnect(); });
  beforeEach(purge);

  it('seals every kyc.audit_log column (no drift); an AML decision rewritten after sealing is detected', async () => {
    const cols = await db.$queryRawUnsafe<{ c: string }[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'audit_log'`, S);
    expect(cols.map((c) => c.c).sort()).toEqual(AUDIT_SEAL_COLUMNS.map((c) => c.name).sort());
    await db.$transaction(async (tx) => { await decide(tx, 'CLEARED'); await decide(tx, 'CONFIRMED'); });
    await waitUntilAuditRowsSealable(db, S); // CI-д бусад багцын нээлттэй бичих транзакц xid horizon-г түр хойш татаж болно
    expect((await sealAuditLog(db, CFG, K)).seals).toEqual([expect.objectContaining({ seq: '1', rows: 2 })]);
    expect(await verifyAuditChain(db, CFG, K)).toMatchObject({ ok: true, sealedRows: 2 });

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."audit_log" DISABLE TRIGGER "audit_log_append_only"`);
      await tx.$executeRawUnsafe(`UPDATE "${S}"."audit_log" SET after_json = '{"status":"CLEARED"}' WHERE after_json->>'status' = 'CONFIRMED'`);
      await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."audit_log" ENABLE TRIGGER "audit_log_append_only"`);
    });
    expect((await verifyAuditChain(db, CFG, K)).firstBroken).toEqual({ seq: '1', reason: 'MAC_MISMATCH' });
  });
});
