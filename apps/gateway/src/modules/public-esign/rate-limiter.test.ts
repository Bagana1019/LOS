import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from './rate-limiter';

function setup(opts: { windowMs?: number; maxKeys?: number } = {}) {
  let t = 1_000;
  const limiter = new FixedWindowRateLimiter({ windowMs: opts.windowMs ?? 60_000, maxKeys: opts.maxKeys ?? 100, now: () => t });
  return { limiter, advance: (ms: number) => (t += ms) };
}

describe('FixedWindowRateLimiter', () => {
  it('хязгаар хүртэл зөвшөөрч, remaining-ийг тоолно', () => {
    const { limiter } = setup();
    expect(limiter.consume('a', 3)).toMatchObject({ allowed: true, remaining: 2, retryAfterSec: 0 });
    expect(limiter.consume('a', 3)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('a', 3)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('хязгаараас хэтэрвэл цонх дуустал хориглож Retry-After-ийг дээш бөөрөнхийлнө', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 2; i++) limiter.consume('a', 2);
    expect(limiter.consume('a', 2)).toEqual({ allowed: false, limit: 2, remaining: 0, retryAfterSec: 60 });
    advance(20_001);
    expect(limiter.consume('a', 2)).toMatchObject({ allowed: false, retryAfterSec: 40 });
    advance(39_998);
    expect(limiter.consume('a', 2)).toMatchObject({ allowed: false, retryAfterSec: 1 });
  });

  it('цонх дуусмагц тоолуур шинэчлэгдэнэ (хязгаарын яг төгсгөлд)', () => {
    const { limiter, advance } = setup();
    limiter.consume('a', 1);
    advance(59_999);
    expect(limiter.consume('a', 1).allowed).toBe(false);
    advance(1);
    expect(limiter.consume('a', 1).allowed).toBe(true);
  });

  it('түлхүүр бүр бие даасан, хязгаар дуудлага бүрээр', () => {
    const { limiter } = setup();
    limiter.consume('read:1.1.1.1', 1);
    expect(limiter.consume('read:1.1.1.1', 1).allowed).toBe(false);
    expect(limiter.consume('read:2.2.2.2', 1).allowed).toBe(true);
    expect(limiter.consume('action:1.1.1.1', 1).allowed).toBe(true);
  });

  it('дууссан түлхүүрүүдийг цэвэрлэж санах ойг хязгаарладаг', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 50; i++) limiter.consume(`k${i}`, 5);
    expect(limiter.size).toBe(50);
    advance(30_000);
    limiter.consume('late', 5);
    expect(limiter.size).toBe(51);
    advance(30_000);
    limiter.consume('later', 5);
    expect(limiter.size).toBe(2);
  });

  it('maxKeys дүүрэхэд хамгийн хуучин түлхүүрийг гаргаж хэзээ ч хэтрэхгүй', () => {
    const { limiter } = setup({ maxKeys: 3 });
    limiter.consume('a', 1);
    limiter.consume('b', 1);
    limiter.consume('c', 1);
    limiter.consume('d', 1);
    expect(limiter.size).toBe(3);
    // 'a' гарсан тул шинэ тоолуураар эхэлнэ; 'b' хэвээр байна
    expect(limiter.consume('a', 1).allowed).toBe(true);
    expect(limiter.consume('c', 1).allowed).toBe(false);
    expect(limiter.size).toBe(3);
  });

  it('1000 өөр түлхүүр хаяад ч size maxKeys-ээс хэтрэхгүй', () => {
    const { limiter } = setup({ maxKeys: 10 });
    for (let i = 0; i < 1000; i++) limiter.consume(`ip${i}`, 5);
    expect(limiter.size).toBe(10);
  });
});
