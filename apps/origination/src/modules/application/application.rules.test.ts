import { describe, expect, it } from 'vitest';
import { ApplicationStatus, StepKey } from '@los/contracts';
import {
  canTransition, formatAppNo, initialStepStatus, isHttpTransition, isUserTransition, missingRequiredSteps, stage1Progress, stageOf, STEP_ORDER, TRANSITIONS, unlocksStage2,
} from './application.rules';

describe('төлвийн машин (docs/01 §4)', () => {
  it('9 төлөв бүр шилжилтийн хүснэгтэд байна', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ApplicationStatus].sort());
  });
  it('зөвшөөрөгдсөн урсгал', () => {
    const ok: Array<[ApplicationStatus, ApplicationStatus]> = [
      ['DRAFT', 'SUBMITTED'], ['SUBMITTED', 'IN_APPROVAL'], ['IN_APPROVAL', 'APPROVED'], ['IN_APPROVAL', 'RETURNED'], ['RETURNED', 'SUBMITTED'],
      ['APPROVED', 'DISBURSING'], ['DISBURSING', 'ACTIVE'], ['ACTIVE', 'CLOSED'],
    ];
    for (const [a, b] of ok) expect(canTransition(a, b), `${a}>${b}`).toBe(true);
  });
  it('хориотой шилжилт (DRAFT→APPROVED гэх мэт)', () => {
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false);
    expect(canTransition('DRAFT', 'ACTIVE')).toBe(false);
    expect(canTransition('SUBMITTED', 'APPROVED')).toBe(false);
    expect(canTransition('CLOSED', 'DRAFT')).toBe(false);
    expect(canTransition('MIGRATED', 'CLOSED')).toBe(false);
    for (const s of ApplicationStatus) expect(canTransition(s, s), `${s}>${s}`).toBe(false);
  });
  it('хэрэглэгч (ЗЭЗ) зөвхөн илгээх; HTTP-ээр зөвхөн илгээх', () => {
    expect(isUserTransition('DRAFT', 'SUBMITTED')).toBe(true);
    expect(isUserTransition('IN_APPROVAL', 'APPROVED')).toBe(false);
    expect(isHttpTransition('DRAFT', 'SUBMITTED')).toBe(true);
    expect(isHttpTransition('RETURNED', 'SUBMITTED')).toBe(true);
    expect(isHttpTransition('APPROVED', 'DISBURSING')).toBe(false);
  });
  it('APPROVED үед л 2-р үе шат нээгдэнэ', () => {
    expect(ApplicationStatus.filter(unlocksStage2)).toEqual(['APPROVED']);
  });
});

describe('алхам', () => {
  it('12 алхам, 1-р үе шат 9, 2-р үе шат 3', () => {
    expect(STEP_ORDER).toHaveLength(12);
    expect([...StepKey].sort()).toEqual([...STEP_ORDER].sort());
    expect(STEP_ORDER.filter((k) => stageOf(k) === 1)).toHaveLength(9);
    expect(STEP_ORDER.filter((k) => initialStepStatus(k) === 'LOCKED')).toEqual(['contract', 'official_documents', 'disburse']);
  });
  it('G1: дутуу заавал алхмыг дарааллаар нь буцаана; STALE бүрдээгүй', () => {
    const req = ['client', 'income', 'score'];
    const steps = [{ stepKey: 'client', status: 'COMPLETED' }, { stepKey: 'income', status: 'STALE' }, { stepKey: 'score', status: 'PENDING' }];
    expect(missingRequiredSteps(steps, req)).toEqual(['income', 'score']);
    expect(missingRequiredSteps(steps.map((s) => ({ ...s, status: 'COMPLETED' })), req)).toEqual([]);
  });
  it('тоолуур 6/9', () => {
    const steps = STEP_ORDER.map((k, i) => ({ stepKey: k, status: i < 6 ? 'COMPLETED' : 'PENDING' }));
    expect(stage1Progress(steps)).toEqual({ completed: 6, total: 9 });
  });
});

describe('хүсэлтийн дугаар', () => {
  it('LA-<он>-<6 орон>', () => expect(formatAppNo(2026, 42)).toBe('LA-2026-000042'));
});
