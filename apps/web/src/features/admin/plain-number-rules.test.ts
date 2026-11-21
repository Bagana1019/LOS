import { describe, expect, it } from 'vitest';
import { plainNumberProblem } from './plain-number-rules';

// Нэгжгүй тоо (хугацаа/сар, оноо, ӨТЧХ коэффициент): оролт нь утгыг clamp хийхгүй, дүрэм бүр тодорхой мессеж өгнө.
// undefined = хоосон (required тусдаа), NaN = "тоо биш текст".
const NOT_A_NUMBER = 'Зөвхөн тоо оруулна уу (жишээ: 12)';

describe('plainNumberProblem', () => {
  it('хоосон утга энд алдаа биш (заавал эсэхийг required дүрэм шийднэ)', () => {
    expect(plainNumberProblem(undefined, { label: 'Хугацаа' })).toBeNull();
    expect(plainNumberProblem(null, { label: 'Хугацаа' })).toBeNull();
  });

  it('NaN / Infinity → "зөвхөн тоо" (5сая зэрэг текст чимээгүй 5 болохгүй)', () => {
    expect(plainNumberProblem(Number.NaN, { label: 'Хугацаа' })).toBe(NOT_A_NUMBER);
    expect(plainNumberProblem(Number.POSITIVE_INFINITY, { label: 'Хугацаа' })).toBe(NOT_A_NUMBER);
  });

  it('хүрээнээс гарсан утга: clamp хийхгүй, хүрээг мессежид нэрлэнэ', () => {
    const o = { label: 'Доод хугацаа', min: 1, max: 600, integer: true };
    expect(plainNumberProblem(0, o)).toBe('Доод хугацаа 1–600 хооронд байх ёстой');
    expect(plainNumberProblem(700, o)).toBe('Доод хугацаа 1–600 хооронд байх ёстой');
    expect(plainNumberProblem(-5, o)).toBe('Доод хугацаа 1–600 хооронд байх ёстой');
    expect(plainNumberProblem(1, o)).toBeNull();
    expect(plainNumberProblem(600, o)).toBeNull();
  });

  it('бүхэл тоо: бутархайг чимээгүй дугуйлахгүй, татгалзана', () => {
    expect(plainNumberProblem(12.5, { label: 'Хугацаа', integer: true })).toBe('Хугацаа бүхэл тоо байх ёстой');
    expect(plainNumberProblem(12, { label: 'Хугацаа', integer: true })).toBeNull();
  });

  it('бутархай: анхдагч 4 орон (гэрээний dec4); илүүг татгалзана', () => {
    expect(plainNumberProblem(1.2345, { label: 'ӨТЧХ' })).toBeNull();
    expect(plainNumberProblem(1.23456, { label: 'ӨТЧХ' })).toBe('Бутархай хэсэг 4 оронгоос ихгүй байх ёстой');
    expect(plainNumberProblem(1.255, { label: 'ӨТЧХ', maxDecimals: 2 })).toBe('Бутархай хэсэг 2 оронгоос ихгүй байх ёстой');
  });
});
