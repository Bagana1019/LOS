import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/portal.config';
import { MemoryKvStore } from '../../store/memory-kv-store';
import { FakeClock, TEST_ENV } from '../../testing/test-app';
import { SESSION_ABSOLUTE_TTL_SEC, SessionService } from './session.service';

const make = () => {
  const clock = new FakeClock(new Date('2026-10-28T04:00:00Z'));
  const store = new MemoryKvStore(clock);
  const cfg = loadConfig({ ...TEST_ENV });
  return { clock, store, svc: new SessionService(store, cfg, clock), cfg };
};

describe('SessionService', () => {
  it('creates an active session whose refresh token is not stored in plain text', async () => {
    const { svc, store } = make();
    const s = await svc.create('cust_1');
    expect(await svc.isActive(s.sessionId, 'cust_1')).toBe(true);
    expect(await svc.isActive(s.sessionId, 'cust_2')).toBe(false);
    const raw = (await store.get(`sess:${s.sessionId}`)) as string;
    expect(raw).not.toContain(s.refreshToken.split('.')[1]);
  });

  it('rotates the refresh token and invalidates the previous one', async () => {
    const { svc } = make();
    const s = await svc.create('cust_1');
    const r1 = await svc.rotate(s.refreshToken);
    expect(r1.kind).toBe('ROTATED');
    if (r1.kind !== 'ROTATED') return;
    expect(r1.refreshToken).not.toBe(s.refreshToken);
    expect(r1.sessionId).toBe(s.sessionId);
    const r2 = await svc.rotate(r1.refreshToken);
    expect(r2.kind).toBe('ROTATED');
  });

  it('detects reuse of a rotated token and revokes the whole session', async () => {
    const { svc } = make();
    const s = await svc.create('cust_1');
    const r1 = await svc.rotate(s.refreshToken);
    if (r1.kind !== 'ROTATED') throw new Error('expected rotation');
    expect(await svc.rotate(s.refreshToken)).toMatchObject({ kind: 'REUSE_DETECTED', customerId: 'cust_1' });
    expect(await svc.isActive(s.sessionId, 'cust_1')).toBe(false);
    await expect(svc.rotate(r1.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects malformed, forged and unknown refresh tokens', async () => {
    const { svc } = make();
    const s = await svc.create('cust_1');
    const [sid] = s.refreshToken.split('.');
    for (const bad of ['', 'abc', `${sid}.`, `${sid}.${'a'.repeat(43)}`, `${'a'.repeat(22)}.${'b'.repeat(43)}`, `${s.refreshToken}.extra`]) {
      await expect(svc.rotate(bad)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect(await svc.isActive(sid, 'cust_1')).toBe(true); // буруу оролдлого session-ийг устгахгүй
  });

  it('serialises concurrent rotations: exactly one wins', async () => {
    const { svc } = make();
    const s = await svc.create('cust_1');
    const results = await Promise.allSettled([svc.rotate(s.refreshToken), svc.rotate(s.refreshToken), svc.rotate(s.refreshToken)]);
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'ROTATED');
    expect(ok).toHaveLength(1);
  });

  it('expires after the refresh TTL and enforces the absolute session lifetime', async () => {
    const { svc, clock, cfg } = make();
    const s = await svc.create('cust_1');
    clock.advance((cfg.auth.refreshTtlSec + 1) * 1000);
    await expect(svc.rotate(s.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // Дахин дахин сунгасан ч 90 хоногоос хэтрэхгүй
    const s2 = await svc.create('cust_2');
    let token = s2.refreshToken;
    let elapsed = 0;
    const step = cfg.auth.refreshTtlSec - 3600;
    for (;;) {
      clock.advance(step * 1000);
      elapsed += step;
      const r = await svc.rotate(token).catch(() => null);
      if (!r || r.kind !== 'ROTATED') break;
      expect(r.refreshExpiresInSec).toBeLessThanOrEqual(SESSION_ABSOLUTE_TTL_SEC - elapsed + step);
      token = r.refreshToken;
      if (elapsed > SESSION_ABSOLUTE_TTL_SEC * 2) throw new Error('session never expired');
    }
    expect(elapsed).toBeLessThanOrEqual(SESSION_ABSOLUTE_TTL_SEC + step);
    expect(await svc.isActive(s2.sessionId, 'cust_2')).toBe(false);
  });
});
