import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockMonpassProvider } from './monpass.mock';

const SECRET = 'monpass-test-secret-0123456789';
const DIGEST = createHash('sha256').update('pdf').digest('hex');
let nowMs = Date.UTC(2026, 9, 28, 3, 0, 0);
const provider = new MockMonpassProvider({ clock: () => new Date(nowMs), approveAfterMs: 1000, webhookSecret: SECRET });

describe('MockMonpassProvider', () => {
  it('Monpass-ийн мэдээлэл, mock тэмдэглэгээ', () => {
    expect(provider).toMatchObject({ code: 'MONPASS', displayName: 'Monpass', isMock: true });
  });

  it('MPS-MOCK- ref, mock-monpass:// deep link, SIGNED болтол бүтэн урсгал', async () => {
    const session = await provider.createSession({
      signingRequestId: 'sr-2',
      document: { name: 'c.pdf', digest: { algorithm: 'SHA-256', hex: DIGEST } },
      signer: { fullName: 'Болд Бат', registerNo: 'УА12345600', phone: '99112233' },
      callbackUrl: null,
      ttlSeconds: 300,
      correlationId: 'c2',
    });
    expect(session.providerRef).toMatch(/^MPS-MOCK-/);
    expect(session.deepLink).toMatch(/^mock-monpass:\/\/sign\/MPS-MOCK-/);

    nowMs += 1000;
    expect(await provider.getSession(session.providerRef)).toEqual({ state: 'DECLINED' }); // fixture 00
  });

  it('webhook: өөрийн ref-ийг зөвшөөрч, Tridum-ын ref-ийг татгалзана', () => {
    const accept = Buffer.from(JSON.stringify({ providerRef: 'MPS-MOCK-abc' }));
    const reject = Buffer.from(JSON.stringify({ providerRef: 'TRD-MOCK-abc' }));
    const sign = (raw: Buffer) => ({ 'x-mock-signature': createHmac('sha256', SECRET).update(raw).digest('hex') });

    expect(provider.parseWebhook({ headers: sign(accept), rawBody: accept })).toEqual({ providerRef: 'MPS-MOCK-abc' });
    expect(() => provider.parseWebhook({ headers: sign(reject), rawBody: reject })).toThrowError(expect.objectContaining({ code: 'INVALID_WEBHOOK' }));
  });
});
