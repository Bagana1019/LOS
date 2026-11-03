import { describe, expect, it } from 'vitest';
import { branchCodeOf, counterScopeKey, dueAt, evaluateLevel, formatContractNo, isLevelMember, isOverdue, requiredVotes, selectLevels, ubDate } from './approval.rules';

const L = (levelNo: number, amountFrom: number, amountTo: number | null, productId: string | null = null) => ({ id: `l${levelNo}${productId ?? ''}`, productId, levelNo, amountFrom, amountTo, slaHours: 24 });
const LEVELS = [L(3, 30_000_000, null), L(1, 0, 5_000_000), L(2, 5_000_000, 30_000_000)];

describe('selectLevels (BR-13)', () => {
  it('1.2M → 1 түвшин (салбар)', () => expect(selectLevels(LEVELS, 1_200_000, null).map((l) => l.levelNo)).toEqual([1]));
  it('7M → 2 түвшин', () => expect(selectLevels(LEVELS, 7_000_000, null).map((l) => l.levelNo)).toEqual([1, 2]));
  it('50M → 3 түвшин', () => expect(selectLevels(LEVELS, 50_000_000, null).map((l) => l.levelNo)).toEqual([1, 2, 3]));
  it('босго яг тэнцүү (5M) → дараагийн түвшин нэмэгдэхгүй', () => expect(selectLevels(LEVELS, 5_000_000, null).map((l) => l.levelNo)).toEqual([1]));
  it('бүтээгдэхүүний тусгай түвшин байвал зөвхөн тэдгээр', () => {
    const own = [L(1, 0, null, 'p1')];
    expect(selectLevels([...LEVELS, ...own], 50_000_000, 'p1').map((l) => l.id)).toEqual(['l1p1']);
    expect(selectLevels([...LEVELS, ...own], 50_000_000, 'p2')).toHaveLength(3);
  });
  it('түвшин тохируулаагүй бол хоосон', () => expect(selectLevels([], 1, null)).toEqual([]));
});

describe('evaluateLevel (олонхи)', () => {
  it('босго', () => { expect([1, 2, 3, 4, 5].map(requiredVotes)).toEqual([1, 2, 2, 3, 3]); });
  it('3 батлагч: 2 APPROVE → APPROVED', () => expect(evaluateLevel(['APPROVE', 'APPROVE'], 3)).toBe('APPROVED'));
  it('1 RETURN + 2 APPROVE → APPROVED (үргэлжилнэ)', () => expect(evaluateLevel(['RETURN', 'APPROVE', 'APPROVE'], 3)).toBe('APPROVED'));
  it('2 RETURN → RETURNED', () => expect(evaluateLevel(['RETURN', 'RETURN'], 3)).toBe('RETURNED'));
  it('1 санал → PENDING', () => { expect(evaluateLevel(['APPROVE'], 3)).toBe('PENDING'); expect(evaluateLevel([], 3)).toBe('PENDING'); });
  it('1 батлагч шууд шийднэ', () => { expect(evaluateLevel(['APPROVE'], 1)).toBe('APPROVED'); expect(evaluateLevel(['RETURN'], 1)).toBe('RETURNED'); });
  it('2 батлагч 1:1 тэнцвэл RETURNED', () => expect(evaluateLevel(['APPROVE', 'RETURN'], 2)).toBe('RETURNED'));
  it('батлагчгүй түвшин PENDING', () => expect(evaluateLevel([], 0)).toBe('PENDING'));
});

describe('isLevelMember', () => {
  const user = { userId: 'u1', roles: ['APPROVER'], branchId: 'b1' };
  it('userId', () => { expect(isLevelMember([{ userId: 'u1', role: null, branchId: null }], user, 'b9')).toBe(true); expect(isLevelMember([{ userId: 'u2', role: null, branchId: null }], user, 'b1')).toBe(false); });
  it('дүр + хүсэлтийн салбар', () => { const m = [{ userId: null, role: 'APPROVER', branchId: null }]; expect(isLevelMember(m, user, 'b1')).toBe(true); expect(isLevelMember(m, user, 'b2')).toBe(false); });
  it('дүр + тогтсон салбар', () => { const m = [{ userId: null, role: 'APPROVER', branchId: 'b1' }]; expect(isLevelMember(m, user, 'b1')).toBe(true); expect(isLevelMember(m, user, 'b2')).toBe(false); });
  it('дүр таарахгүй', () => expect(isLevelMember([{ userId: null, role: 'ADMIN', branchId: null }], user, 'b1')).toBe(false));
});

describe('SLA, гэрээний дугаар (BR-11)', () => {
  it('dueAt / isOverdue', () => {
    const t = new Date('2026-11-03T00:00:00Z');
    expect(dueAt(t, 24).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(isOverdue(new Date('2026-11-02T00:00:00Z'), t)).toBe(true);
    expect(isOverdue(new Date('2026-11-04T00:00:00Z'), t)).toBe(false);
    expect(isOverdue(null, t)).toBe(false);
  });
  it('Улаанбаатарын огноо (UTC+8)', () => expect(ubDate(new Date('2026-02-14T17:00:00Z'))).toEqual({ yymmdd: '260215', yyyymmdd: '20260215' }));
  it('загвар: B + 10026 + 260215 + 01', () => {
    expect(formatContractNo('{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', { prefix: 'B', branch: '10026', yymmdd: '260215', seq: 1 })).toBe('B10026260215' + '01');
    expect(formatContractNo('{SEQ}-{SEQ:4}', { prefix: '', branch: '', yymmdd: '', seq: 7 })).toBe('7-0007');
  });
  it('тоолуурын хүрээ', () => {
    expect(counterScopeKey('DAY', 'b1', '20260215')).toBe('20260215');
    expect(counterScopeKey('BRANCH', 'b1', '20260215')).toBe('b1');
    expect(counterScopeKey('GLOBAL', 'b1', '20260215')).toBe('ALL');
    expect(branchCodeOf('branch-1')).toBe('BRANCH1');
  });
});
