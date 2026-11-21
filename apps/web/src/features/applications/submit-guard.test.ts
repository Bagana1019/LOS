import { describe, expect, it } from 'vitest';
import type { ApplicationDetail, ApplicationStepView, StepKey } from '@los/contracts';
import { blockedSubmitHint, blockedSubmitSteps } from './submit-guard';

// F2-3 / F3-6: «Илгээх» нь серверийн G1 хаалтыг (`transitions[SUBMITTED].blockedBy`) ашиглан идэвхгүй болно — дүрмийг дахин хэрэгжүүлэхгүй.
const step = (stepKey: StepKey, status: ApplicationStepView['status']): ApplicationStepView => ({ stepKey, stage: 1, order: 1, status, required: true, completedAt: null, staleReason: null });
const detail = (steps: ApplicationStepView[], blockedBy: StepKey[], to: 'SUBMITTED' | 'IN_APPROVAL' = 'SUBMITTED'): Pick<ApplicationDetail, 'steps' | 'transitions'> => ({
  steps,
  transitions: [{ to, allowed: true, blockedBy }],
});

describe('blockedSubmitSteps', () => {
  it('дутуу алхам байхгүй бол хоосон (товч идэвхтэй)', () => {
    expect(blockedSubmitSteps(detail([step('client', 'COMPLETED')], []))).toEqual([]);
  });

  it('серверийн blockedBy-ийн дарааллаар, алхам бүрийн одоогийн төлөвтэй (бүрдээгүй / хуучирсан)', () => {
    const app = detail([step('client', 'COMPLETED'), step('installment', 'STALE'), step('score', 'STALE'), step('document', 'PENDING')], ['installment', 'score', 'document']);
    expect(blockedSubmitSteps(app)).toEqual([
      { key: 'installment', status: 'STALE' },
      { key: 'score', status: 'STALE' },
      { key: 'document', status: 'PENDING' },
    ]);
  });

  it('steps-д олдохгүй түлхүүр бүрдээгүй гэж тооцогдоно', () => {
    expect(blockedSubmitSteps(detail([], ['income']))).toEqual([{ key: 'income', status: 'PENDING' }]);
  });

  it('SUBMITTED шилжилт байхгүй (өөр шилжилтийн blockedBy-д найдахгүй) бол хоосон', () => {
    expect(blockedSubmitSteps(detail([step('income', 'PENDING')], ['income'], 'IN_APPROVAL'))).toEqual([]);
  });
});

describe('blockedSubmitHint', () => {
  it('хаалт байхгүй бол null', () => {
    expect(blockedSubmitHint([])).toBeNull();
  });

  it('дутуу алхам бүрийг нэрээр, төлөвийн хамт нэрлэнэ', () => {
    const text = blockedSubmitHint([{ key: 'installment', status: 'STALE' }, { key: 'document', status: 'PENDING' }]);
    expect(text).toBe('Заавал бүрдэх алхам дутуу: Эргэн төлөлтийн хуваарь (Дахин шалгах), Баримт бичиг (Бүрдээгүй)');
  });
});
