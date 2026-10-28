import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSigningLinkNotifier, MockSigningLinkNotifier, renderSigningSms, SIGNING_SMS_TEMPLATE, UnconfiguredSigningLinkNotifier } from './signing-link-notifier';
import { maskPhone } from './pii';

const INPUT = {
  applicationId: 'app-1',
  phone: '+97699112233',
  signingUrl: 'https://sign.example.test/sign/SECRET-TOKEN-123',
  expiresAt: new Date('2026-10-31T09:00:00.000Z'),
};

describe('MockSigningLinkNotifier', () => {
  let output: string;
  beforeEach(() => {
    output = '';
    // Nest-ийн ConsoleLogger stdout/stderr руу бичдэг — бодит гаралтыг барьж шалгана
    const capture = (chunk: unknown) => {
      output += String(chunk);
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  });
  afterEach(() => vi.restoreAllMocks());

  it('зөвхөн {applicationId, phoneMasked} логлоно — URL, токен, утасны дугаар огт гарахгүй', async () => {
    await new MockSigningLinkNotifier().sendLink(INPUT);

    expect(output).toContain('app-1');
    expect(output).toContain('phoneMasked');
    expect(output).toContain('****2233');
    for (const secret of ['SECRET-TOKEN', 'sign.example.test', 'https://', '99112233', '+976', '2026-10-31']) expect(output).not.toContain(secret);
    expect(Object.keys(JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)))).toEqual(['applicationId', 'phoneMasked']);
  });
});

describe('maskPhone', () => {
  it.each([
    ['+97699112233', '****2233'],
    ['99112233', '****2233'],
    ['+976 9911-2233', '****2233'],
    ['12', '****12'],
  ])('%s → %s', (input, expected) => expect(maskPhone(input)).toBe(expected));
});

describe('renderSigningSms', () => {
  it('монгол текст, URL ба Улаанбаатарын цагаар хүчинтэй хугацаа (UTC+8)', () => {
    expect(SIGNING_SMS_TEMPLATE).toBe('Таны зээлийн гэрээг тоон гарын үсгээр баталгаажуулна уу: <url> (хүчинтэй: <date>)');
    expect(renderSigningSms({ signingUrl: 'https://s.test/sign/abc', expiresAt: new Date('2026-10-31T09:00:00.000Z') }))
      .toBe('Таны зээлийн гэрээг тоон гарын үсгээр баталгаажуулна уу: https://s.test/sign/abc (хүчинтэй: 2026-10-31)');
    // UTC 17:00 → Улаанбаатарт маргааш 01:00
    expect(renderSigningSms({ signingUrl: 'https://s.test/x', expiresAt: new Date('2026-10-31T17:00:00.000Z') })).toContain('(хүчинтэй: 2026-11-01)');
  });

  it('URL дотор "<date>" байсан ч дахин орлуулахгүй', () => {
    expect(renderSigningSms({ signingUrl: 'https://s.test/?q=<date>', expiresAt: new Date('2026-10-31T09:00:00.000Z') })).toContain('https://s.test/?q=<date> (');
  });
});

describe('createSigningLinkNotifier', () => {
  it('dev/mock горимд Mock', () => {
    expect(createSigningLinkNotifier({})).toBeInstanceOf(MockSigningLinkNotifier);
    expect(createSigningLinkNotifier({ INTEGRATION_MODE: 'mock', NODE_ENV: 'development' })).toBeInstanceOf(MockSigningLinkNotifier);
  });

  it.each([
    ['production', { NODE_ENV: 'production' }],
    ['production + mock', { NODE_ENV: 'production', INTEGRATION_MODE: 'mock' }],
    ['INTEGRATION_MODE=real', { INTEGRATION_MODE: 'real' }],
  ])('%s → SMS adapter холбогдоогүй (линк чимээгүй алдагдахгүй), 503', async (_name, env) => {
    const notifier = createSigningLinkNotifier(env);
    expect(notifier).toBeInstanceOf(UnconfiguredSigningLinkNotifier);
    await expect(notifier.sendLink(INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
