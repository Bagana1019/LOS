import { describe, expect, it } from 'vitest';
import { COLLATERAL_CHANGED, planCollateralStepUpdate, type StepRow } from './collateral-steps';

const NOW = new Date('2026-10-29T03:00:00.000Z');
const step = (stepKey: string, status: string, staleReason: string | null = null): StepRow => ({ id: `id-${stepKey}`, stepKey, status, staleReason });
const steps = (collateral: string, score = 'LOCKED'): StepRow[] => [step('client', 'COMPLETED'), step('collateral', collateral), step('score', score)];

describe('planCollateralStepUpdate', () => {
  it('G0 хангагдвал PENDING -> COMPLETED (completedAt = now)', () => {
    expect(planCollateralStepUpdate(steps('PENDING'), { gateComplete: true, scoreAffected: false }, NOW)).toEqual([
      { id: 'id-collateral', stepKey: 'collateral', status: 'COMPLETED', staleReason: null, completedAt: NOW },
    ]);
  });

  it('AC: G0 хангагдаагүй (LTV_EXCEEDED) бол алхам PENDING хэвээр - өөрчлөлтгүй', () => {
    expect(planCollateralStepUpdate(steps('PENDING'), { gateComplete: false, scoreAffected: false }, NOW)).toEqual([]);
  });

  it('COMPLETED байсан алхам G0 алдагдвал PENDING болж completedAt арилна', () => {
    expect(planCollateralStepUpdate(steps('COMPLETED'), { gateComplete: false, scoreAffected: false }, NOW)).toEqual([
      { id: 'id-collateral', stepKey: 'collateral', status: 'PENDING', staleReason: null, completedAt: null },
    ]);
  });

  it('COMPLETED хэвээр бол completedAt-д хүрэхгүй (идемпотент)', () => {
    expect(planCollateralStepUpdate(steps('COMPLETED'), { gateComplete: true, scoreAffected: false }, NOW)).toEqual([]);
  });

  it('STALE алхам G0 хангагдсан бол COMPLETED болно; хангагдаагүй бол PENDING', () => {
    expect(planCollateralStepUpdate(steps('STALE'), { gateComplete: true, scoreAffected: false }, NOW)[0]).toMatchObject({ status: 'COMPLETED' });
    expect(planCollateralStepUpdate(steps('STALE'), { gateComplete: false, scoreAffected: false }, NOW)[0]).toMatchObject({ status: 'PENDING' });
  });

  it('LOCKED алхамд хэзээ ч хүрэхгүй (collateral ба score)', () => {
    expect(planCollateralStepUpdate(steps('LOCKED', 'LOCKED'), { gateComplete: true, scoreAffected: true }, NOW)).toEqual([]);
    expect(planCollateralStepUpdate(steps('LOCKED', 'COMPLETED'), { gateComplete: true, scoreAffected: true }, NOW)).toEqual([
      { id: 'id-score', stepKey: 'score', status: 'STALE', staleReason: COLLATERAL_CHANGED },
    ]);
  });

  describe('score алхам', () => {
    it('барьцаа өөрчлөгдөхөд COMPLETED score -> STALE (COLLATERAL_CHANGED)', () => {
      const out = planCollateralStepUpdate(steps('COMPLETED', 'COMPLETED'), { gateComplete: false, scoreAffected: true }, NOW);
      expect(out.map((u) => `${u.stepKey}:${u.status}`)).toEqual(['collateral:PENDING', 'score:STALE']);
      expect(out[1]).toMatchObject({ staleReason: 'COLLATERAL_CHANGED' });
      expect(out[1]).not.toHaveProperty('completedAt');
    });

    it.each(['PENDING', 'STALE', 'IN_PROGRESS', 'LOCKED'])('score %s бол хөндөхгүй', (status) => {
      expect(planCollateralStepUpdate(steps('PENDING', status), { gateComplete: false, scoreAffected: true }, NOW)).toEqual([]);
    });

    it('scoreAffected=false (өмчлөл/ачаалал/баримт) бол COMPLETED score-д хүрэхгүй', () => {
      expect(planCollateralStepUpdate(steps('PENDING', 'COMPLETED'), { gateComplete: true, scoreAffected: false }, NOW).map((u) => u.stepKey)).toEqual(['collateral']);
    });
  });

  it('алхамын мөр байхгүй бол алгасна', () => {
    expect(planCollateralStepUpdate([], { gateComplete: true, scoreAffected: true }, NOW)).toEqual([]);
    expect(planCollateralStepUpdate([step('client', 'COMPLETED')], { gateComplete: true, scoreAffected: true }, NOW)).toEqual([]);
  });
});
