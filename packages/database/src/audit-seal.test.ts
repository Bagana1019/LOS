// Audit seal — DB-гүй хэсэг: canonical хэлбэр, keyring, CLI. DB-тэй бүх сценари apps/origination/test/audit-seal.db.test.ts-д.
import { describe, expect, it, vi } from 'vitest';
import { AUDIT_SEAL_COLUMNS, GATEWAY_AUDIT_SEAL_COLUMNS, auditKeyringFromEnv, canonicalAuditRow, sealAuditLog, type AuditChainReport, type AuditSealDb } from './audit-seal';
import { runAuditSealCli, verifyStatus } from './audit-seal-cli';

const KEY = 'unit-test-audit-hmac-key-0123456789abcdef';

describe('canonicalAuditRow', () => {
  const base = { id: 'a', tx_id: '7', org_id: 'o', entity: 'E', entity_id: 'e', action: 'A', actor_id: null, at: '2026-11-19T10:00:00.123000Z', before_json: null, after_json: '{"a": 1, "b": 2}', application_id: null, correlation_id: 'c' };
  it('emits every configured column in a fixed order, jsonb text verbatim (no parse / re-serialise)', () => {
    expect(canonicalAuditRow(AUDIT_SEAL_COLUMNS, base)).toBe('["a","7","o","E","e","A",null,"2026-11-19T10:00:00.123000Z",null,"{\\"a\\": 1, \\"b\\": 2}",null,"c"]');
  });
  it('keeps number precision and representation (2^53+1, 1.10 vs 1.1, 1e400) distinct', () => {
    const c = (after_json: string) => canonicalAuditRow(AUDIT_SEAL_COLUMNS, { ...base, after_json });
    expect(c('{"n": 9007199254740993}')).not.toBe(c('{"n": 9007199254740992}'));
    expect(c('{"n": 1.10}')).not.toBe(c('{"n": 1.1}'));
    expect(c('{"n": 1e400}')).not.toBe(c('{"n": null}'));
  });
  it('distinguishes SQL NULL from jsonb null and a missing gateway column from an empty one', () => {
    expect(canonicalAuditRow(AUDIT_SEAL_COLUMNS, { ...base, before_json: 'null' })).not.toBe(canonicalAuditRow(AUDIT_SEAL_COLUMNS, base));
    expect(canonicalAuditRow(GATEWAY_AUDIT_SEAL_COLUMNS, { ...base, ip: '' })).not.toBe(canonicalAuditRow(GATEWAY_AUDIT_SEAL_COLUMNS, { ...base, ip: null }));
  });
  it('any single-field change changes the canonical form', () => {
    const ref = canonicalAuditRow(AUDIT_SEAL_COLUMNS, base);
    for (const k of Object.keys(base) as (keyof typeof base)[]) {
      expect(canonicalAuditRow(AUDIT_SEAL_COLUMNS, { ...base, [k]: `${String(base[k])}x` })).not.toBe(ref);
    }
  });
});

describe('verifyStatus (CLI strict mode = production)', () => {
  const rep = (o: Partial<AuditChainReport>): AuditChainReport => ({ ok: true, seals: 2, sealedRows: 5, unsealedRows: 0, backlogBelowHorizon: 0, anchored: false, last: { seq: '2', mac: 'm' }, firstBroken: null, ...o });
  it('non-strict: a self-consistent chain is OK even unanchored', () => {
    expect(verifyStatus(rep({}), false)).toBe('OK');
    expect(verifyStatus(rep({ seals: 0, sealedRows: 0, backlogBelowHorizon: 9, last: null }), false)).toBe('OK');
  });
  it('strict: OK only with a matching anchor; unanchored → UNANCHORED; no seals but sealable rows → NO_SEALS; broken → BROKEN', () => {
    expect(verifyStatus(rep({ anchored: true }), true)).toBe('OK');
    expect(verifyStatus(rep({}), true)).toBe('UNANCHORED');
    expect(verifyStatus(rep({ seals: 0, sealedRows: 0, backlogBelowHorizon: 3, last: null }), true)).toBe('NO_SEALS');
    expect(verifyStatus(rep({ seals: 0, sealedRows: 0, backlogBelowHorizon: 0, last: null }), true)).toBe('UNANCHORED');
    expect(verifyStatus(rep({ ok: false, firstBroken: { seq: '1', reason: 'MAC_MISMATCH' } }), true)).toBe('BROKEN');
  });
});

