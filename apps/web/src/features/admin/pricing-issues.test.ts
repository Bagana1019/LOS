import { describe, expect, it } from 'vitest';
import type { TierSetIssueCode } from '@los/calc';
import { describeTierIssue, describeTierIssues, parseTierSetIssues } from './pricing-issues';

// Сервер: 422 `{ code: 'INVALID_TIER_SET', details: [{ code, tiers }] }` (packages/calc validateTierSet). `tiers` = шатлалын код(ууд):
// хос бол [доод оноотой, дээд оноотой]. Issue код бүр шатлалын кодыг нэрлэсэн монгол өгүүлбэр болно (F9-7).
const ALL_CODES = {
  EMPTY: true, FIRST_TIER_NOT_ZERO: true, DUPLICATE_MIN_SCORE: true, DUPLICATE_CODE: true,
  DEFAULT_TIER_COUNT: true, INTEREST_RATE_NOT_MONOTONIC: true, FEE_RATE_NOT_MONOTONIC: true,
} satisfies Record<TierSetIssueCode, true>;

describe('describeTierIssue: код бүр өгүүлбэр болно, шатлалын кодыг нэрлэнэ', () => {
  it('DUPLICATE_CODE → давхардсан кодыг нэрлэнэ', () => {
    expect(describeTierIssue({ code: 'DUPLICATE_CODE', tiers: ['A'] })).toBe('A код давхардсан байна — шатлал бүрийн код өөр байх ёстой');
  });

  it('FIRST_TIER_NOT_ZERO → хамгийн доод шатлалыг нэрлэнэ', () => {
    expect(describeTierIssue({ code: 'FIRST_TIER_NOT_ZERO', tiers: ['B'] })).toBe('B шатлал хамгийн доод оноотой боловч 0-ээс эхлээгүй байна — хамгийн доод шатлалын доод оноо 0 байх ёстой');
  });

  it('DUPLICATE_MIN_SCORE → хоёр шатлалыг нэрлэнэ', () => {
    expect(describeTierIssue({ code: 'DUPLICATE_MIN_SCORE', tiers: ['B', 'C'] })).toBe('B ба C шатлалын доод оноо ижил байна — шатлал бүрийн доод оноо өөр байх ёстой');
  });

  it('INTEREST_RATE_NOT_MONOTONIC → "B ба C: дээд оноотой шатлалын хүү бага байх ёстой"', () => {
    expect(describeTierIssue({ code: 'INTEREST_RATE_NOT_MONOTONIC', tiers: ['B', 'C'] }))
      .toBe('B ба C шатлал: дээд оноотой C шатлалын хүү B шатлалынхаас бага (эсвэл ижил) байх ёстой');
  });

  it('FEE_RATE_NOT_MONOTONIC → шимтгэлийн өгүүлбэр', () => {
    expect(describeTierIssue({ code: 'FEE_RATE_NOT_MONOTONIC', tiers: ['B', 'C'] }))
      .toBe('B ба C шатлал: дээд оноотой C шатлалын шимтгэл B шатлалынхаас бага (эсвэл ижил) байх ёстой');
  });

  it('DEFAULT_TIER_COUNT: 0 анхдагч → сонгоогүй; олон → кодуудыг жагсаана', () => {
    expect(describeTierIssue({ code: 'DEFAULT_TIER_COUNT', tiers: [] })).toBe('Анхдагч шатлал сонгоогдоогүй байна — яг нэг шатлалыг "Анхдагч" гэж тэмдэглэнэ үү');
    expect(describeTierIssue({ code: 'DEFAULT_TIER_COUNT', tiers: ['A', 'B'] })).toBe('Анхдагч шатлал олон байна (A, B) — яг нэг шатлал анхдагч байх ёстой');
  });

  it('EMPTY → хамгийн багадаа нэг шатлал', () => {
    expect(describeTierIssue({ code: 'EMPTY', tiers: [] })).toBe('Хамгийн багадаа нэг шатлал байх ёстой');
  });

  it('серверийн бүх issue код (TierSetIssueCode) өгүүлбэртэй: түлхүүр шууд харагдахгүй, "Оруулсан өгөгдөл буруу" биш', () => {
    for (const code of Object.keys(ALL_CODES)) {
      const text = describeTierIssue({ code, tiers: ['A', 'B'] });
      expect(text, code).not.toMatch(/admin\.pricing|^[A-Z_]+$/);
      expect(text, code).not.toBe('Оруулсан өгөгдөл буруу');
      expect(text.length, code).toBeGreaterThan(20);
    }
  });

  it('үл мэдэгдэх шинэ код → ерөнхий өгүүлбэр + код (алдахгүй)', () => {
    expect(describeTierIssue({ code: 'SOMETHING_NEW', tiers: ['A'] })).toBe('Шатлалын багц буруу байна (алдааны код: SOMETHING_NEW)');
  });
});

describe('parseTierSetIssues: серверийн `details`-ийг найдваргүй гэж үзнэ', () => {
  it('зөв массиваас issue-үүдийг авна', () => {
    expect(parseTierSetIssues([{ code: 'DUPLICATE_CODE', tiers: ['A'] }])).toEqual([{ code: 'DUPLICATE_CODE', tiers: ['A'] }]);
  });

  it('null / undefined / объект / тэмдэгт мөр → хоосон', () => {
    for (const bad of [null, undefined, {}, 'DUPLICATE_CODE', 42]) expect(parseTierSetIssues(bad), String(bad)).toEqual([]);
  });

  it('буруу бүтэцтэй элементийг алгасна (code тэмдэгт биш, tiers массив биш/тэмдэгт биш элемент)', () => {
    const raw = [{ code: 7, tiers: [] }, { code: 'DUPLICATE_CODE', tiers: 'A' }, { code: 'DUPLICATE_CODE', tiers: [1] }, null, { code: 'DUPLICATE_CODE', tiers: ['A'] }];
    expect(parseTierSetIssues(raw)).toEqual([{ code: 'DUPLICATE_CODE', tiers: ['A'] }]);
  });
});

describe('describeTierIssues', () => {
  it('олон issue → тус бүрд өгүүлбэр, давхардал арилсан, дараалал хадгалагдана', () => {
    const details = [
      { code: 'DUPLICATE_CODE', tiers: ['A'] },
      { code: 'FIRST_TIER_NOT_ZERO', tiers: ['A'] },
      { code: 'DUPLICATE_CODE', tiers: ['A'] },
    ];
    expect(describeTierIssues(details)).toEqual([
      'A код давхардсан байна — шатлал бүрийн код өөр байх ёстой',
      'A шатлал хамгийн доод оноотой боловч 0-ээс эхлээгүй байна — хамгийн доод шатлалын доод оноо 0 байх ёстой',
    ]);
  });

  it('задлагдах issue байхгүй бол хоосон жагсаалт (дуудагч ерөнхий мессеж үзүүлнэ)', () => {
    expect(describeTierIssues(undefined)).toEqual([]);
    expect(describeTierIssues([])).toEqual([]);
  });
});
