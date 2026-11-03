import { describe, expect, it } from 'vitest';
import { VoteRequest } from './approval';

describe('VoteRequest (FR-10.3)', () => {
  it('APPROVE тайлбаргүй болно', () => expect(VoteRequest.safeParse({ decision: 'APPROVE' }).success).toBe(true));
  it('RETURN тайлбаргүй бол буруу', () => { expect(VoteRequest.safeParse({ decision: 'RETURN' }).success).toBe(false); expect(VoteRequest.safeParse({ decision: 'RETURN', comment: '   ' }).success).toBe(false); });
  it('RETURN тайлбартай болно; нөхцөл засах талбар хориотой (strict)', () => {
    expect(VoteRequest.safeParse({ decision: 'RETURN', comment: 'Дутуу' }).success).toBe(true);
    expect(VoteRequest.safeParse({ decision: 'APPROVE', amount: 1 }).success).toBe(false);
  });
});