describe('auditKeyringFromEnv', () => {
  it('returns null without a key (missing or blank) — sealing disabled', () => {
    expect(auditKeyringFromEnv({})).toBeNull();
    expect(auditKeyringFromEnv({ AUDIT_HMAC_KEY: '   ' })).toBeNull();
  });
  it('defaults the key id to k1 and loads previous keys for verification', () => {
    const r = auditKeyringFromEnv({ AUDIT_HMAC_KEY: ` ${KEY} `, AUDIT_HMAC_KEY_ID: 'k3', AUDIT_HMAC_PREVIOUS_KEYS: 'k1:old-one, k2:old-two' })!;
    expect(r.currentKeyId).toBe('k3');
    expect([...r.keys.keys()]).toEqual(['k3', 'k1', 'k2']);
    expect(r.keys.get('k3')!.toString()).toBe(KEY);
    expect(auditKeyringFromEnv({ AUDIT_HMAC_KEY: KEY })!.currentKeyId).toBe('k1');
  });
  it.each([
    [{ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_KEY_ID: 'has space' }, /AUDIT_HMAC_KEY_ID/],
    [{ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: 'nokeyid' }, /<keyId>:<key>/],
    [{ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: 'k0:' }, /<keyId>:<key>/],
    [{ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: 'k1:other-key' }, /repeats key id "k1"/],
    [{ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: 'k0:secret-with,comma-part' }, /entry #2 must be <keyId>:<key>/],
    [{ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: 'k1:secret with-space' }, /entry #1 must be <keyId>:<key>/],
    [{ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: 'k0:secret-one,,k9:secret-two' }, /entry #2 must be/],
    [{ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: 'k0:secret-one,' }, /entry #2 must be/],
    [{ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: `${'x'.repeat(33)}:secret-one` }, /entry #1: key id must match/],
  ])('rejects malformed configuration without echoing key material (%#)', (env, re) => {
    let msg = '';
    try { auditKeyringFromEnv(env); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(re);
    expect(msg).not.toContain(KEY);
    expect(msg).not.toContain('other-key');
    for (const s of ['secret', 'comma-part', 'with-space', 'old-one']) expect(msg).not.toContain(s);
  });
});

describe('runAuditSealCli (argument handling; DB paths in the origination DB suite)', () => {
  const db = { $transaction: vi.fn(), $queryRawUnsafe: vi.fn() } as unknown as AuditSealDb;
  const run = async (argv: string[], env: Record<string, string> = { AUDIT_HMAC_KEY: KEY }) => {
    const out: string[] = [];
    const code = await runAuditSealCli(db, { schema: 'origination', columns: AUDIT_SEAL_COLUMNS }, argv, (l) => out.push(l), env);
    return { code, out };
  };
  it('exit 2 without a key, on unknown commands and on a malformed anchor — no DB access', async () => {
    expect(await run(['verify'], {})).toEqual({ code: 2, out: ['AUDIT_HMAC_KEY is required'] });
    expect((await run(['bogus'])).code).toBe(2);
    expect((await run(['verify', '--anchor', '3:nothex'])).out).toEqual(['--anchor must be <seq>:<64 hex mac>']);
    expect((await run(['verify', '--anchor'])).code).toBe(2);
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('sealAuditLog (lock / isolation contract, fake tx)', () => {
  const fakeDb = (answers: Record<string, unknown>) => {
    const seen: { sql: string; opts?: unknown }[] = [];
    const tx = {
      $queryRawUnsafe: vi.fn(async (sql: string) => { seen.push({ sql }); const k = Object.keys(answers).find((a) => sql.includes(a)); return k ? answers[k] : []; }),
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const db = { $queryRawUnsafe: tx.$queryRawUnsafe, $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, opts?: unknown) => { seen.push({ sql: 'TX', opts }); return fn(tx); }) };
    return { db: db as unknown as AuditSealDb, tx, seen };
  };
  const ring = auditKeyringFromEnv({ AUDIT_HMAC_KEY: KEY })!;

  it('returns locked without reading or writing when another pod holds the advisory lock', async () => {
    const { db, tx, seen } = fakeDb({ pg_try_advisory_xact_lock: [{ locked: false }] });
    expect(await sealAuditLog(db, { schema: 'origination', columns: AUDIT_SEAL_COLUMNS }, ring)).toMatchObject({ locked: true, regressed: null, seals: [] });
    expect(seen.filter((s) => s.sql !== 'TX')).toHaveLength(1);
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('requests READ COMMITTED and refuses to seal under a stricter isolation (horizon guarantee)', async () => {
    const { db, tx, seen } = fakeDb({ pg_try_advisory_xact_lock: [{ locked: true }], transaction_isolation: [{ iso: 'repeatable read' }] });
    await expect(sealAuditLog(db, { schema: 'origination', columns: AUDIT_SEAL_COLUMNS }, ring)).rejects.toThrow(/READ COMMITTED/);
    expect(seen[0]).toMatchObject({ sql: 'TX', opts: expect.objectContaining({ isolationLevel: 'ReadCommitted' }) });
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('rejects a non-identifier schema name (no SQL injection via config)', async () => {
    const { db } = fakeDb({ pg_try_advisory_xact_lock: [{ locked: true }], transaction_isolation: [{ iso: 'read committed' }], pg_snapshot_xmin: [{ horizon: '10' }] });
    await expect(sealAuditLog(db, { schema: 'x"; DROP TABLE y; --', columns: AUDIT_SEAL_COLUMNS }, ring)).rejects.toThrow(/invalid SQL identifier/);
  });
});
