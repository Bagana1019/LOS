import { describe, expect, it } from 'vitest';
import { ChangePasswordBody } from '@los/contracts';
import { blockerText, passwordChecks, passwordMeetsPolicy, submitBlocker } from './password-rules';

// F9-15: албадмал нууц үг солих. Шаардлагыг бодит цагт чеклистээр харуулж (латин үсэг гэж заана), товч яагаад идэвхгүйг хэлнэ.
// Шаардлагын эх сурвалж: серверийн `ChangePasswordBody` (≥12, ≤200, [a-z], [A-Z], \d) — доорх "ижил шийдвэр" тест хоёрыг салахаас хамгаална.
const OK_PASSWORD = 'Abcdefghij1k'; // 12 тэмдэгт
const statusOf = (pw: string) => Object.fromEntries(passwordChecks(pw).map((c) => [c.key, c.ok]));

describe('passwordChecks', () => {
  it('хоосон нууц үг: бүх шаардлага биелээгүй, тэмдэгтийн тоо 0', () => {
    expect(statusOf('')).toEqual({ length: false, upper: false, lower: false, digit: false, max: true });
    expect(passwordChecks('').find((c) => c.key === 'length')?.count).toBe(0);
  });

  it('зөв нууц үг (яг 12 тэмдэгт): бүгд биелсэн', () => {
    expect(statusOf(OK_PASSWORD)).toEqual({ length: true, upper: true, lower: true, digit: true, max: true });
  });

  it.each([
    ['11 тэмдэгт', 'Abcdefghij1', 'length'],
    ['том үсэггүй ("password12345")', 'password12345', 'upper'],
    ['жижиг үсэггүй', 'ABCDEFGHIJ1K', 'lower'],
    ['тоогүй', 'Abcdefghijkl', 'digit'],
  ])('%s → зөвхөн "%s" шаардлага биелээгүй', (_name, pw, failing) => {
    const status = statusOf(pw);
    for (const [key, ok] of Object.entries(status)) expect(ok, `${key} (${pw})`).toBe(key !== failing);
  });

  it('"123456" → урт, том, жижиг үсэг биелээгүй; тоо биелсэн', () => {
    expect(statusOf('123456')).toEqual({ length: false, upper: false, lower: false, digit: true, max: true });
  });

  it('кирилл үсэг тоологдохгүй: "Бат Болд 1234567" → том/жижиг ЛАТИН үсэг биелээгүй', () => {
    expect(statusOf('Бат Болд 1234567')).toEqual({ length: true, upper: false, lower: false, digit: true, max: true });
  });

  it('200 тэмдэгт хүртэл зөв, 201-ээс "max" биелээгүй', () => {
    expect(statusOf(`Aa1${'x'.repeat(197)}`).max).toBe(true);
    expect(statusOf(`Aa1${'x'.repeat(198)}`).max).toBe(false);
  });

  it('тэмдэгтийн тоо ба зай/эможи: тоолуур нь бодит урт', () => {
    expect(passwordChecks('abc').find((c) => c.key === 'length')?.count).toBe(3);
    expect(passwordChecks('a b').find((c) => c.key === 'length')?.count).toBe(3);
  });
});

describe('passwordMeetsPolicy', () => {
  it('серверийн ChangePasswordBody.newPassword-той ижил шийдвэр', () => {
    const samples = [
      '', '123456', 'password12345', 'Бат Болд 1234567', OK_PASSWORD, 'Abcdefghij1', 'ABCDEFGHIJ1K', 'abcdefghij1k', 'Abcdefghijkl', 'Пароль-Aa1-Пароль',
      `Aa1${'x'.repeat(197)}`, `Aa1${'x'.repeat(198)}`, '   Aa1  Aa1  Aa1 ', 'Aa1!Aa1!Aa1!',
    ];
    for (const pw of samples) {
      const server = ChangePasswordBody.shape.newPassword.safeParse(pw).success;
      expect(passwordMeetsPolicy(pw), `нууц үг ${JSON.stringify(pw.slice(0, 20))} (${pw.length})`).toBe(server);
    }
  });
});

describe('submitBlocker — товч яагаад идэвхгүй', () => {
  const ok = { current: 'tmp-Pass-123', next: OK_PASSWORD, again: OK_PASSWORD };

  it('бүх нөхцөл биелсэн → null (товч идэвхтэй)', () => {
    expect(submitBlocker(ok)).toBeNull();
  });

  it.each([
    ['одоогийн нууц үг хоосон', { current: '' }, 'current'],
    ['одоогийн нууц үг 200-аас урт', { current: 'x'.repeat(201) }, 'current'],
    ['шинэ нууц үг шаардлага хангахгүй', { next: 'password12345', again: 'password12345' }, 'rules'],
    ['шинэ нууц үг одоогийнхтой ижил', { current: OK_PASSWORD }, 'same'],
    ['давтах талбар хоосон', { again: '' }, 'confirm'],
    ['давтсан нь таарахгүй', { again: `${OK_PASSWORD}x` }, 'mismatch'],
  ] as const)('%s → %s', (_name, over, expected) => {
    expect(submitBlocker({ ...ok, ...over })).toBe(expected);
  });

  it('эхний хангаагүй шаардлагыг буцаана: одоогийн нууц үг хоосон ба шинэ нь буруу бол "current"', () => {
    expect(submitBlocker({ current: '', next: '123456', again: '' })).toBe('current');
    expect(submitBlocker({ current: 'tmp-Pass-123', next: '123456', again: '' })).toBe('rules');
  });
});

describe('blockerText', () => {
  it('шалтгаан бүр Монгол мессежтэй, "Товч идэвхгүй байна" гэж эхэлнэ; null → хоосон', () => {
    expect(blockerText(null)).toBe('');
    expect(blockerText('current')).toBe('Товч идэвхгүй байна: одоогийн (түр) нууц үгээ оруулна уу');
    expect(blockerText('rules')).toBe('Товч идэвхгүй байна: шинэ нууц үг дээрх шаардлагыг бүрэн хангах ёстой');
    expect(blockerText('same')).toBe('Товч идэвхгүй байна: шинэ нууц үг одоогийнхоос өөр байх ёстой');
    expect(blockerText('confirm')).toBe('Товч идэвхгүй байна: шинэ нууц үгээ давтан оруулна уу');
    expect(blockerText('mismatch')).toBe('Товч идэвхгүй байна: давтсан нууц үг шинэ нууц үгтэй таарахгүй байна');
  });
});
