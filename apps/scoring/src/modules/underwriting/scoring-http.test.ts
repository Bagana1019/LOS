import { DomainError } from '@los/nest-common';
import { SCORING_ERROR_CODES, ScoreRequest, SelectMethodRequest } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { scoreRequest } from './testing/m8';
import { calculationNotFound, calculationStale, methodNotApplicable, requireUserId, ScoringZodPipe, scoringError, validationFailed } from './scoring-http';

describe('scoring errors', () => {
  it('use the stable contract codes, Mongolian messages and the documented HTTP status', () => {
    const cases: Array<[DomainError, string, number]> = [
      [calculationNotFound(), 'CALCULATION_NOT_FOUND', 404],
      [calculationStale(), 'CALCULATION_STALE', 409],
      [methodNotApplicable('B_BUSINESS'), 'METHOD_NOT_APPLICABLE', 422],
    ];
    for (const [e, code, status] of cases) {
      expect(e).toBeInstanceOf(DomainError);
      expect(SCORING_ERROR_CODES).toContain(code);
      expect(e.code).toBe(code);
      expect(e.getStatus()).toBe(status);
      expect(e.message).toMatch(/[Ѐ-ӿ]/); // кирилл
    }
    expect(scoringError('INVALID_SOSCO_MODEL', 'x', 422, { a: 1 }).details).toEqual({ a: 1 });
  });
});

describe('ScoringZodPipe', () => {
  it('returns the parsed value (defaults applied, strings trimmed by the schema)', () => {
    const { collateralRequired: _drop, ...without } = scoreRequest();
    expect(new ScoringZodPipe(ScoreRequest).transform(without).collateralRequired).toBe(true);
    expect(new ScoringZodPipe(SelectMethodRequest).transform({ method: 'A_SALARY', reason: '  тайлбар ' })).toEqual({ method: 'A_SALARY', reason: 'тайлбар' });
  });

  it('rejects with 400 VALIDATION_FAILED whose details hold only paths and zod codes — never the offending values', () => {
    const bad = { ...scoreRequest(), amount: 'zxq-secret', termMonths: -3, policy: { ...scoreRequest().policy, maxDti: 'zxq-secret-2' } };
    let caught: unknown;
    try {
      new ScoringZodPipe(ScoreRequest).transform(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'VALIDATION_FAILED' });
    const error = caught as DomainError;
    expect(error.getStatus()).toBe(400);
    expect(error.details).toEqual(expect.arrayContaining([{ path: 'amount', code: 'invalid_type' }, { path: 'policy.maxDti', code: 'invalid_type' }]));
    expect(JSON.stringify(error.getResponse())).not.toContain('zxq-secret');
  });

  it('an invalid enum value is reported by code only (zod would echo it in the message)', () => {
    let caught: DomainError | undefined;
    try {
      new ScoringZodPipe(SelectMethodRequest).transform({ method: 'zxq-secret' });
    } catch (e) {
      caught = e as DomainError;
    }
    expect(caught?.details).toEqual([{ path: 'method', code: 'invalid_enum_value' }]);
    expect(JSON.stringify(caught?.getResponse())).not.toContain('zxq-secret');
  });

  it('caps the number of reported issues', () => {
    const error = validationFailed(ScoreRequest.safeParse({}).error!);
    expect((error.details as unknown[]).length).toBeLessThanOrEqual(20);
  });
});

describe('requireUserId', () => {
  it('returns the user id or throws 401 UNAUTHENTICATED', () => {
    expect(requireUserId({ userId: 'u-1' })).toBe('u-1');
    expect(() => requireUserId({ userId: null })).toThrowError(expect.objectContaining({ status: 401 }));
  });
});
