import { describe, expect, it } from 'vitest';
import { CreateUserBody, normalizePhone } from '@los/contracts';
import { emailProblem, fullNameProblem, normalizeUserPhone, phoneProblem, rolesProblem, usernameProblem } from './user-form-rules';

// F9-13: хэрэглэгч нэмэх/засах форм. "bat@" и-мэйл амжилттай үүсдэг, хоосон хадгалахад англи "Required" гардаг байсан.
// Талбар бүр өөрийн Монгол мессежтэй. Нэвтрэх нэр/бүтэн нэр/дүр — серверийн `CreateUserBody`-той ижил; утас — төслийн 8 оронтой дүрэм (DECISIONS M1, `normalizePhone`).
const USERNAME_REQUIRED = 'Нэвтрэх нэрээ оруулна уу';
const USERNAME_FORMAT = 'Нэвтрэх нэр: зөвхөн латин үсэг, тоо, . _ - (3–40 тэмдэгт, эхний тэмдэгт үсэг эсвэл тоо). Кирилл, зай болохгүй';
const NAME_REQUIRED = 'Бүтэн нэрээ оруулна уу';
const NAME_SHORT = 'Бүтэн нэр дор хаяж 2 тэмдэгттэй байх ёстой';
const NAME_LONG = 'Бүтэн нэр 120 тэмдэгтээс хэтрэхгүй байх ёстой';
const EMAIL_FORMAT = 'И-мэйл хаяг буруу байна (жишээ: bat@example.mn)';
const PHONE_FORMAT = 'Утас 8 оронтой тоо байх ёстой (жишээ: 99112233). +976 угтварыг автоматаар хасна';
const ROLES_REQUIRED = 'Дор хаяж нэг дүр сонгоно уу';

describe('usernameProblem', () => {
  it.each([[''], ['   '], [undefined], [null]])('хоосон (%j) → заавал оруулах', (v) => expect(usernameProblem(v)).toBe(USERNAME_REQUIRED));
  it.each([['бат'], ['ab'], ['bat bold'], ['.bat'], ['bat@x'], ['a'.repeat(41)]])('буруу (%j) → латин үсэг/тоо гэж заана', (v) => expect(usernameProblem(v)).toBe(USERNAME_FORMAT));
  it.each([['bat.bold'], ['abc'], ['BAT.Bold'], ['  officer_1  '], ['a'.repeat(40)]])('зөв (%j) → алдаагүй', (v) => expect(usernameProblem(v)).toBeNull());

  it('серверийн CreateUserBody.username-тэй ижил шийдвэр', () => {
    for (const v of ['bat.bold', 'BAT', 'бат', 'ab', '', ' x y ', 'a'.repeat(40), 'a'.repeat(41), '-abc', 'a-b_c.d']) {
      expect(usernameProblem(v) === null, `нэвтрэх нэр ${JSON.stringify(v)}`).toBe(CreateUserBody.shape.username.safeParse(v).success);
    }
  });
});

describe('fullNameProblem', () => {
  it.each([[''], ['   '], [undefined], [null]])('хоосон (%j) → заавал оруулах', (v) => expect(fullNameProblem(v)).toBe(NAME_REQUIRED));
  it.each([['Б'], [' Б ']])('1 тэмдэгт (%j) → дор хаяж 2', (v) => expect(fullNameProblem(v)).toBe(NAME_SHORT));
  it('120-аас урт → хэтэрсэн гэж заана', () => expect(fullNameProblem('Б'.repeat(121))).toBe(NAME_LONG));
  it.each([['Бат Болд'], ['Бб'], ['Б'.repeat(120)]])('зөв (%j) → алдаагүй', (v) => expect(fullNameProblem(v)).toBeNull());

  it('серверийн CreateUserBody.fullName-тэй ижил шийдвэр', () => {
    for (const v of ['Бат Болд', ' ', 'Б', 'Бб', 'Б'.repeat(120), 'Б'.repeat(121)]) {
      expect(fullNameProblem(v) === null, `нэр ${JSON.stringify(v)}`).toBe(CreateUserBody.shape.fullName.safeParse(v).success);
    }
  });
});

describe('emailProblem', () => {
  it.each([[''], ['   '], [undefined], [null]])('хоосон (%j) → алдаагүй (заавал биш)', (v) => expect(emailProblem(v)).toBeNull());
  it.each([['bat@'], ['bat@x'], ['bat'], ['@example.mn'], ['bat@example'], ['bat bold@example.mn'], ['бат@example.mn'], ['a@b.c']])('буруу (%j) → формат гэж заана', (v) => expect(emailProblem(v)).toBe(EMAIL_FORMAT));
  it.each([['bat@example.mn'], ['  bat@example.mn  '], ['bat.bold+los@bank.example.com']])('зөв (%j) → алдаагүй', (v) => expect(emailProblem(v)).toBeNull());
});

describe('phoneProblem / normalizeUserPhone', () => {
  it.each([[''], ['   '], [undefined], [null]])('хоосон (%j) → алдаагүй (заавал биш)', (v) => expect(phoneProblem(v)).toBeNull());
  it.each([['99112233'], ['+976 9911-2233'], ['976 99112233'], ['9911-2233'], ['  99112233  '], ['(976) 99112233']])('зөв (%j) → алдаагүй', (v) => expect(phoneProblem(v)).toBeNull());
  it.each([['1234'], ['abc'], ['9911223344'], ['+976 123'], ['9911 22 3x']])('буруу (%j) → 8 оронтой гэж заана', (v) => expect(phoneProblem(v)).toBe(PHONE_FORMAT));

  it('нормчлол: +976 / зай / зураас хасагдаж 8 орон болно; хоосон/буруу утга өөрчлөгдөхгүй (trim-ээс бусад)', () => {
    expect(normalizeUserPhone('+976 9911-2233')).toBe('99112233');
    expect(normalizeUserPhone(' 99112233 ')).toBe('99112233');
    expect(normalizeUserPhone('')).toBe('');
    expect(normalizeUserPhone(undefined)).toBe('');
    expect(normalizeUserPhone(' abc ')).toBe('abc');
  });

  it('төслийн утасны дүрэм (`normalizePhone` + 8 оронтой тоо)-той ижил шийдвэр', () => {
    for (const v of ['99112233', '+976 9911-2233', '1234', 'abc', '9911223344', '976 99112233']) {
      expect(phoneProblem(v) === null, `утас ${JSON.stringify(v)}`).toBe(/^\d{8}$/.test(normalizePhone(v.trim())));
    }
  });
});

describe('rolesProblem', () => {
  it.each([[[]], [undefined], [null]])('дүргүй (%j) → дор хаяж нэг дүр', (v) => expect(rolesProblem(v)).toBe(ROLES_REQUIRED));
  it('нэг ба түүнээс олон дүр → алдаагүй', () => {
    expect(rolesProblem(['OFFICER'])).toBeNull();
    expect(rolesProblem(['OFFICER', 'COMPLIANCE'])).toBeNull();
  });
});

describe('англи zod мессеж байхгүй', () => {
  it('бүх талбарын мессеж Монгол', () => {
    const all = [usernameProblem(''), usernameProblem('бат'), fullNameProblem(''), fullNameProblem('Б'), fullNameProblem('Б'.repeat(121)), emailProblem('bat@'), phoneProblem('12'), rolesProblem([])];
    for (const m of all) expect(m).not.toMatch(/Required|String|character|Invalid|Array/);
  });
});
