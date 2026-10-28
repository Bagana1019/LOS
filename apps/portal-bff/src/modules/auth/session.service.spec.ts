import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/portal.config';
import { MemoryKvStore } from '../../store/memory-kv-store';
import { FakeClock, TEST_ENV } from '../../testing/test-app';
import { SESSION_ABSOLUTE_TTL_SEC, SessionService } from './session.service';

const DAY = 86_400;

const make = (opts: { neverExpire?: boolean; onGet?: (key: string) => Promise<void> } = {}) => {
  const clock = new FakeClock(new Date('2026-10-28T04:00:00Z'));
  const store = new (class extends MemoryKvStore {
    override async get(key: string) {
      const v = await super.get(key);
      if (v !== null) await opts.onGet?.(key);
      return v;
    }
    override async set(key: string, value: string, ttlSec: number) {
      return super.set(key, value, opts.neverExpire ? 10 * 365 * DAY : ttlSec);
    }
    override async setIfExists(key: string, value: string, ttlSec: number) {
      return super.setIfExists(key, value, opts.neverExpire ? 10 * 365 * DAY : ttlSec);
    }
  })(clock);
  const cfg = loadConfig({ ...TEST_ENV });
  return { clock, store, svc: new SessionService(store, cfg, clock), cfg };
};

describe('SessionService', () => {
  it('pins the documented lifetimes: 30-day refresh TTL, 90-day absolute cap', () => {
    expect(SESSION_ABSOLUTE_TTL_SEC).toBe(90 * DAY);
    expect(make().cfg.auth.refreshTtlSec).toBe(30 * DAY);
  });

  it('creates an active session whose refresh secret is not stored in the session record', async () => {
    const { svc, store } = make();
    const s = await svc.create('cust_1');
    expect(await svc.isActive(s.sessionId, 'cust_1')).toBe(true);
    expect(await svc.isActive(s.sessionId, 'cust_2')).toBe(false);
    const raw = (await store.get(`sess:${s.sessionId}`)) as string;
    expect(raw).not.toContain(s.refreshToken.split('.')[2]);
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

  it('detects reuse of a rotated token and revokes the session', async () => {
    const { svc } = make();
    const s = await svc.create('cust_1');
    const r1 = await svc.rotate(s.refreshToken);
    if (r1.kind !== 'ROTATED') throw new Error('expected rotation');
    expect(await svc.rotate(s.refreshToken)).toMatchObject({ kind: 'REUSE_DETECTED', customerId: 'cust_1' });
    expect(await svc.isActive(s.sessionId, 'cust_1')).toBe(false);
    await expect(svc.rotate(r1.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('detects reuse of a token that is MANY rotations old, not just the previous one', async () => {
    const { svc } = make();
    const s = await svc.create('cust_1');
    // Халдагч хулгайлсан T0-ийг T1, T2, T3 болгон эргүүлсэн; хохирогч өөрийн хуучин T0/T1-ийг дараа нь ирүүлнэ
    const tokens = [s.refreshToken];
    for (let i = 0; i < 3; i++) {
      const r = await svc.rotate(tokens[i]);
      if (r.kind !== 'ROTATED') throw new Error('expected rotation');
      tokens.push(r.refreshToken);
    }
    expect(await svc.rotate(tokens[0])).toMatchObject({ kind: 'REUSE_DETECTED', customerId: 'cust_1' });
    expect(await svc.isActive(s.sessionId, 'cust_1')).toBe(false);
    // халдагчийн хамгийн сүүлийн токен ч хүчингүй болсон
    await expect(svc.rotate(tokens[3])).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects malformed, forged and never-issued refresh tokens without touching the session', async () => {
    const { svc } = make();
    const s = await svc.create('cust_1');
    const [sid, gen, secret] = s.refreshToken.split('.');
    const forged = [
      '',
      'abc',
      `${sid}.${gen}`,
      `${sid}.${gen}.`,
      `${sid}.${gen}.${'a'.repeat(64)}`, // зөв хэлбэр, буруу нууц
      `${sid}.1.${secret}`, // хараахан олгогдоогүй үе
      `${sid}.x.${secret}`,
      `${'a'.repeat(22)}.0.${'b'.repeat(64)}`,
      `${s.refreshToken}.extra`,
    ];
    for (const bad of forged) await expect(svc.rotate(bad)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await svc.isActive(sid, 'cust_1')).toBe(true); // хуурамч оролдлого session-ийг устгахгүй
    expect((await svc.rotate(s.refreshToken)).kind).toBe('ROTATED');
  });

  it('serialises concurrent rotations: exactly one wins', async () => {
    const { svc } = make();
    const s = await svc.create('cust_1');
    const results = await Promise.allSettled([svc.rotate(s.refreshToken), svc.rotate(s.refreshToken), svc.rotate(s.refreshToken)]);
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'ROTATED');
    expect(ok).toHaveLength(1);
  });

  it('logout that lands in the middle of a rotation is not undone by it', async () => {
    const state: { svc?: SessionService; sid: string; fired: boolean } = { sid: '', fired: false };
    const { svc } = make({
      onGet: async (key) => {
        if (state.fired || key !== `sess:${state.sid}`) return;
        state.fired = true;
        await state.svc?.revoke(state.sid); // rotate-ийн унших ба бичих завсар logout
      },
    });
    state.svc = svc;
    const s = await svc.create('cust_1');
    state.sid = s.sessionId;
    await expect(svc.rotate(s.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(state.fired).toBe(true);
    expect(await svc.isActive(s.sessionId, 'cust_1')).toBe(false);
  });

  it('a refresh token expires 30 days after issue if unused', async () => {
    const { svc, clock } = make();
    const s = await svc.create('cust_1');
    clock.advance((30 * DAY + 1) * 1000);
    await expect(svc.rotate(s.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('keeps extending until day 90, then ends the session', async () => {
    const { svc, clock } = make();
    let token = (await svc.create('cust_1')).refreshToken;
    const sid = token.split('.')[0];
    // 29-р, 58-р, 87-р өдөр эргүүлнэ: эхний хоёр нь бүтэн 30 хоног, гурав дахь нь 90 хоногийн хязгаарт үлдсэн 3 хоног
    for (const expected of [30 * DAY, 30 * DAY, 3 * DAY]) {
      clock.advance(29 * DAY * 1000);
      const r = await svc.rotate(token);
      if (r.kind !== 'ROTATED') throw new Error('rotation failed');
      expect(r.refreshExpiresInSec).toBe(expected);
      token = r.refreshToken;
    }
    clock.advance(3 * DAY * 1000 + 1000); // 90 хоног + 1с
    await expect(svc.rotate(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await svc.isActive(sid, 'cust_1')).toBe(false);
  });

  it('enforces the 90-day cap itself even if the store would keep the record alive', async () => {
    const { svc, clock } = make({ neverExpire: true });
    const s = await svc.create('cust_1');
    clock.advance(91 * DAY * 1000);
    await expect(svc.rotate(s.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await svc.isActive(s.sessionId, 'cust_1')).toBe(false); // хугацаа дууссан session-г устгана
  });
});
