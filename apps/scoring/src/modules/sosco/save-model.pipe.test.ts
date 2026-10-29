import { DEFAULT_SOSCO_CURVES, DEFAULT_SOSCO_GRADE_THRESHOLDS, DEFAULT_SOSCO_WEIGHTS } from '@los/calc';
import type { DomainError } from '@los/nest-common';
import { describe, expect, it } from 'vitest';
import { SaveSoscoModelPipe } from './save-model.pipe';

const ok = { weights: DEFAULT_SOSCO_WEIGHTS, gradeThresholds: DEFAULT_SOSCO_GRADE_THRESHOLDS, curves: DEFAULT_SOSCO_CURVES };
const run = (body: unknown): DomainError | unknown => {
  try {
    return new SaveSoscoModelPipe().transform(body);
  } catch (e) {
    return e;
  }
};

describe('SaveSoscoModelPipe', () => {
  it('accepts a valid model (curves optional)', () => {
    expect(run(ok)).toEqual(ok);
    expect(run({ weights: ok.weights, gradeThresholds: ok.gradeThresholds })).toEqual({ weights: ok.weights, gradeThresholds: ok.gradeThresholds });
  });

  it.each([
    ['weights do not sum to 1', { ...ok, weights: { ...DEFAULT_SOSCO_WEIGHTS, fico: 0.1 } }, 'weights'],
    ['thresholds not decreasing', { ...ok, gradeThresholds: { A: 500, B: 600, C: 400, D: 300, E: 0 } }, 'gradeThresholds'],
    ['inverted fico curve', { ...ok, curves: { ...DEFAULT_SOSCO_CURVES, fico: { min: 900, max: 300 } } }, 'curves.fico'],
  ])('domain-rule violation (%s) → 422 INVALID_SOSCO_MODEL with the offending path', (_name, body, path) => {
    const e = run(body) as DomainError;
    expect(e).toMatchObject({ code: 'INVALID_SOSCO_MODEL' });
    expect(e.getStatus()).toBe(422);
    expect(e.details).toEqual([{ path, code: 'custom' }]);
  });

  it.each([
    ['not an object', 'zxq-secret'],
    ['missing weights', { gradeThresholds: ok.gradeThresholds }],
    ['wrong type', { ...ok, weights: { ...DEFAULT_SOSCO_WEIGHTS, fico: 'zxq-secret' } }],
  ])('structural error (%s) → 400 VALIDATION_FAILED without echoing values', (_name, body) => {
    const e = run(body) as DomainError;
    expect(e).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(e.getStatus()).toBe(400);
    expect(JSON.stringify(e.getResponse())).not.toContain('zxq-secret');
  });

  it('a mix of out-of-range number and a domain rule is a structural error (400): the weight bounds fail first', () => {
    const e = run({ ...ok, weights: { ...DEFAULT_SOSCO_WEIGHTS, fico: 1.5 } }) as DomainError;
    expect(e.getStatus()).toBe(400);
  });
});
