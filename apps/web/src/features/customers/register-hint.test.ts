import { describe, expect, it } from 'vitest';
import { hasLatinLetters, registerInputProblem, registerSearchHint } from './register-hint';

// F1-5: Latin гар дээр "UB99010112" бичвэл «буруу» биш, кирилл үсгээр бичихийг хэлнэ.
describe('hasLatinLetters', () => {
  it('detects Latin letters in any case, including a Latin look-alike mixed with Cyrillic', () => {
    expect(hasLatinLetters('UB99010112')).toBe(true);
    expect(hasLatinLetters('ub99010112')).toBe(true);
    expect(hasLatinLetters('УB99010112')).toBe(true);
  });
  it('is false for Cyrillic, digits and empty input', () => {
    expect(hasLatinLetters('УБ99010112')).toBe(false);
    expect(hasLatinLetters('5012345')).toBe(false);
    expect(hasLatinLetters('')).toBe(false);
  });
});

describe('registerInputProblem (register field on /customer/new)', () => {
  it('is null for a valid individual (any case, spaces) and legal-entity register', () => {
    expect(registerInputProblem('УБ99010112')).toBeNull();
    expect(registerInputProblem(' уб 99010112 ')).toBeNull();
    expect(registerInputProblem('5012345')).toBeNull();
  });
  it('LATIN when the shape is right but the letters are Latin (UB -> УБ)', () => {
    expect(registerInputProblem('UB99010112')).toBe('LATIN');
    expect(registerInputProblem('ub 99010112')).toBe('LATIN');
    expect(registerInputProblem('УB99010112')).toBe('LATIN');
  });
  it('INVALID for everything else (empty, wrong length, garbage) so the generic message stays', () => {
    expect(registerInputProblem('')).toBe('INVALID');
    expect(registerInputProblem('УБ9901')).toBe('INVALID');
    expect(registerInputProblem('УБ990101123')).toBe('INVALID');
    expect(registerInputProblem('abc')).toBe('INVALID');
    expect(registerInputProblem('12345')).toBe('INVALID');
  });
});

// F1-1: регистр blind-index (зөвхөн бүтэн утгаар) тул хэсэгчилсэн регистрийн хайлт «олдсонгүй» гарна — тайлбар хэрэгтэй.
describe('registerSearchHint (empty-state hint in the customer list)', () => {
  it('PARTIAL for a Cyrillic prefix of a register: letters only or letters + fewer than 8 digits', () => {
    expect(registerSearchHint('УБ')).toBe('PARTIAL');
    expect(registerSearchHint('уб')).toBe('PARTIAL');
    expect(registerSearchHint('уб 9901')).toBe('PARTIAL');
    expect(registerSearchHint('УБ9901011')).toBe('PARTIAL');
  });
  it('LATIN when the term looks like a register typed with Latin letters (also a full-length one)', () => {
    expect(registerSearchHint('UB')).toBe('LATIN');
    expect(registerSearchHint('ub9901')).toBe('LATIN');
    expect(registerSearchHint('UB99010112')).toBe('LATIN');
  });
  it('null for a complete valid register (the exact match already works) and for names, phones and empty input', () => {
    expect(registerSearchHint('УБ99010112')).toBeNull();
    expect(registerSearchHint('5012345')).toBeNull();
    expect(registerSearchHint('Бат')).toBeNull();
    expect(registerSearchHint('Сарнай')).toBeNull();
    expect(registerSearchHint('9911')).toBeNull();
    expect(registerSearchHint('99112233')).toBeNull();
    expect(registerSearchHint('')).toBeNull();
    expect(registerSearchHint('   ')).toBeNull();
  });
});
