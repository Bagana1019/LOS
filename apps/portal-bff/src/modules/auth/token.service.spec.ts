import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/portal.config';
import { FakeClock, TEST_ENV } from '../../testing/test-app';
import { TokenService } from './token.service';

const make = (env: Record<string, string> = {}) => {
  const clock = new FakeClock(new Date('2026-10-28T04:00:00Z'));
  const cfg = loadConfig({ ...TEST_ENV, ...env });
  return { clock, cfg, svc: new TokenService(cfg, clock) };
};

describe('TokenService', () => {
  it('round-trips claims and expires exactly at the TTL', () => {
    const { svc, clock } = make();
    const { token, expiresInSec } = svc.signAccess({ customerId: 'cust_1', sessionId: 'sess_1' });
    expect(expiresInSec).toBe(600);
    expect(svc.verifyAccess(token)).toEqual({ customerId: 'cust_1', sessionId: 'sess_1' });
    clock.advance(599_000);
    expect(() => svc.verifyAccess(token)).not.toThrow();
    clock.advance(2_000);
    expect(() => svc.verifyAccess(token)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('rejects tokens signed with another secret, issuer, audience or algorithm', () => {
    const { svc, cfg } = make();
    const iat = Math.floor(Date.parse('2026-10-28T04:00:00Z') / 1000);
    const payload = { sid: 's', typ: 'access', iat, exp: iat + 600 };
    const base = { subject: 'cust_1', issuer: cfg.auth.issuer, audience: cfg.auth.audience, noTimestamp: true };
    const good = jwt.sign(payload, cfg.auth.jwtSecret, { ...base, algorithm: 'HS256' });
    expect(() => svc.verifyAccess(good)).not.toThrow();

    const bad = [
      jwt.sign(payload, 'x'.repeat(40), { ...base, algorithm: 'HS256' }),
      jwt.sign(payload, cfg.auth.jwtSecret, { ...base, algorithm: 'HS256', issuer: 'los-gateway' }),
      jwt.sign(payload, cfg.auth.jwtSecret, { ...base, algorithm: 'HS256', audience: 'los-staff' }),
      jwt.sign(payload, cfg.auth.jwtSecret, { ...base, algorithm: 'HS512' }),
      jwt.sign({ ...payload, typ: 'refresh' }, cfg.auth.jwtSecret, { ...base, algorithm: 'HS256' }),
      jwt.sign({ ...payload, sid: undefined }, cfg.auth.jwtSecret, { ...base, algorithm: 'HS256' }),
    ];
    for (const t of bad) expect(() => svc.verifyAccess(t)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('a token minted with the hash secret is not accepted (key separation)', () => {
    const { svc, cfg } = make();
    const iat = Math.floor(Date.parse('2026-10-28T04:00:00Z') / 1000);
    const forged = jwt.sign({ sid: 's', typ: 'access', iat, exp: iat + 600 }, cfg.auth.hashSecret, {
      algorithm: 'HS256', subject: 'cust_1', issuer: cfg.auth.issuer, audience: cfg.auth.audience, noTimestamp: true,
    });
    expect(() => svc.verifyAccess(forged)).toThrow();
  });
});
