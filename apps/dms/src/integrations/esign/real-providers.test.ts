import { describe, expect, it } from 'vitest';
import { RealMonpassProvider } from '../monpass/monpass.real';
import { RealTridumProvider } from '../tridum/tridum.real';
import type { CreateProviderSessionInput, ESignProviderPort } from './esign-provider.port';
import type { RealProviderEnv } from './real-config';

const INPUT: CreateProviderSessionInput = {
  signingRequestId: 'sr-1',
  document: { name: 'c.pdf', digest: { algorithm: 'SHA-256', hex: 'a'.repeat(64) } },
  signer: { fullName: 'Болд Бат', registerNo: 'УА12345678', phone: '99112233' },
  callbackUrl: null,
  ttlSeconds: 300,
  correlationId: 'corr-1',
};

function configured(prefix: string): Record<string, string> {
  return {
    [`${prefix}_BASE_URL`]: 'https://sandbox.example.test',
    [`${prefix}_CLIENT_ID`]: 'id-secret-marker',
    [`${prefix}_CLIENT_SECRET`]: 'secret-secret-marker',
    [`${prefix}_WEBHOOK_SECRET`]: 'hook-secret-marker',
  };
}

type Call = [name: string, invoke: (p: ESignProviderPort) => unknown];
const CALLS: Call[] = [
  ['createSession', (p) => p.createSession(INPUT)],
  ['getSession', (p) => p.getSession('ref-1')],
  ['cancelSession', (p) => p.cancelSession('ref-1')],
  ['parseWebhook', (p) => p.parseWebhook({ headers: { 'x-signature': 'anything' }, rawBody: Buffer.from('{}') })],
];

/** sync (parseWebhook) болон async method-ийн алдааг ижил хэлбэрээр авна */
async function outcome(invoke: () => unknown): Promise<unknown> {
  try {
    await invoke();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

describe.each([
  { name: 'Tridum', prefix: 'TRIDUM', code: 'TRIDUM', make: (env: RealProviderEnv) => new RealTridumProvider(env) },
  { name: 'Monpass', prefix: 'MONPASS', code: 'MONPASS', make: (env: RealProviderEnv) => new RealMonpassProvider(env) },
])('Real$name stub', ({ name, prefix, code, make }) => {
  it('isMock=false, зөв code/displayName', () => {
    expect(make({})).toMatchObject({ code, displayName: name, isMock: false });
  });

  it.each(CALLS)('тохиргоо дутуу үед %s → NOT_CONFIGURED (дутуу хувьсагчийн нэртэй)', async (_method, invoke) => {
    const err = await outcome(() => invoke(make({})));

    expect(err).toMatchObject({ name: 'ESignProviderError', code: 'NOT_CONFIGURED', retryable: false });
    expect((err as Error).message).toContain(`${prefix}_BASE_URL`);
    expect((err as Error).message).toContain(`${prefix}_WEBHOOK_SECRET`);
  });

  it.each(CALLS)('тохиргоо бүрэн үед %s → NOT_IMPLEMENTED (retryable биш), нууц утгыг гаргахгүй', async (method, invoke) => {
    const err = await outcome(() => invoke(make(configured(prefix))));

    expect(err).toMatchObject({ name: 'ESignProviderError', code: 'NOT_IMPLEMENTED', retryable: false });
    expect((err as Error).message).toContain(method);
    expect((err as Error).message).not.toMatch(/secret-marker|sandbox\.example/);
  });

  it('parseWebhook нь sync шиднэ (хэзээ ч webhook-ийг зөвшөөрөхгүй — fail closed)', () => {
    const provider = make(configured(prefix));
    expect(() => provider.parseWebhook({ headers: {}, rawBody: Buffer.alloc(0) })).toThrowError(expect.objectContaining({ code: 'NOT_IMPLEMENTED' }));
  });

  it('тохиргоог дуудлага бүрт уншина — дараа нь тохируулбал NOT_CONFIGURED → NOT_IMPLEMENTED болно', async () => {
    const env: Record<string, string | undefined> = {};
    const provider = make(env);
    expect(await outcome(() => provider.getSession('r'))).toMatchObject({ code: 'NOT_CONFIGURED' });

    Object.assign(env, configured(prefix));
    expect(await outcome(() => provider.getSession('r'))).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('өөр provider-ийн хувьсагчаар тохируулагдахгүй', async () => {
    const other = prefix === 'TRIDUM' ? 'MONPASS' : 'TRIDUM';
    expect(await outcome(() => make(configured(other)).createSession(INPUT))).toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});
