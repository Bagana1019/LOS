import { describe, expect, it } from 'vitest';
import { CreateBranchBody } from '@los/contracts';
import { branchCodeProblem, branchNameProblem } from './branch-form';

// F9-12: салбар нэмэх форм. Талбар бүр өөрийн Монгол мессежтэй ("Required" / англи zod биш); дүрэм нь серверийн `CreateBranchBody`-той ижил.
const CODE_REQUIRED = 'Салбарын кодоо оруулна уу (жишээ: UB01)';
const CODE_FORMAT = 'Код: зөвхөн латин үсэг, тоо (жишээ: UB01), 1–12 тэмдэгт. Кирилл үсэг, зай, тэмдэгт болохгүй';
const NAME_REQUIRED = 'Салбарын нэрээ оруулна уу';
const NAME_SHORT = 'Салбарын нэр дор хаяж 2 тэмдэгттэй байх ёстой';
const NAME_LONG = 'Салбарын нэр 120 тэмдэгтээс хэтрэхгүй байх ёстой';

describe('branchCodeProblem', () => {
  it.each([[''], ['   '], [undefined], [null]])('хоосон код (%j) → заавал оруулах мессеж', (v) => {
    expect(branchCodeProblem(v)).toBe(CODE_REQUIRED);
  });

  it.each([['тест'], ['F 9 !'], ['UB-01'], ['UB 01'], ['ӨВӨР1'], ['A'.repeat(13)]])('буруу код (%j) → латин үсэг/тоо гэж заана', (v) => {
    expect(branchCodeProblem(v)).toBe(CODE_FORMAT);
  });

  it.each([['UB01'], ['ub01'], ['  UB01  '], ['1'], ['A'.repeat(12)], ['100']])('зөв код (%j) → алдаагүй', (v) => {
    expect(branchCodeProblem(v)).toBeNull();
  });

  it('серверийн CreateBranchBody-той ижил шийдвэр гаргана', () => {
    const samples = ['UB01', 'ub01', ' UB01 ', 'тест', 'F 9 !', 'UB-01', '', 'A'.repeat(12), 'A'.repeat(13), '０１'];
    for (const code of samples) {
      const serverOk = CreateBranchBody.shape.code.safeParse(code).success;
      expect(branchCodeProblem(code) === null, `код ${JSON.stringify(code)}`).toBe(serverOk);
    }
  });
});

describe('branchNameProblem', () => {
  it.each([[''], ['   '], [undefined], [null]])('хоосон нэр (%j) → заавал оруулах мессеж', (v) => {
    expect(branchNameProblem(v)).toBe(NAME_REQUIRED);
  });

  it.each([['А'], [' А '], ['Б ']])('1 тэмдэгттэй нэр (%j) → дор хаяж 2 гэж заана', (v) => {
    expect(branchNameProblem(v)).toBe(NAME_SHORT);
  });

  it('120-аас урт нэр → хэтэрсэн гэж заана', () => {
    expect(branchNameProblem('Б'.repeat(121))).toBe(NAME_LONG);
  });

  it.each([['Төв'], ['Баянзүрх салбар'], ['Б'.repeat(120)], ['  Төв  ']])('зөв нэр (%j) → алдаагүй', (v) => {
    expect(branchNameProblem(v)).toBeNull();
  });

  it('серверийн CreateBranchBody-той ижил шийдвэр гаргана', () => {
    const samples = ['Төв', '  ', 'А', ' А ', 'Б'.repeat(120), 'Б'.repeat(121), 'Ө'];
    for (const name of samples) {
      const serverOk = CreateBranchBody.shape.name.safeParse(name).success;
      expect(branchNameProblem(name) === null, `нэр ${JSON.stringify(name)}`).toBe(serverOk);
    }
  });

  it('англи zod мессеж байхгүй', () => {
    for (const v of ['', 'А', 'Б'.repeat(121)]) expect(branchNameProblem(v)).not.toMatch(/String|Required|character/);
  });
});
