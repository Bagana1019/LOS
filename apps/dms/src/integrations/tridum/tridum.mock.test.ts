import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockTridumProvider } from './tridum.mock';

const SECRET = 'tridum-test-secret-0123456789';
const DIGEST = createHash('sha256').update('pdf').digest('hex');
let nowMs = Date.UTC(2026, 9, 28, 3, 0, 0);
const provider = new MockTridumProvider({ clock: () => new Date(nowMs), approveAfterMs: 1000, webhookSecret: SECRET });

describe('MockTridumProvider', () => {
  it('Tridum-ийн мэдээлэл, mock тэмдэглэгээ', () => {
    expect(provider).toMatchObject({ code: 'TRIDUM', displayName: 'Tridum', isMock: true });
  });

  it('TRD-MOCK- ref, mock-tridum:// deep link, SIGNED болтол бүтэн урсгал', async () => {
    const session = await provider.createSession({
      signingRequestId: 'sr-1',
      document: { name: 'c.pdf', digest: { algorithm: 'SHA-256', hex: DIGEST } },
      signer: { fullName: 'Болд Бат', registerNo: 'УА12345678', phone: '99112233' },
      callbackUrl: null,
      ttlSeconds: 300,
      correlationId: 'c1',
    });
    expect(session.providerRef).toMatch(/^TRD-MOCK-/);
    expect(session.deepLink).toMatch(/^mock-tridum:\/\/sign\/TRD-MOCK-/);

    expect((await provider.getSession(session.providerRef)).state).toBe('PENDING');
    nowMs += 1000;
    const state = await provider.getSession(session.providerRef);
    expect(state.state).toBe('SIGNED');
    if (state.state === 'SIGNED') expect(state.signature.signatureCms.toString('utf8')).toContain('"provider":"TRIDUM"');
  });

  it('webhook: өөрийн ref-ийг зөвшөөрч, Monpass-ын ref-ийг татгалзана', () => {
    const accept = Buffer.from(JSON.stringify({ providerRef: 'TRD-MOCK-abc' }));
    const reject = Buffer.from(JSON.stringify({ providerRef: 'MPS-MOCK-abc' }));
    const sign = (raw: Buffer) => ({ 'x-mock-signature': createHmac('sha256', SECRET).update(raw).digest('hex') });

    expect(provider.parseWebhook({ headers: sign(accept), rawBody: accept })).toEqual({ providerRef: 'TRD-MOCK-abc' });
    expect(() => provider.parseWebhook({ headers: sign(reject), rawBody: reject })).toThrowError(expect.objectContaining({ code: 'INVALID_WEBHOOK' }));
  });
});
