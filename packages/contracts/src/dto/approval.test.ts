import { describe, expect, it } from 'vitest';
import { MyApprovalItem, VoteRequest } from './approval';

// FR-1.5 / FR-10.2 (M3 review): санал өгөгч харсан түвшин, хувилбар дээрээ л санал өгнө — хоцрогдсон жагсаалтаас өөр шийдвэрт санал өгөхгүй.
describe('VoteRequest: хүлээгдэж буй levelNo / version', () => {
  it('хоёулаа заавал биш (одоогийн DecisionStep-ийн дуудлага хэвээр)', () => {
    expect(VoteRequest.safeParse({ decision: 'APPROVE' }).success).toBe(true);
  });
  it('levelNo, version-тэй хүчинтэй; RETURN-ийн тайлбар заавал хэвээр', () => {
    expect(VoteRequest.parse({ decision: 'APPROVE', levelNo: 2, version: 3 })).toEqual({ decision: 'APPROVE', levelNo: 2, version: 3 });
    expect(VoteRequest.safeParse({ decision: 'RETURN', levelNo: 1, version: 1 }).success).toBe(false);
    expect(VoteRequest.safeParse({ decision: 'RETURN', comment: 'Дутуу', levelNo: 1, version: 1 }).success).toBe(true);
  });
  it('нэг нь л байж болно', () => {
    expect(VoteRequest.safeParse({ decision: 'APPROVE', levelNo: 1 }).success).toBe(true);
    expect(VoteRequest.safeParse({ decision: 'APPROVE', version: 1 }).success).toBe(true);
  });
  it.each([[0], [-1], [1.5], ['1'], [null], [Number.NaN]])('буруу levelNo %j татгалзана', (levelNo) => {
    expect(VoteRequest.safeParse({ decision: 'APPROVE', levelNo }).success).toBe(false);
  });
  it.each([[0], [-1], [2.5], ['2'], [null], [Number.NaN]])('буруу version %j татгалзана', (version) => {
    expect(VoteRequest.safeParse({ decision: 'APPROVE', version }).success).toBe(false);
  });
});

describe('MyApprovalItem: version', () => {
  const base = {
    applicationId: 'a', appNo: 'LA-1', borrowerName: null, amount: 1, currency: 'MNT', levelNo: 1, levelName: 'Салбар', totalLevels: 2,
    startedAt: '2026-11-18T00:00:00.000Z', dueAt: null, overdue: false,
  };
  it('version-тэй хүчинтэй', () => expect(MyApprovalItem.safeParse({ ...base, version: 2 }).success).toBe(true));
  it('version-гүй бол татгалзана (жагсаалтын мөр санал өгөхдөө хувилбараа дамжуулах ёстой)', () => expect(MyApprovalItem.safeParse(base).success).toBe(false));
});

describe('VoteRequest (FR-10.3)', () => {
  it('APPROVE тайлбаргүй болно', () => expect(VoteRequest.safeParse({ decision: 'APPROVE' }).success).toBe(true));
  it('RETURN тайлбаргүй бол буруу', () => { expect(VoteRequest.safeParse({ decision: 'RETURN' }).success).toBe(false); expect(VoteRequest.safeParse({ decision: 'RETURN', comment: '   ' }).success).toBe(false); });
  it('RETURN тайлбартай болно; нөхцөл засах талбар хориотой (strict)', () => {
    expect(VoteRequest.safeParse({ decision: 'RETURN', comment: 'Дутуу' }).success).toBe(true);
    expect(VoteRequest.safeParse({ decision: 'APPROVE', amount: 1 }).success).toBe(false);
  });
});
