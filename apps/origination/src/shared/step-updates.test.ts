import { describe, expect, it } from 'vitest';
import { planScoreStale, planStepTarget, type StepRow } from './step-updates';

const NOW = new Date('2026-11-03T00:00:00Z');
const step = (stepKey: string, status: string, staleReason: string | null = null): StepRow => ({ id: `id-${stepKey}`, stepKey, status, staleReason });

describe('planStepTarget', () => {
  it('PENDING → COMPLETED stamps completedAt and clears the reason', () => {
    expect(planStepTarget([step('income', 'PENDING', 'INCOME_MISSING')], 'income', { status: 'COMPLETED', reason: null }, NOW)).toEqual([{ id: 'id-income', stepKey: 'income', status: 'COMPLETED', staleReason: null, completedAt: NOW }]);
  });
  it('already COMPLETED is a no-op (keeps the original completedAt)', () => {
    expect(planStepTarget([step('income', 'COMPLETED')], 'income', { status: 'COMPLETED', reason: null }, NOW)).toEqual([]);
  });
  it('STALE → COMPLETED re-stamps; COMPLETED → PENDING clears completedAt and records the reason', () => {
    expect(planStepTarget([step('income', 'STALE', 'BORROWERS_CHANGED')], 'income', { status: 'COMPLETED', reason: null }, NOW)[0]).toMatchObject({ status: 'COMPLETED', completedAt: NOW });
    expect(planStepTarget([step('income', 'COMPLETED')], 'income', { status: 'PENDING', reason: 'INCOME_MISSING' }, NOW)).toEqual([{ id: 'id-income', stepKey: 'income', status: 'PENDING', staleReason: 'INCOME_MISSING', completedAt: null }]);
  });
  it('same PENDING status but a new reason updates; the same reason does not', () => {
    expect(planStepTarget([step('inquiry', 'PENDING', 'INQUIRY_MISSING')], 'inquiry', { status: 'PENDING', reason: 'INQUIRY_STALE' }, NOW)).toHaveLength(1);
    expect(planStepTarget([step('inquiry', 'PENDING', 'INQUIRY_STALE')], 'inquiry', { status: 'PENDING', reason: 'INQUIRY_STALE' }, NOW)).toEqual([]);
  });
  it('never touches LOCKED or missing steps', () => {
    expect(planStepTarget([step('income', 'LOCKED')], 'income', { status: 'COMPLETED', reason: null }, NOW)).toEqual([]);
    expect(planStepTarget([], 'income', { status: 'COMPLETED', reason: null }, NOW)).toEqual([]);
  });
});

describe('planScoreStale', () => {
  it('only a COMPLETED score becomes STALE', () => {
    expect(planScoreStale([step('score', 'COMPLETED')], 'INCOME_CHANGED')).toEqual([{ id: 'id-score', stepKey: 'score', status: 'STALE', staleReason: 'INCOME_CHANGED' }]);
    expect(planScoreStale([step('score', 'PENDING')], 'X')).toEqual([]);
    expect(planScoreStale([step('score', 'LOCKED')], 'X')).toEqual([]);
    expect(planScoreStale([], 'X')).toEqual([]);
  });
});
