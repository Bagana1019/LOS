import { describe, expect, it } from 'vitest';
import { assertAuditHmacKey, assertAuditSealSchedule, auditSealSchedule } from './audit-hmac-key';

const KEY = 'prod-audit-hmac-key-0123456789abcdef-XYZ'; // 40
const OLD = 'prod-audit-hmac-key-OLD-0123456789abcdef';
const prod = (env: Record<string, string | undefined>) => () => assertAuditHmacKey({ NODE_ENV: 'production', INTERNAL_AUTH_SECRET: 'prod-internal-secret-0123456789', ...env });

describe('assertAuditHmacKey (audit seal startup assertion)', () => {
  it('accepts a strong key (exactly 32 characters is enough) with an optional rotated previous key', () => {
    expect(prod({ AUDIT_HMAC_KEY: KEY })).not.toThrow();
    expect(prod({ AUDIT_HMAC_KEY: 'x'.repeat(31) + 'y' })).not.toThrow();
    expect(prod({ AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_KEY_ID: 'k2', AUDIT_HMAC_PREVIOUS_KEYS: `k1:${OLD}` })).not.toThrow();
  });

  it.each([
    ['missing', {}, /must be set/],
    ['empty', { AUDIT_HMAC_KEY: '' }, /must be set/],
    ['whitespace only', { AUDIT_HMAC_KEY: '      ' }, /must be set/],
    ['31 characters', { AUDIT_HMAC_KEY: KEY.slice(0, 31) }, /at least 32/],
    ['31 characters padded with spaces (trimmed)', { AUDIT_HMAC_KEY: `  ${KEY.slice(0, 31)}  ` }, /at least 32/],
    ['the .env.example placeholder', { AUDIT_HMAC_KEY: 'dev-audit-hmac-key-change-me-0123456789abcdef' }, /placeholder/],
    ['a CHANGE_ME variant', { AUDIT_HMAC_KEY: 'CHANGE_ME_CHANGE_ME_CHANGE_ME_0000000' }, /placeholder/],
    ['reusing INTERNAL_AUTH_SECRET', { AUDIT_HMAC_KEY: 'shared-secret-0123456789abcdef-0123', INTERNAL_AUTH_SECRET: 'shared-secret-0123456789abcdef-0123' }, /INTERNAL_AUTH_SECRET/],
    ['a short previous key', { AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: 'k0:short' }, /AUDIT_HMAC_PREVIOUS_KEYS\[k0\].*at least 32/],
    ['a malformed previous key list', { AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_PREVIOUS_KEYS: OLD }, /<keyId>:<key>/],
    ['a bad key id', { AUDIT_HMAC_KEY: KEY, AUDIT_HMAC_KEY_ID: 'bad id!' }, /AUDIT_HMAC_KEY_ID/],
  ])('refuses to start in production when the key is %s, never echoing the key', (_l, env: Record<string, string>, re) => {
    let msg = '';
    try { prod(env)(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(re);
    for (const v of [env.AUDIT_HMAC_KEY, KEY, OLD]) if (v?.trim()) expect(msg).not.toContain(v.trim());
  });

  it.each([['development'], ['test'], [undefined]])('is a no-op when NODE_ENV=%s (sealer just stays off without a key)', (nodeEnv) => {
    expect(() => assertAuditHmacKey({ NODE_ENV: nodeEnv })).not.toThrow();
    expect(() => assertAuditHmacKey({ NODE_ENV: nodeEnv, AUDIT_HMAC_KEY: 'short' })).not.toThrow();
  });
});

describe('auditSealSchedule / assertAuditSealSchedule (sealing must not be silently off in production)', () => {
  const P = (env: Record<string, string>) => () => assertAuditSealSchedule({ NODE_ENV: 'production', ...env });
  it('parses the interval: unset/blank → 60s default; positive integer kept; 0 → disabled; AUDIT_SEAL_DISABLED=true → disabled', () => {
    expect(auditSealSchedule({})).toEqual({ intervalMs: 60_000, disabledBy: null, invalid: null });
    expect(auditSealSchedule({ AUDIT_SEAL_INTERVAL_MS: ' ' })).toMatchObject({ intervalMs: 60_000 });
    expect(auditSealSchedule({ AUDIT_SEAL_INTERVAL_MS: '15000' })).toEqual({ intervalMs: 15_000, disabledBy: null, invalid: null });
    expect(auditSealSchedule({ AUDIT_SEAL_INTERVAL_MS: '0' })).toMatchObject({ intervalMs: 0, disabledBy: 'AUDIT_SEAL_INTERVAL_MS=0' });
    expect(auditSealSchedule({ AUDIT_SEAL_DISABLED: 'TRUE', AUDIT_SEAL_INTERVAL_MS: '1000' })).toMatchObject({ intervalMs: 0, disabledBy: 'AUDIT_SEAL_DISABLED=true' });
  });
  it.each([['abc'], ['NaN'], ['-1'], ['1.5'], ['1e3'], ['99999999999999999999']])('flags %s as invalid', (v) => {
    expect(auditSealSchedule({ AUDIT_SEAL_INTERVAL_MS: v }).invalid).toMatch(/non-negative integer/);
  });
  it('production: accepts default / positive / explicit opt-out; rejects NaN, negative and a bare 0', () => {
    expect(P({})).not.toThrow();
    expect(P({ AUDIT_SEAL_INTERVAL_MS: '30000' })).not.toThrow();
    expect(P({ AUDIT_SEAL_INTERVAL_MS: '0', AUDIT_SEAL_DISABLED: 'true' })).not.toThrow();
    expect(P({ AUDIT_SEAL_DISABLED: 'true' })).not.toThrow();
    expect(P({ AUDIT_SEAL_INTERVAL_MS: 'NaN' })).toThrow(/non-negative integer/);
    expect(P({ AUDIT_SEAL_INTERVAL_MS: '-5' })).toThrow(/non-negative integer/);
    expect(P({ AUDIT_SEAL_INTERVAL_MS: '0' })).toThrow(/AUDIT_SEAL_DISABLED=true/);
    expect(P({ AUDIT_SEAL_INTERVAL_MS: '0', AUDIT_SEAL_DISABLED: 'yes' })).toThrow(/AUDIT_SEAL_DISABLED=true/);
    expect(P({ AUDIT_SEAL_INTERVAL_MS: '2147483647' })).not.toThrow(); // setInterval-ийн дээд хязгаар
    expect(P({ AUDIT_SEAL_INTERVAL_MS: '2147483648' })).toThrow(/<= 2147483647/); // overflow → 1 мс тутам
    expect(auditSealSchedule({ AUDIT_SEAL_INTERVAL_MS: '2147483648' }).invalid).toMatch(/<= 2147483647/);
  });
  it.each([['development'], ['test']])('is permissive when NODE_ENV=%s', (nodeEnv) => {
    for (const v of ['0', 'NaN', '-1']) expect(() => assertAuditSealSchedule({ NODE_ENV: nodeEnv, AUDIT_SEAL_INTERVAL_MS: v })).not.toThrow();
  });
});
