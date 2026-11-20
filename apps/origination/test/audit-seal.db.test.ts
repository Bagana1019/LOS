// Audit seal (docs/DECISIONS.md 2026-11-19 · audit seal) — бодит Postgres + бодит миграц (append-only + tx_id trigger).
// Tamper-ийг ЗӨВХӨН тестэд, хүснэгт эзэмшигч/superuser-ээр trigger-ийг транзакц дотор түр унтрааж дуурайна (production код сулрахгүй).
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_SEAL_COLUMNS, advisoryLockKey, auditKeyringFromEnv, insertAuditRow, purgeAuditLogForTests, runAuditSealCli, sealAuditLog, verifyAuditChain, type AuditKeyring, type AuditSealDb } from '@los/database';
import { AuditSealerHost } from '@los/nest-common';
import { PrismaService } from '../src/prisma.service';

const S = 'origination';
const CFG = { schema: S, columns: AUDIT_SEAL_COLUMNS };
const KEY_A = 'test-audit-hmac-key-A-0123456789abcdef0123';
const KEY_B = 'test-audit-hmac-key-B-0123456789abcdef0123';
const ring = (env: Record<string, string>) => auditKeyringFromEnv(env) as AuditKeyring;
const K1 = ring({ AUDIT_HMAC_KEY: KEY_A, AUDIT_HMAC_KEY_ID: 'k1' });
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.TEST_DATABASE_URL)('audit seal (origination, Postgres)', () => {
  let db: PrismaService;
  const orgId = `org-seal-${randomUUID()}`;
  const row = (action: string) => ({ orgId, entity: 'TEST', entityId: randomUUID(), action, actorId: 'u1', afterJson: { b: 2, a: [1, { z: 1, y: null }] } });
  const insert = (n: number, action = 'SEAL_TEST') => db.$transaction(async (tx) => { for (let i = 0; i < n; i += 1) await insertAuditRow(tx, row(`${action}_${i}`)); });
  const count = async (t: 'audit_log' | 'audit_seal') => (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${S}"."${t}"`))[0]!.n;
  /** Trigger-ийг ЭНЭ транзакцид л унтрааж SQL ажиллуулна (DDL транзакцтай буцна). */
  const tamper = (table: 'audit_log' | 'audit_seal', trigger: string, sql: string, ...v: unknown[]) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."${table}" DISABLE TRIGGER "${trigger}"`);
    await tx.$executeRawUnsafe(sql, ...v);
    await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."${table}" ENABLE TRIGGER "${trigger}"`);
  });
  const ids = async () => (await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${S}"."audit_log" ORDER BY tx_id, id COLLATE "C"`)).map((r) => r.id);
  const sealRows = () => db.$queryRawUnsafe<{ seq: string; mac: string }[]>(`SELECT s.seq::text AS seq, s.mac FROM "${S}"."audit_seal" s ORDER BY s.seq`);

  beforeAll(() => { db = new PrismaService(); });
  afterAll(async () => { await db?.$disconnect(); });
  beforeEach(async () => {
    await purgeAuditLogForTests(db, (tx) => tx.$executeRawUnsafe(`TRUNCATE "${S}"."audit_log", "${S}"."audit_seal"`));
  });

  it('stamps every row with its writer transaction id (trigger overrides any client value) and has no column drift', async () => {
    await insert(2);
    await db.$executeRawUnsafe(`INSERT INTO "${S}"."audit_log" (id, org_id, entity, entity_id, action, tx_id) VALUES ($1, $2, 'T', 'e', 'FORGED_TX', '1'::xid8)`, randomUUID(), orgId);
    const tx = await db.$queryRawUnsafe<{ action: string; tx_id: string }[]>(`SELECT action, tx_id::text AS tx_id FROM "${S}"."audit_log" ORDER BY action`);
    expect(tx).toHaveLength(3);
    expect(tx[0]!.tx_id).not.toBe('1');
    expect(tx[1]!.tx_id).toBe(tx[2]!.tx_id); // нэг транзакцын хоёр мөр
    const cols = await db.$queryRawUnsafe<{ c: string }[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'audit_log'`, S);
    expect(cols.map((c) => c.c).sort()).toEqual(AUDIT_SEAL_COLUMNS.map((c) => c.name).sort());
  });

  it('seals committed rows in batches into a linked chain that verifies; re-running is a no-op (idempotent)', async () => {
    await insert(7);
    const r = await sealAuditLog(db, CFG, K1, { batchSize: 3 });
    expect(r).toMatchObject({ locked: false, seals: [{ seq: '1', rows: 3 }, { seq: '2', rows: 3 }, { seq: '3', rows: 1 }] });
    const seals = await db.$queryRawUnsafe<{ seq: string; prev_mac: string | null; mac: string; key_id: string }[]>(`SELECT s.seq::text AS seq, s.prev_mac, s.mac, s.key_id FROM "${S}"."audit_seal" s ORDER BY s.seq`);
    expect(seals[0]!.prev_mac).toBeNull();
    expect(seals[1]!.prev_mac).toBe(seals[0]!.mac);
    expect(seals[2]!.prev_mac).toBe(seals[1]!.mac);
    expect(seals.every((s) => s.key_id === 'k1' && /^[0-9a-f]{64}$/.test(s.mac))).toBe(true);
    expect(await verifyAuditChain(db, CFG, K1)).toEqual({ ok: true, seals: 3, sealedRows: 7, unsealedRows: 0, backlogBelowHorizon: 0, anchored: false, last: { seq: '3', mac: seals[2]!.mac }, firstBroken: null });

    expect((await sealAuditLog(db, CFG, K1, { batchSize: 3 })).seals).toEqual([]);
    expect(await count('audit_seal')).toBe(3);
    await insert(2);
    expect(await verifyAuditChain(db, CFG, K1)).toMatchObject({ ok: true, unsealedRows: 2 });
    expect((await sealAuditLog(db, CFG, K1)).seals).toEqual([expect.objectContaining({ seq: '4', rows: 2 })]);
  });

  it('orders numerically across digit boundaries (tx_id 9 < 10 < 100, seq 9 < 10) — regression for text-alias ORDER BY', async () => {
    for (const t of ['100', '10', '9']) {
      await tamper('audit_log', 'audit_log_stamp_tx_id', `INSERT INTO "${S}"."audit_log" (id, org_id, entity, entity_id, action, tx_id) VALUES ($1, $2, 'T', 'e', 'ORDER', $3::xid8)`, randomUUID(), orgId, t);
    }
    expect((await sealAuditLog(db, CFG, K1, { batchSize: 2 })).seals.map((s) => s.rows)).toEqual([2, 1]);
    expect((await db.$queryRawUnsafe<{ t: string }[]>(`SELECT last_tx_id::text AS t FROM "${S}"."audit_seal" s ORDER BY s.seq`)).map((r) => r.t)).toEqual(['10', '100']);
    await insert(12);
    expect((await sealAuditLog(db, CFG, K1, { batchSize: 1 })).seals.map((s) => s.seq).slice(-3)).toEqual(['12', '13', '14']);
    expect(await verifyAuditChain(db, CFG, K1, { pageSize: 4 })).toMatchObject({ ok: true, seals: 14, sealedRows: 15, unsealedRows: 0 });
  });

  describe('verify detects tampering', () => {
    beforeEach(async () => {
      await insert(6);
      await sealAuditLog(db, CFG, K1, { batchSize: 3 });
    });

    it('(a) an altered json field → MAC_MISMATCH at the seal that covers the row', async () => {
      const [, , , fourth] = await ids();
      await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET after_json = '{"b":3}' WHERE id = $1`, fourth);
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '2', reason: 'MAC_MISMATCH' });
    });
    it('(a) a 1ms timestamp change or a changed actor → MAC_MISMATCH', async () => {
      const [first, second] = await ids();
      await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET at = at + interval '1 millisecond' WHERE id = $1`, first);
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '1', reason: 'MAC_MISMATCH' });
      await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET at = at - interval '1 millisecond', actor_id = 'someone-else' WHERE id = $1`, first);
      await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET actor_id = 'u1' WHERE id = $1`, first);
      expect((await verifyAuditChain(db, CFG, K1)).ok).toBe(true); // буцааж зассан бол дахин хүчинтэй (детерминист)
      await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET actor_id = NULL WHERE id = $1`, second);
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '1', reason: 'MAC_MISMATCH' });
    });
    it('(a) whitespace/key-order-only JSON rewrites are NOT tampering (canonical form)', async () => {
      const [first] = await ids();
      await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET after_json = '{ "a": [1, {"y": null, "z": 1}], "b": 2 }' WHERE id = $1`, first);
      expect((await verifyAuditChain(db, CFG, K1)).ok).toBe(true);
    });
    it('(b) a deleted row (gap) → ROW_COUNT_MISMATCH', async () => {
      const [, second] = await ids();
      await tamper('audit_log', 'audit_log_append_only', `DELETE FROM "${S}"."audit_log" WHERE id = $1`, second);
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '1', reason: 'ROW_COUNT_MISMATCH', expectedRows: 3, actualRows: 2 });
    });
    it('(c) reordered rows (two rows swap ids, i.e. position ↔ content) → MAC_MISMATCH', async () => {
      const [first, second] = await ids();
      const swap = `${first!}-swap`;
      await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET id = $2::text WHERE id = $1::text`, first, swap);
      await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET id = $2::text WHERE id = $1::text`, second, first);
      await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET id = $2::text WHERE id = $1::text`, swap, second);
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '1', reason: 'MAC_MISMATCH' });
    });
    it('(c) a back-dated forged row slipped into a sealed range → ROW_COUNT_MISMATCH', async () => {
      const all = await ids();
      const firstTx = (await db.$queryRawUnsafe<{ t: string }[]>(`SELECT min(tx_id)::text AS t FROM "${S}"."audit_log"`))[0]!.t;
      await tamper('audit_log', 'audit_log_stamp_tx_id', `INSERT INTO "${S}"."audit_log" (id, org_id, entity, entity_id, action, tx_id) VALUES ($1, $2, 'T', 'e', 'FORGED', $3::xid8)`, `${all[0]!}0`, orgId, firstTx);
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toMatchObject({ seq: '1', reason: 'ROW_COUNT_MISMATCH', actualRows: 4 });
    });
    it('a deleted middle seal → SEQ_GAP; swapped seals → PREV_MAC_MISMATCH', async () => {
      await insert(1);
      expect((await sealAuditLog(db, CFG, K1)).seals).toEqual([expect.objectContaining({ seq: '3' })]);
      await tamper('audit_seal', 'audit_seal_append_only', `UPDATE "${S}"."audit_seal" SET prev_mac = repeat('0', 64) WHERE seq = 2`);
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '2', reason: 'PREV_MAC_MISMATCH' });
      await tamper('audit_seal', 'audit_seal_append_only', `DELETE FROM "${S}"."audit_seal" WHERE seq = 2`);
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '2', reason: 'SEQ_GAP' });
    });
    it('truncated tail seals are invisible inside the DB but caught by the logged anchor', async () => {
      const seals = await sealRows();
      expect((await verifyAuditChain(db, CFG, K1, { anchor: seals[1]! })).ok).toBe(true);
      expect((await verifyAuditChain(db, CFG, K1, { anchor: { seq: '2', mac: seals[0]!.mac } })).firstBroken).toEqual({ seq: '2', reason: 'ANCHOR_MISMATCH' });
      await tamper('audit_seal', 'audit_seal_append_only', `DELETE FROM "${S}"."audit_seal" WHERE seq = 2`);
      expect(await verifyAuditChain(db, CFG, K1)).toMatchObject({ ok: true, unsealedRows: 3 }); // DB дотроос харагдахгүй
      expect((await verifyAuditChain(db, CFG, K1, { anchor: seals[1]! })).firstBroken).toEqual({ seq: '2', reason: 'ANCHOR_MISMATCH' });
    });
    it('(d) the wrong key → MAC_MISMATCH at seq 1; an unknown key id → UNKNOWN_KEY', async () => {
      expect((await verifyAuditChain(db, CFG, ring({ AUDIT_HMAC_KEY: KEY_B, AUDIT_HMAC_KEY_ID: 'k1' }))).firstBroken).toEqual({ seq: '1', reason: 'MAC_MISMATCH' });
      expect((await verifyAuditChain(db, CFG, ring({ AUDIT_HMAC_KEY: KEY_A, AUDIT_HMAC_KEY_ID: 'k2' }))).firstBroken).toEqual({ seq: '1', reason: 'UNKNOWN_KEY' });
    });
    it('key rotation: new seals use the new key id; the chain verifies with the previous key in the keyring', async () => {
      const k2 = ring({ AUDIT_HMAC_KEY: KEY_B, AUDIT_HMAC_KEY_ID: 'k2', AUDIT_HMAC_PREVIOUS_KEYS: `k1:${KEY_A}` });
      await insert(2);
      expect((await sealAuditLog(db, CFG, k2)).seals).toHaveLength(1);
      expect((await db.$queryRawUnsafe<{ key_id: string }[]>(`SELECT key_id FROM "${S}"."audit_seal" s ORDER BY s.seq`)).map((s) => s.key_id)).toEqual(['k1', 'k1', 'k2']);
      expect(await verifyAuditChain(db, CFG, k2)).toMatchObject({ ok: true, seals: 3, sealedRows: 8 });
      expect((await verifyAuditChain(db, CFG, ring({ AUDIT_HMAC_KEY: KEY_B, AUDIT_HMAC_KEY_ID: 'k2' }))).firstBroken).toEqual({ seq: '1', reason: 'UNKNOWN_KEY' });
    });
  });

  it('audit_seal is append-only (UPDATE / DELETE / TRUNCATE rejected even for the owner)', async () => {
    await insert(1);
    await sealAuditLog(db, CFG, K1);
    await expect(db.$executeRawUnsafe(`UPDATE "${S}"."audit_seal" SET mac = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`DELETE FROM "${S}"."audit_seal"`)).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`TRUNCATE "${S}"."audit_seal"`)).rejects.toThrow(/append-only/);
  });

  it('a slow transaction that commits after a later one is never skipped (horizon = oldest running xid)', async () => {
    const hold = gate();
    const started = gate();
    const slow = db.$transaction(async (tx) => { await insertAuditRow(tx, row('SLOW')); started.open(); await hold.p; }, { timeout: 20_000 });
    await started.p;
    await insert(1, 'FAST'); // xid > slow-ийн xid, commit-ээ түрүүлж хийнэ
    expect((await sealAuditLog(db, CFG, K1)).seals).toEqual([]); // FAST commit болсон ч horizon-оос дээш
    hold.open();
    await slow;
    expect((await sealAuditLog(db, CFG, K1)).seals).toEqual([expect.objectContaining({ seq: '1', rows: 2 })]);
    expect(await verifyAuditChain(db, CFG, K1)).toMatchObject({ ok: true, sealedRows: 2, unsealedRows: 0 });
  });

  it('a sealer on another pod holding the lock makes this one skip (no seal, no wait)', async () => {
    await insert(2);
    const other = new PrismaService();
    const hold = gate();
    const locked = gate();
    const pod = other.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock($1::bigint)) l', advisoryLockKey(`audit-seal:${S}`).toString());
      locked.open();
      await hold.p;
    }, { timeout: 20_000 });
    try {
      await locked.p;
      expect(await sealAuditLog(db, CFG, K1)).toMatchObject({ locked: true, regressed: null, seals: [] });
      hold.open();
      await pod;
      expect((await sealAuditLog(db, CFG, K1)).seals).toHaveLength(1);
    } finally {
      hold.open();
      await pod.catch(() => undefined);
      await other.$disconnect();
    }
  });

  it('concurrent writers while 3 pods seal: every row sealed exactly once, chain verifies', async () => {
    const pods = [new PrismaService(), new PrismaService(), new PrismaService()];
    let writing = true;
    const writers = Array.from({ length: 4 }, (_, w) => (async () => {
      for (let i = 0; i < 15; i += 1) {
        await db.$transaction(async (tx) => {
          await insertAuditRow(tx, row(`W${w}_${i}a`));
          await sleep(Math.floor(Math.random() * 8)); // транзакц нээлттэй байх зуур sealer ажиллана
          await insertAuditRow(tx, row(`W${w}_${i}b`));
        });
      }
    })());
    const sealers = pods.map((p) => (async () => {
      let n = 0;
      while (writing) { n += (await sealAuditLog(p, CFG, K1, { batchSize: 7, maxBatches: 3 })).seals.length; await sleep(Math.floor(Math.random() * 5)); }
      return n;
    })());
    try {
      await Promise.all(writers);
      writing = false;
      const sealedDuring = (await Promise.all(sealers)).reduce((a, b) => a + b, 0);
      while ((await sealAuditLog(db, CFG, K1, { batchSize: 7 })).seals.length > 0) { /* дуустал */ }
      const total = await count('audit_log');
      expect(total).toBe(4 * 15 * 2);
      expect(sealedDuring).toBeGreaterThan(0);
      const sealed = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT coalesce(sum(row_count), 0)::int AS n FROM "${S}"."audit_seal"`);
      expect(sealed[0]!.n).toBe(total);
      expect(await verifyAuditChain(db, CFG, K1)).toMatchObject({ ok: true, sealedRows: total, unsealedRows: 0 });
    } finally {
      writing = false;
      await Promise.allSettled(sealers);
      await Promise.all(pods.map((p) => p.$disconnect()));
    }
  }, 60_000);

  /** Sealer-ийн нэг query-г хуурамчаар хариулна (жишээ нь өөр кластерын horizon) — бусад нь бодит DB руу. */
  const intercept = (fake: (q: string) => unknown[] | undefined): AuditSealDb => ({
    $queryRawUnsafe: (q: string, ...v: unknown[]) => db.$queryRawUnsafe(q, ...v),
    $transaction: (fn: (tx: unknown) => Promise<unknown>, o?: object) => db.$transaction((tx) => fn({
      $queryRawUnsafe: (q: string, ...v: unknown[]) => { const f = fake(q); return f ? Promise.resolve(f) : tx.$queryRawUnsafe(q, ...v); },
      $executeRawUnsafe: (q: string, ...v: unknown[]) => tx.$executeRawUnsafe(q, ...v),
    }), o as never),
  }) as unknown as AuditSealDb;
  const forge = (id: string, txId: string, after: string | null = null, at = '2026-01-01T00:00:00Z') => tamper('audit_log', 'audit_log_stamp_tx_id',
    `INSERT INTO "${S}"."audit_log" (id, org_id, entity, entity_id, action, at, tx_id, after_json) VALUES ($1, $2, 'T', 'e', 'FORGED', $3::timestamp, $4::xid8, $5::jsonb)`, id, orgId, at, txId, after);
  const purge = () => purgeAuditLogForTests(db, (tx) => tx.$executeRawUnsafe(`TRUNCATE "${S}"."audit_log", "${S}"."audit_seal"`));

  it('legacy rows (tx_id 0 from the metadata-only migration) seal first, deterministically regardless of physical insert order', async () => {
    const ids = ['b-legacy', 'a-legacy', 'c-legacy'];
    for (const id of ids) await forge(id, '0', '{"k": 1}');
    await insert(1);
    const first = await sealAuditLog(db, CFG, K1, { batchSize: 3 });
    expect(first.seals.map((s) => s.rows)).toEqual([3, 1]);
    expect((await db.$queryRawUnsafe<{ id: string; t: string }[]>(`SELECT s.last_id AS id, s.last_tx_id::text AS t FROM "${S}"."audit_seal" s ORDER BY s.seq`))[0]).toEqual({ id: 'c-legacy', t: '0' });
    await purge();
    for (const id of [...ids].reverse()) await forge(id, '0', '{"k": 1}');
    expect((await sealAuditLog(db, CFG, K1, { batchSize: 3 })).seals[0]!.mac).toBe(first.seals[0]!.mac);
  });

  describe('jsonb is MACed as Postgres stores it (no JS parse / re-serialise)', () => {
    const one = async (after: string) => { await forge('num-1', '5', after); return (await sealAuditLog(db, CFG, K1)).seals[0]!.mac; };
    const rewrite = (to: string) => tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET after_json = $1::jsonb WHERE id = 'num-1'`, to);
    it('(a) a number above 2^53 changed by one → MAC_MISMATCH', async () => {
      await one('{"n": 9007199254740993}');
      await rewrite('{"n": 9007199254740992}');
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '1', reason: 'MAC_MISMATCH' });
    });
    it('(b) 1.10 rewritten as 1.1 → MAC_MISMATCH', async () => {
      await one('{"n": 1.10}');
      await rewrite('{"n": 1.1}');
      expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '1', reason: 'MAC_MISMATCH' });
    });
    it('(c) the same logical object inserted with a different key order / whitespace yields the same MAC', async () => {
      const mac = await one('{"b": 2, "a": {"y": 1, "x": [1, 2]}}');
      await purge();
      expect(await one('{ "a":{"x":[1,2],"y":1},"b":2 }')).toBe(mac);
      await rewrite('{"a": {"y": 1, "x": [1, 2]}, "b": 2}');
      expect((await verifyAuditChain(db, CFG, K1)).ok).toBe(true);
    });
  });

  it('key downgrade: after k1 → k2 the sealer refuses k1 again, and a k1 seal forged with the old key is rejected by verify', async () => {
    const k2 = ring({ AUDIT_HMAC_KEY: KEY_B, AUDIT_HMAC_KEY_ID: 'k2', AUDIT_HMAC_PREVIOUS_KEYS: `k1:${KEY_A}` });
    const backToK1 = ring({ AUDIT_HMAC_KEY: KEY_A, AUDIT_HMAC_KEY_ID: 'k1', AUDIT_HMAC_PREVIOUS_KEYS: `k2:${KEY_B}` });
    await insert(1);
    await sealAuditLog(db, CFG, K1);
    await insert(1);
    await sealAuditLog(db, CFG, k2);
    await insert(1);
    expect(await sealAuditLog(db, CFG, backToK1)).toMatchObject({ regressed: 'KEY_DOWNGRADE', seals: [] });
    // Хуучин түлхүүр алдагдсан этгээд sealer-ийн шалгалтыг тойрч k1-ээр seq 3 нэмсэн
    const forged = await sealAuditLog(intercept((q) => (q.includes('s.key_id = $1') ? [] : undefined)), CFG, backToK1);
    expect(forged.seals).toEqual([expect.objectContaining({ seq: '3' })]);
    expect((await verifyAuditChain(db, CFG, k2)).firstBroken).toEqual({ seq: '3', reason: 'KEY_DOWNGRADE' });
  });

  it('horizon regression (dump/restore onto a cluster with a lower xid counter): sealer refuses, verify flags HORIZON_REGRESSED', async () => {
    const high = '1000000000000';
    await forge('restored-1', high);
    await forge('restored-2', high);
    const oldCluster = intercept((q) => (q.includes('pg_snapshot_xmin') ? [{ horizon: '1000000000001' }] : undefined));
    expect((await sealAuditLog(oldCluster, CFG, K1)).seals).toEqual([expect.objectContaining({ seq: '1', rows: 2 })]);
    await insert(1); // шинэ кластерт: xid ≪ курсор
    expect(await sealAuditLog(db, CFG, K1)).toMatchObject({ regressed: 'HORIZON_REGRESSED', seals: [] });
    expect((await verifyAuditChain(db, CFG, K1)).firstBroken).toEqual({ seq: '1', reason: 'HORIZON_REGRESSED' });
  });

  it('H1: a sealer that saw the old head refuses to re-seal after the last seals were deleted and rows edited; only the anchor exposes a memory-less reseal', async () => {
    await insert(3);
    const first = await sealAuditLog(db, CFG, K1);
    await insert(2);
    const second = await sealAuditLog(db, CFG, K1, { expectedHead: first.head });
    expect(second.head?.seq).toBe('2');
    const [, , , fourth] = await ids();
    await tamper('audit_seal', 'audit_seal_append_only', `DELETE FROM "${S}"."audit_seal" WHERE seq = 2`);
    await tamper('audit_log', 'audit_log_append_only', `UPDATE "${S}"."audit_log" SET actor_id = 'attacker' WHERE id = $1`, fourth);
    expect(await sealAuditLog(db, CFG, K1, { expectedHead: second.head })).toMatchObject({ regressed: 'CHAIN_REGRESSED', seals: [] });
    expect(await count('audit_seal')).toBe(1);
    const resealed = await sealAuditLog(db, CFG, K1); // дурсамжгүй (шинэ) sealer — баримтжуулсан үлдэгдэл эрсдэл
    expect(resealed.seals).toEqual([expect.objectContaining({ seq: '2' })]);
    expect((await verifyAuditChain(db, CFG, K1)).ok).toBe(true);
    expect((await verifyAuditChain(db, CFG, K1, { anchor: second.head! })).firstBroken).toEqual({ seq: '2', reason: 'ANCHOR_MISMATCH' });
    expect(await sealAuditLog(db, CFG, K1, { expectedHead: second.head })).toMatchObject({ regressed: 'CHAIN_REGRESSED' }); // ижил seq, өөр mac
  });

  it('a later batch failing still logs and records every committed seal; the next healthy tick continues the chain (no CHAIN_REGRESSED)', async () => {
    await insert(5);
    let sealInserts = 0;
    const faulty = {
      $queryRawUnsafe: (q: string, ...v: unknown[]) => db.$queryRawUnsafe(q, ...v),
      $transaction: (fn: (tx: unknown) => Promise<unknown>, o?: object) => db.$transaction((tx) => fn({
        $queryRawUnsafe: (q: string, ...v: unknown[]) => tx.$queryRawUnsafe(q, ...v),
        $executeRawUnsafe: (q: string, ...v: unknown[]) => {
          if (q.startsWith('INSERT INTO') && q.includes('"audit_seal"') && ++sealInserts === 2) throw new Error('terminating connection due to administrator command');
          return tx.$executeRawUnsafe(q, ...v);
        },
      }), o as never),
    } as unknown as AuditSealDb;
    const logs: string[] = [];
    const errors: string[] = [];
    const info = vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
    try {
      const host = new AuditSealerHost(faulty, S, AUDIT_SEAL_COLUMNS, { AUDIT_HMAC_KEY: KEY_A, AUDIT_SEAL_INTERVAL_MS: '3600000' }, { batchSize: 2 });
      host.onModuleInit();
      await host.tick(); // batch 1 commit (seq 1), batch 2 throws
      const committed = (await sealRows())[0]!;
      expect(await count('audit_seal')).toBe(1);
      expect(logs.filter((l) => l.startsWith('AUDIT_SEALED'))).toEqual([`AUDIT_SEALED schema=origination seq=1 rows=2 mac=${committed.mac}`]);
      expect(host.lastHead()).toEqual({ seq: '1', mac: committed.mac });
      expect(errors).toEqual([expect.stringMatching(/^AUDIT_SEAL_FAILED schema=origination/)]);
      await host.tick(); // эрүүл tick
      expect(host.isHalted()).toBe(false);
      expect(errors.some((e) => e.includes('REGRESSED'))).toBe(false);
      expect(logs.filter((l) => l.startsWith('AUDIT_SEALED')).map((l) => / seq=(\d+) /.exec(l)![1])).toEqual(['1', '2', '3']); // давхар логгүй
      expect(host.lastHead()?.seq).toBe('3');
      expect(await verifyAuditChain(db, CFG, K1)).toMatchObject({ ok: true, seals: 3, sealedRows: 5, unsealedRows: 0 });
      await host.onApplicationShutdown();
    } finally {
      info.mockRestore();
      err.mockRestore();
    }
  });

  it('the host halts on regression (AUDIT_SEAL_CHAIN_REGRESSED, no row content, app keeps running) and never seals again', async () => {
    const errors: string[] = [];
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
    const info = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await insert(2);
      const host = new AuditSealerHost(db, S, AUDIT_SEAL_COLUMNS, { AUDIT_HMAC_KEY: KEY_A, AUDIT_SEAL_INTERVAL_MS: '3600000' });
      host.onModuleInit();
      await host.tick();
      expect(host.lastHead()?.seq).toBe('1');
      await tamper('audit_seal', 'audit_seal_append_only', `DELETE FROM "${S}"."audit_seal"`);
      await insert(1);
      await host.tick();
      expect(host.isHalted()).toBe(true);
      await host.tick();
      expect(await count('audit_seal')).toBe(0);
      expect(errors).toEqual([expect.stringMatching(/^AUDIT_SEAL_CHAIN_REGRESSED schema=origination expectedSeq=1: sealing stopped/)]);
      expect(errors.join('\n')).not.toContain('SEAL_TEST');
      await host.onApplicationShutdown();
    } finally {
      err.mockRestore();
      info.mockRestore();
    }
  });

  it('CLI strict mode (production): NOT_OK with nothing sealed, UNANCHORED (exit 3) without --anchor, OK only with a matching anchor', async () => {
    const cli = async (argv: string[], NODE_ENV = 'production') => {
      const out: string[] = [];
      const code = await runAuditSealCli(db, CFG, argv, (l) => out.push(l), { NODE_ENV, AUDIT_HMAC_KEY: KEY_A });
      return { code, line: out[0] ?? '' };
    };
    await insert(2);
    expect(await cli(['verify'])).toMatchObject({ code: 1, line: expect.stringMatching(/^NOT_OK reason=NO_SEALS .*backlogBelowHorizon=2/) });
    await cli(['seal']);
    const head = (await sealRows())[0]!;
    expect(await cli(['verify'])).toMatchObject({ code: 3, line: expect.stringMatching(/^UNANCHORED schema=origination seals=1 /) });
    expect(await cli(['verify', '--anchor', `${head.seq}:${head.mac}`])).toMatchObject({ code: 0, line: expect.stringMatching(/^OK .*anchored=yes/) });
    expect(await cli(['verify'], 'development')).toMatchObject({ code: 0, line: expect.stringMatching(/^OK .*anchored=no/) });
    expect(await cli(['verify', '--strict'], 'development')).toMatchObject({ code: 3 });
  });

  it('the sealer host seals on tick and logs only seq / row count / mac — never the key or row content; no key → disabled', async () => {
    await insert(2);
    const logs: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => { logs.push(String(m)); });
    try {
      const host = new AuditSealerHost(db, S, AUDIT_SEAL_COLUMNS, { AUDIT_HMAC_KEY: KEY_A, AUDIT_SEAL_INTERVAL_MS: '3600000' });
      host.onModuleInit();
      await host.tick();
      await host.onApplicationShutdown();
      expect(logs.find((l) => l.startsWith('AUDIT_SEALED'))).toMatch(/^AUDIT_SEALED schema=origination seq=1 rows=2 mac=[0-9a-f]{64}$/);
      const off = new AuditSealerHost(db, S, AUDIT_SEAL_COLUMNS, { AUDIT_SEAL_INTERVAL_MS: '1000' });
      off.onModuleInit();
      await off.tick();
      await off.onApplicationShutdown();
      expect(logs.some((l) => l.includes('AUDIT_HMAC_KEY not set'))).toBe(true);
      expect(await count('audit_seal')).toBe(1);
      expect(logs.join('\n')).not.toContain(KEY_A);
      expect(logs.join('\n')).not.toContain('SEAL_TEST');
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});
