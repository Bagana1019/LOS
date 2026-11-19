import { describe, expect, it } from 'vitest';
import { DomainError } from '@los/nest-common';
import { hashCreateRequest, parseIdempotencyKey } from './application.idempotency';

const MONGOLIAN = /[А-Яа-яӨөҮү]/;

function thrown(fn: () => unknown): DomainError {
  try { fn(); } catch (e) { return e as DomainError; }
  throw new Error('expected function to throw');
}

// Idempotency-Key толгой: заавал биш; байвал 8–128 тэмдэгт [A-Za-z0-9_-], үгүй бол 400 IDEMPOTENCY_KEY_INVALID (монгол мессеж).
describe('parseIdempotencyKey', () => {
  it('толгой байхгүй бол undefined (өнөөдрийн зан төлөв хэвээр)', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it.each([
    ['хамгийн богино (8)', 'abcdefgh'],
    ['хамгийн урт (128)', 'a'.repeat(128)],
    ['UUID v4', '3f2b8c1e-9a47-4d2e-8b61-0c5f7a9d1e34'],
    ['доогуур зураас ба дундуур зураас', 'my_key-01_ABC'],
    ['зөвхөн тоо', '12345678'],
  ])('зөв түлхүүр: %s', (_name, key) => {
    expect(parseIdempotencyKey(key)).toBe(key);
  });

  it.each([
    ['хоосон толгой', ''],
    ['7 тэмдэгт (босгоос доош)', 'abcdefg'],
    ['129 тэмдэгт (босгоос дээш)', 'a'.repeat(129)],
    ['зай', 'abcd efgh'],
    ['цэг', 'abcdefgh.ijkl'],
    ['давхар толгой (таслалаар нийлсэн)', 'abcdefgh, ijklmnop'],
    ['монгол кирилл', 'түлхүүр-12345'],
    ['emoji', 'abcdefgh🔑'],
    ['мөр шилжилт', 'abcdefgh\nijkl'],
    ['SQL тэмдэгт', "x'; DROP TABLE a;--"],
    ['зөвхөн зай', '        '],
  ])('буруу түлхүүр → 400 IDEMPOTENCY_KEY_INVALID: %s', (_name, key) => {
    const e = thrown(() => parseIdempotencyKey(key));
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(e.getStatus()).toBe(400);
    expect(e.message).toMatch(MONGOLIAN);
  });

  it('алдааны мессеж буруу түлхүүрийн утгыг буцаан агуулахгүй (лог/алдаа руу задрахгүй)', () => {
    const e = thrown(() => parseIdempotencyKey('secret value with spaces'));
    expect(JSON.stringify(e.getResponse())).not.toContain('secret value');
  });
});

// Нормчилсон биеийн hash: ижил утга → ижил hash (түлхүүрийн дараалал/undefined-аас үл хамаарна); өөр утга → өөр hash.
describe('hashCreateRequest', () => {
  it('sha256 hex (64 тэмдэгт)', () => {
    expect(hashCreateRequest({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it('тодорхойлогч: ижил оролт → ижил hash', () => {
    expect(hashCreateRequest({ purpose: 'Хэрэглээний зээл' })).toBe(hashCreateRequest({ purpose: 'Хэрэглээний зээл' }));
  });

  it('талбар байхгүй, undefined, null нь адил (хоосон хүсэлт)', () => {
    const empty = hashCreateRequest({});
    expect(hashCreateRequest({ purpose: undefined, productId: undefined, branchId: undefined })).toBe(empty);
    expect(hashCreateRequest({ purpose: null, productId: null, branchId: null })).toBe(empty);
  });

  it('талбаруудын дараалал нөлөөлөхгүй', () => {
    expect(hashCreateRequest({ productId: 'p1', purpose: 'x', branchId: 'b1' })).toBe(hashCreateRequest({ branchId: 'b1', purpose: 'x', productId: 'p1' }));
  });

  it('талбар бүр hash-д нөлөөлнө', () => {
    const base = { productId: 'p1', purpose: 'x', branchId: 'b1' };
    const hashes = new Set([
      hashCreateRequest(base),
      hashCreateRequest({ ...base, productId: 'p2' }),
      hashCreateRequest({ ...base, purpose: 'y' }),
      hashCreateRequest({ ...base, branchId: 'b2' }),
      hashCreateRequest({}),
    ]);
    expect(hashes.size).toBe(5);
  });

  it('ижил утга өөр талбарт орвол өөр hash (productId=a ≠ purpose=a)', () => {
    expect(hashCreateRequest({ productId: 'a' })).not.toBe(hashCreateRequest({ purpose: 'a' }));
    expect(hashCreateRequest({ purpose: 'a', branchId: null })).not.toBe(hashCreateRequest({ purpose: null, branchId: 'a' }));
  });

  it('тусгаарлагч төөрөлдөлт байхгүй: ("a,b", null) ≠ ("a", "b")', () => {
    expect(hashCreateRequest({ productId: 'a,b', purpose: null })).not.toBe(hashCreateRequest({ productId: 'a', purpose: 'b' }));
  });

  it('Unicode, emoji, том (200 тэмдэгт) утгыг дэмжинэ', () => {
    const long = 'Ө'.repeat(200);
    expect(hashCreateRequest({ purpose: long })).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCreateRequest({ purpose: '🏠 орон сууц' })).not.toBe(hashCreateRequest({ purpose: '🏠 орон сууц ' }));
  });
});
