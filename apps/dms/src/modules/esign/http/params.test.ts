import { describe, expect, it } from 'vitest';
import { generateLinkToken } from '../domain/tokens';
import { generateVerificationCode } from '../domain/verification-code';
import { SigningNotFoundError } from '../errors';
import { LinkTokenPipe, SigningRequestIdPipe, VerificationCodePipe, WebhookProviderPipe } from './params';

describe('SigningRequestIdPipe', () => {
  it('uuid-г өөрчлөхгүй, бусдыг SigningNotFoundError', () => {
    const pipe = new SigningRequestIdPipe();
    const id = 'c0a80101-1b57-4d0e-9a53-2a0c4b9b6a11';
    expect(pipe.transform(id)).toBe(id);
    for (const bad of ['', '1', 'not-a-uuid', `${id}0`, `${id} `, "' OR 1=1 --", '../etc']) expect(() => pipe.transform(bad)).toThrow(SigningNotFoundError);
  });
});

describe('LinkTokenPipe', () => {
  it('жинхэнэ токеныг дамжуулна; хэлбэр буруугийн бүгд SigningNotFoundError', () => {
    const pipe = new LinkTokenPipe();
    const token = generateLinkToken();
    expect(pipe.transform(token)).toBe(token);
    for (const bad of ['', token.slice(1), `${token}a`, `${token.slice(1)}+`, `${token.slice(1)}=`, `${token.slice(1)}/`, 'verify']) expect(() => pipe.transform(bad)).toThrow(SigningNotFoundError);
  });
});

describe('VerificationCodePipe', () => {
  it('зураастай/зураасгүй/жижиг үсэгтэй кодыг хадгалсан хэлбэрт (12 тэмдэгт, том үсэг) буцаана', () => {
    const pipe = new VerificationCodePipe();
    const code = generateVerificationCode();
    const grouped = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
    expect(pipe.transform(code)).toBe(code);
    expect(pipe.transform(grouped)).toBe(code);
    expect(pipe.transform(grouped.toLowerCase())).toBe(code);
  });

  it('хэлбэр буруу бол SigningNotFoundError', () => {
    const pipe = new VerificationCodePipe();
    for (const bad of ['', 'abc', 'UUUUUUUUUUUU', '0'.repeat(13), '0'.repeat(11), '../../etc/passwd', '0000 0000 0000 0000']) expect(() => pipe.transform(bad)).toThrow(SigningNotFoundError);
  });
});

describe('WebhookProviderPipe', () => {
  it('зөвхөн бүртгэлтэй provider-ийн ЖИЖИГ үсгийн нэр', () => {
    const pipe = new WebhookProviderPipe();
    expect(pipe.transform('tridum')).toBe('tridum');
    expect(pipe.transform('monpass')).toBe('monpass');
    for (const bad of ['', 'TRIDUM', 'Monpass', 'docusign', 'tridum ', 'tridum/', '__proto__', 'constructor']) expect(() => pipe.transform(bad)).toThrow(SigningNotFoundError);
  });
});
