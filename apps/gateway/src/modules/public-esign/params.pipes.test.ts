import { describe, expect, it } from 'vitest';
import { PublicEsignError } from './errors';
import { ProviderPipe, SigningTokenPipe, VerificationCodePipe } from './params.pipes';

const TOKEN = 'A'.repeat(20) + '-_' + '9'.repeat(21);

function notFound(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PublicEsignError);
    expect((e as PublicEsignError).getStatus()).toBe(404);
    expect((e as PublicEsignError).getResponse()).toMatchObject({ code: 'NOT_FOUND' });
    return;
  }
  throw new Error('expected 404');
}

describe('SigningTokenPipe', () => {
  const pipe = new SigningTokenPipe();
  it('43 тэмдэгт base64url-ийг зөвшөөрнө', () => {
    expect(TOKEN).toHaveLength(43);
    expect(pipe.transform(TOKEN)).toBe(TOKEN);
  });
  it.each(['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, `${'A'.repeat(42)}=`, `${'A'.repeat(41)}..`, `${'A'.repeat(42)}/`, `${'A'.repeat(42)}\n`, undefined, 42, ['x']])(
    'буруу токен %j → 404',
    (v) => notFound(() => pipe.transform(v)),
  );
});

describe('VerificationCodePipe', () => {
  const pipe = new VerificationCodePipe();
  it('12 тэмдэгт Crockford кодыг зөвшөөрнө', () => {
    expect(pipe.transform('0123456789AB')).toBe('0123456789AB');
    expect(pipe.transform('ABCDEFGHJKMN')).toBe('ABCDEFGHJKMN');
    expect(pipe.transform('PQRSTVWXYZ01')).toBe('PQRSTVWXYZ01');
  });
  it('бүлэглэсэн XXXX-XXXX-XXXX хэлбэрийг зураасгүй болгоно', () => {
    expect(pipe.transform('ABCD-EFGH-JKMN')).toBe('ABCDEFGHJKMN');
  });
  it.each([
    'abcdefghjkmn', // жижиг үсэг
    'ABCDEFGHJKM', // 11
    'ABCDEFGHJKMNP', // 13
    'ABCDEFGHJKMI', // I
    'ABCDEFGHJKML', // L
    'ABCDEFGHJKMO', // O
    'ABCDEFGHJKMU', // U
    'ABCDE-FGHJ-KMNP', // буруу бүлэглэлт
    'ABCD-EFGHJKMN', // хагас бүлэглэсэн
    'ABCD-EFGH-JKMN-', // төгсгөлд зураас
    '-ABCD-EFGH-JKMN',
    'ABCD--EFGH-JKMN',
    '',
    undefined,
  ])('буруу код %j → 404', (v) => notFound(() => pipe.transform(v)));
});

describe('ProviderPipe', () => {
  const pipe = new ProviderPipe();
  it.each(['tridum', 'monpass'])('%s зөвшөөрнө', (v) => expect(pipe.transform(v)).toBe(v));
  it.each(['TRIDUM', 'Monpass', 'mock', 'tridum ', 'tridum/../x', '', undefined])('буруу provider %j → 404', (v) => notFound(() => pipe.transform(v)));
});
