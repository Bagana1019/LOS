import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ESignProviderError, type CreateProviderSessionInput, type ProviderSessionState } from './esign-provider.port';
import {
  isMockSigningControl,
  MOCK_CA_ISSUER,
  MOCK_CMS_MARKER,
  MOCK_FAILURE_CODE,
  MOCK_WEBHOOK_SIGNATURE_HEADER,
  MockRemoteSigner,
  selectMockFixture,
  type MockFixture,
} from './mock-remote-signer';

const SECRET = 'unit-test-webhook-secret-0123456789';
const START_MS = Date.UTC(2026, 9, 28, 3, 0, 0);
const DIGEST_HEX = createHash('sha256').update('contract-pdf-bytes').digest('hex');
const DEFAULT_REGISTER = 'УА12345678';
const FULL_NAME = 'Бат-Эрдэнэ Болд';

function setup(overrides: { approveAfterMs?: number } = {}) {
  let nowMs = START_MS;
  const signer = new MockRemoteSigner({
    code: 'TRIDUM',
    displayName: 'Tridum',
    refPrefix: 'TRD-MOCK',
    deepLinkScheme: 'mock-tridum',
    clock: () => new Date(nowMs),
    approveAfterMs: overrides.approveAfterMs ?? 3000,
    webhookSecret: SECRET,
  });
  return { signer, advance: (ms: number) => { nowMs += ms; }, nowMs: () => nowMs };
}

function sessionInput(registerNo = DEFAULT_REGISTER, overrides: Partial<CreateProviderSessionInput> = {}): CreateProviderSessionInput {
  return {
    signingRequestId: 'sr-1',
    document: { name: 'contract.pdf', digest: { algorithm: 'SHA-256', hex: DIGEST_HEX } },
    signer: { fullName: FULL_NAME, registerNo, phone: '99112233' },
    callbackUrl: null,
    ttlSeconds: 300,
    correlationId: 'corr-1',
    ...overrides,
  };
}

function signed(state: ProviderSessionState) {
  if (state.state !== 'SIGNED') throw new Error(`expected SIGNED, got ${state.state}`);
  return state.signature;
}

async function rejection(promise: Promise<unknown>): Promise<ESignProviderError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ESignProviderError);
  return err as ESignProviderError;
}

function signBody(body: string | Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('selectMockFixture', () => {
  it.each<[string, MockFixture]>([
    ['УА12345600', 'DECLINE'],
    ['УА12345699', 'NEVER_APPROVE'],
    ['УА12345655', 'PROVIDER_ERROR'],
    ['УА12345677', 'IDENTITY_MISMATCH'],
    ['УА12345611', 'DIGEST_MISMATCH'],
    ['УА12345678', 'APPROVE'],
    ['УА12345601', 'APPROVE'],
    ['УА123456АБ', 'APPROVE'],
    ['7', 'APPROVE'],
    ['', 'APPROVE'],
  ])('%s → %s (сүүлийн 2 цифрээр)', (registerNo, fixture) => {
    expect(selectMockFixture(registerNo)).toBe(fixture);
  });
});

describe('constructor', () => {
  const base = { code: 'TRIDUM', displayName: 'Tridum', refPrefix: 'TRD-MOCK', deepLinkScheme: 'mock-tridum', clock: () => new Date(), approveAfterMs: 0, webhookSecret: SECRET } as const;

  it('хоосон webhookSecret, буруу approveAfterMs, буруу scheme-ийг татгалзана', () => {
    expect(() => new MockRemoteSigner({ ...base, webhookSecret: '' })).toThrow(/webhookSecret/);
    expect(() => new MockRemoteSigner({ ...base, approveAfterMs: -1 })).toThrow(/approveAfterMs/);
    expect(() => new MockRemoteSigner({ ...base, approveAfterMs: 1.5 })).toThrow(/approveAfterMs/);
    expect(() => new MockRemoteSigner({ ...base, deepLinkScheme: 'mock tridum://' })).toThrow(/deepLinkScheme/);
  });

  it('isMock=true, code/displayName тохиргооноос', () => {
    const { signer } = setup();
    expect(signer).toMatchObject({ code: 'TRIDUM', displayName: 'Tridum', isMock: true });
  });
});

describe('createSession', () => {
  it('providerRef, 4 оронтой challengeCode, deepLink, expiresAt = now + ttl', async () => {
    const { signer } = setup();
    const session = await signer.createSession(sessionInput());

    expect(session.providerRef).toMatch(/^TRD-MOCK-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(session.deepLink).toBe(`mock-tridum://sign/${session.providerRef}`);
    expect(session.expiresAt).toEqual(new Date(START_MS + 300_000));
    // brief: challengeCode = sha256(digest hex + providerRef)-ээс гарсан 4 орон
    const expected = String(createHash('sha256').update(DIGEST_HEX + session.providerRef).digest().readUInt32BE(0) % 10_000).padStart(4, '0');
    expect(session.challengeCode).toBe(expected);
    expect(session.challengeCode).toMatch(/^\d{4}$/);
  });

  it('session бүр өөр ref авна; digest том үсгээр ирсэн ч жижиг hex-ээр тулгана', async () => {
    const { signer, advance } = setup({ approveAfterMs: 0 });
    const upper = sessionInput(DEFAULT_REGISTER, { document: { name: 'c.pdf', digest: { algorithm: 'SHA-256', hex: DIGEST_HEX.toUpperCase() } } });
    const a = await signer.createSession(upper);
    const b = await signer.createSession(upper);
    advance(1);

    expect(a.providerRef).not.toBe(b.providerRef);
    expect(signed(await signer.getSession(a.providerRef)).signedDigestHex).toBe(DIGEST_HEX);
  });

  it.each([
    ['SHA-256 биш hex', { algorithm: 'SHA-256' as const, hex: 'zz'.repeat(32) }],
    ['богино hex', { algorithm: 'SHA-256' as const, hex: DIGEST_HEX.slice(2) }],
    ['өөр алгоритм', { algorithm: 'SHA-1' as unknown as 'SHA-256', hex: DIGEST_HEX }],
  ])('буруу digest (%s) → REJECTED', async (_title, digest) => {
    const { signer } = setup();
    const err = await rejection(signer.createSession(sessionInput(DEFAULT_REGISTER, { document: { name: 'c.pdf', digest } })));
    expect(err.code).toBe('REJECTED');
    expect(err.retryable).toBe(false);
  });

  it.each([0, -5, 1.5, Number.NaN])('ttlSeconds=%s → REJECTED', async (ttlSeconds) => {
    const { signer } = setup();
    expect((await rejection(signer.createSession(sessionInput(DEFAULT_REGISTER, { ttlSeconds })))).code).toBe('REJECTED');
  });

  it('гарын үсэг зурагчийн мэдээлэл хоосон бол REJECTED, мессеж регистр/нэр/утас агуулахгүй', async () => {
    const { signer } = setup();
    const err = await rejection(signer.createSession(sessionInput('  ', { ttlSeconds: 0 })));
    const err2 = await rejection(signer.createSession(sessionInput('  ')));
    for (const e of [err, err2]) {
      expect(e.code).toBe('REJECTED');
      expect(e.message).not.toMatch(/Болд|99112233|УА/);
    }
  });
});

describe('fixture: default (APPROVE)', () => {
  it('approveAfterMs хүртэл PENDING, дараа нь SIGNED (clock-based)', async () => {
    const { signer, advance } = setup({ approveAfterMs: 3000 });
    const { providerRef } = await signer.createSession(sessionInput());

    expect(await signer.getSession(providerRef)).toEqual({ state: 'PENDING' });
    advance(2999);
    expect(await signer.getSession(providerRef)).toEqual({ state: 'PENDING' });
    advance(1);
    expect((await signer.getSession(providerRef)).state).toBe('SIGNED');
  });

  it('гарын үсгийн агуулга: digest тэнцэнэ, гэрчилгээ мock CA-аас, регистр зөв, хугацаа signedAt-ийг хамарна', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    advance(10_000);
    const sig = signed(await signer.getSession(providerRef));

    expect(sig.signedDigestHex).toBe(DIGEST_HEX);
    expect(sig.digestAlgorithm).toBe('SHA-256');
    expect(sig.signedAt).toEqual(new Date(START_MS + 3000)); // poll хийсэн цаг биш, "зээлдэгч баталсан" цаг
    expect(sig.providerTxnId).toMatch(/^[0-9A-F]{16}$/);
    expect(sig.certificate).toMatchObject({ subjectName: FULL_NAME, subjectRegisterNo: DEFAULT_REGISTER, issuer: MOCK_CA_ISSUER });
    expect(sig.certificate.issuer).toBe('LOS MOCK CA (ТЕСТ)');
    expect(sig.certificate.serialNumber).toMatch(/^[0-9A-F]{16}$/);
    expect(sig.certificate.serialNumber).not.toBe(sig.providerTxnId);
    expect(sig.certificate.notBefore.getTime()).toBeLessThan(sig.signedAt.getTime());
    expect(sig.certificate.notAfter.getTime()).toBeGreaterThan(sig.signedAt.getTime());
  });

  it('давтан getSession ижил гарын үсэг буцаана (finalize retry аюулгүй), буцаасан Date-ийг өөрчилсөн ч төлөв эвдрэхгүй', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    advance(5000);
    const first = signed(await signer.getSession(providerRef));
    first.signedAt.setTime(0);
    first.certificate.notAfter.setTime(0);
    advance(60_000);
    const second = signed(await signer.getSession(providerRef));

    expect(second.signedAt).toEqual(new Date(START_MS + 3000));
    expect(second.certificate.notAfter.getTime()).toBeGreaterThan(START_MS);
    expect(second.signatureCms.equals(signed(await signer.getSession(providerRef)).signatureCms)).toBe(true);
  });

  it('CMS нь MOCK-CMS marker + JSON + HMAC; PII агуулахгүй; HMAC зөв', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    advance(3000);
    const sig = signed(await signer.getSession(providerRef));

    const lines = sig.signatureCms.toString('utf8').split('\n');
    expect(lines[0]).toBe(MOCK_CMS_MARKER);
    expect(lines).toHaveLength(3);
    const payload = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(payload).toMatchObject({
      mock: true,
      provider: 'TRIDUM',
      providerRef,
      providerTxnId: sig.providerTxnId,
      signedDigestHex: DIGEST_HEX,
      certificateSerial: sig.certificate.serialNumber,
      signedAt: sig.signedAt.toISOString(),
    });
    expect(String(payload.notice)).toMatch(/NOT A REAL SIGNATURE/);
    expect(lines[2]).toBe(signBody(`${MOCK_CMS_MARKER}\n${lines[1]}`));
    const raw = sig.signatureCms.toString('utf8');
    expect(raw).not.toContain(DEFAULT_REGISTER);
    expect(raw).not.toContain('Болд');
  });

  it('өөр session өөр txn/serial/CMS-тэй', async () => {
    const { signer, advance } = setup({ approveAfterMs: 0 });
    const a = await signer.createSession(sessionInput());
    const b = await signer.createSession(sessionInput());
    advance(1);
    const sa = signed(await signer.getSession(a.providerRef));
    const sb = signed(await signer.getSession(b.providerRef));

    expect(sa.providerTxnId).not.toBe(sb.providerTxnId);
    expect(sa.certificate.serialNumber).not.toBe(sb.certificate.serialNumber);
    expect(sa.signatureCms.equals(sb.signatureCms)).toBe(false);
  });

  it('approveAfterMs=0 бол шууд SIGNED', async () => {
    const { signer } = setup({ approveAfterMs: 0 });
    const { providerRef } = await signer.createSession(sessionInput());
    expect((await signer.getSession(providerRef)).state).toBe('SIGNED');
  });

  it('approveAfterMs нь ttl-ээс их бол үр дүн гарахаас өмнө EXPIRED', async () => {
    const { signer, advance } = setup({ approveAfterMs: 400_000 });
    const { providerRef } = await signer.createSession(sessionInput(DEFAULT_REGISTER, { ttlSeconds: 300 }));
    advance(299_999);
    expect((await signer.getSession(providerRef)).state).toBe('PENDING');
    advance(1);
    expect(await signer.getSession(providerRef)).toEqual({ state: 'EXPIRED' });
    advance(500_000);
    expect(await signer.getSession(providerRef)).toEqual({ state: 'EXPIRED' });
  });
});

describe('fixture-ууд', () => {
  it('00: зээлдэгч татгалзана (approveAfterMs-ийн дараа)', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput('УА12345600'));
    advance(2999);
    expect((await signer.getSession(providerRef)).state).toBe('PENDING');
    advance(1);
    expect(await signer.getSession(providerRef)).toEqual({ state: 'DECLINED' });
  });

  it('55: FAILED(MOCK_PROVIDER_ERROR)', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput('УА12345655'));
    expect((await signer.getSession(providerRef)).state).toBe('PENDING');
    advance(3000);
    expect(await signer.getSession(providerRef)).toEqual({ state: 'FAILED', code: MOCK_FAILURE_CODE, message: expect.any(String) });
    expect(MOCK_FAILURE_CODE).toBe('MOCK_PROVIDER_ERROR');
  });

  it('99: хэзээ ч батлахгүй — ttl хүртэл PENDING, дараа нь EXPIRED', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput('УА12345699', { ttlSeconds: 120 }));
    advance(3000);
    expect((await signer.getSession(providerRef)).state).toBe('PENDING');
    advance(116_999);
    expect((await signer.getSession(providerRef)).state).toBe('PENDING');
    advance(1);
    expect(await signer.getSession(providerRef)).toEqual({ state: 'EXPIRED' });
  });

  it('77: SIGNED боловч гэрчилгээний регистр зөрнө, бусад нь зөв', async () => {
    const { signer, advance } = setup();
    const register = 'УА12345677';
    const { providerRef } = await signer.createSession(sessionInput(register));
    advance(3000);
    const sig = signed(await signer.getSession(providerRef));

    expect(sig.certificate.subjectRegisterNo).not.toBe(register);
    expect(sig.certificate.subjectRegisterNo).toMatch(/^ЯЯ\d{6}00$/);
    expect(sig.signedDigestHex).toBe(DIGEST_HEX);
    expect(sig.certificate.subjectName).toBe(FULL_NAME);
  });

  it('11: SIGNED боловч signedDigestHex баримтын digest-ээс ялгаатай (хүчинтэй SHA-256 hex хэлбэртэй)', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput('УА12345611'));
    advance(3000);
    const sig = signed(await signer.getSession(providerRef));

    expect(sig.signedDigestHex).not.toBe(DIGEST_HEX);
    expect(sig.signedDigestHex).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.certificate.subjectRegisterNo).toBe('УА12345611');
  });
});

describe('approveNow / declineNow (MockSigningControl)', () => {
  it('owns: зөвхөн өөрийн session', async () => {
    const { signer } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    expect(signer.owns(providerRef)).toBe(true);
    expect(signer.owns('TRD-MOCK-unknown')).toBe(false);
    expect(isMockSigningControl(signer)).toBe(true);
    expect(isMockSigningControl({ owns: () => true })).toBe(false);
    expect(isMockSigningControl(null)).toBe(false);
  });

  it('approveNow: хугацаа хүлээлгүй SIGNED, signedAt = одоогийн цаг', async () => {
    const { signer, advance } = setup({ approveAfterMs: 3_600_000 });
    const { providerRef } = await signer.createSession(sessionInput());
    advance(1500);
    expect((await signer.getSession(providerRef)).state).toBe('PENDING');
    signer.approveNow(providerRef);

    expect(signed(await signer.getSession(providerRef)).signedAt).toEqual(new Date(START_MS + 1500));
  });

  it('approveNow нь fixture-ийн төлөвлөсөн үр дүнг давна (99, 00, 55); 77/11-ийн гажиг хэвээр', async () => {
    const { signer } = setup();
    for (const register of ['УА12345699', 'УА12345600', 'УА12345655']) {
      const { providerRef } = await signer.createSession(sessionInput(register));
      signer.approveNow(providerRef);
      expect(signed(await signer.getSession(providerRef)).certificate.subjectRegisterNo).toBe(register);
    }
    const id = await signer.createSession(sessionInput('УА12345677'));
    signer.approveNow(id.providerRef);
    expect(signed(await signer.getSession(id.providerRef)).certificate.subjectRegisterNo).not.toBe('УА12345677');
    const digest = await signer.createSession(sessionInput('УА12345611'));
    signer.approveNow(digest.providerRef);
    expect(signed(await signer.getSession(digest.providerRef)).signedDigestHex).not.toBe(DIGEST_HEX);
  });

  it('approveNow idempotent; батлагдсан session хугацаа дууссан ч SIGNED хэвээр', async () => {
    const { signer, advance } = setup({ approveAfterMs: 3_600_000 });
    const { providerRef } = await signer.createSession(sessionInput());
    signer.approveNow(providerRef);
    advance(1000);
    signer.approveNow(providerRef);
    advance(1_000_000);

    expect(signed(await signer.getSession(providerRef)).signedAt).toEqual(new Date(START_MS));
  });

  it('approveNow: аль хэдийн (fixture-ээр) SIGNED болсон бол no-op, signedAt өөрчлөгдөхгүй', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    advance(5000);
    signer.approveNow(providerRef);
    expect(signed(await signer.getSession(providerRef)).signedAt).toEqual(new Date(START_MS + 3000));
  });

  it('declineNow: PENDING → DECLINED; idempotent; дараа нь approveNow REJECTED', async () => {
    const { signer } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    signer.declineNow(providerRef);
    signer.declineNow(providerRef);

    expect(await signer.getSession(providerRef)).toEqual({ state: 'DECLINED' });
    expect(() => signer.approveNow(providerRef)).toThrowError(expect.objectContaining({ code: 'REJECTED' }));
  });

  it('SIGNED болсон session дээр declineNow REJECTED, төлөв өөрчлөгдөхгүй', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    advance(3000);
    expect(() => signer.declineNow(providerRef)).toThrowError(expect.objectContaining({ code: 'REJECTED' }));
    expect((await signer.getSession(providerRef)).state).toBe('SIGNED');
  });

  it.each([
    ['хугацаа дууссан', async (s: ReturnType<typeof setup>, ref: string) => { s.advance(301_000); return ref; }],
    ['цуцлагдсан', async (s: ReturnType<typeof setup>, ref: string) => { await s.signer.cancelSession(ref); return ref; }],
  ])('%s session дээр approveNow/declineNow → REJECTED', async (_title, prepare) => {
    const ctx = setup({ approveAfterMs: 3_600_000 });
    const { providerRef } = await ctx.signer.createSession(sessionInput());
    await prepare(ctx, providerRef);

    expect(() => ctx.signer.approveNow(providerRef)).toThrowError(expect.objectContaining({ code: 'REJECTED' }));
    expect(() => ctx.signer.declineNow(providerRef)).toThrowError(expect.objectContaining({ code: 'REJECTED' }));
  });

  it('fixture-ээр DECLINED/FAILED болсон session дээр approveNow REJECTED (өнгөрсөн үр дүнг өөрчилдөггүй)', async () => {
    const { signer, advance } = setup();
    const declined = await signer.createSession(sessionInput('УА12345600'));
    const failed = await signer.createSession(sessionInput('УА12345655'));
    advance(3000);

    expect(() => signer.approveNow(declined.providerRef)).toThrowError(expect.objectContaining({ code: 'REJECTED' }));
    expect(() => signer.approveNow(failed.providerRef)).toThrowError(expect.objectContaining({ code: 'REJECTED' }));
  });

  it('үл мэдэгдэх ref → UNKNOWN_SESSION', () => {
    const { signer } = setup();
    expect(() => signer.approveNow('TRD-MOCK-nope')).toThrowError(expect.objectContaining({ code: 'UNKNOWN_SESSION' }));
    expect(() => signer.declineNow('TRD-MOCK-nope')).toThrowError(expect.objectContaining({ code: 'UNKNOWN_SESSION' }));
  });
});

describe('cancelSession', () => {
  it('PENDING session-ийг цуцална → EXPIRED (дахин гарын үсэг зурагдахгүй)', async () => {
    const { signer, advance } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    await signer.cancelSession(providerRef);
    advance(10_000);

    expect(await signer.getSession(providerRef)).toEqual({ state: 'EXPIRED' });
  });

  it('idempotent: давтан дуудахад алдаагүй, төлөв ижил', async () => {
    const { signer } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    await signer.cancelSession(providerRef);
    await expect(signer.cancelSession(providerRef)).resolves.toBeUndefined();
    expect(await signer.getSession(providerRef)).toEqual({ state: 'EXPIRED' });
  });

  it('аль хэдийн SIGNED / DECLINED / EXPIRED session-ийг өөрчилдөггүй', async () => {
    const { signer, advance } = setup();
    const ok = await signer.createSession(sessionInput());
    const declined = await signer.createSession(sessionInput('УА12345600'));
    const never = await signer.createSession(sessionInput('УА12345699', { ttlSeconds: 10 }));
    advance(10_000);
    const before = signed(await signer.getSession(ok.providerRef));
    for (const ref of [ok.providerRef, declined.providerRef, never.providerRef]) await signer.cancelSession(ref);

    expect(signed(await signer.getSession(ok.providerRef)).signatureCms.equals(before.signatureCms)).toBe(true);
    expect((await signer.getSession(declined.providerRef)).state).toBe('DECLINED');
    expect((await signer.getSession(never.providerRef)).state).toBe('EXPIRED');
  });

  it('үл мэдэгдэх ref дээр алдаа шидэхгүй (dev процесс дахин ачаалагдсаны дараах цуцлалт)', async () => {
    const { signer } = setup();
    await expect(signer.cancelSession('TRD-MOCK-gone')).resolves.toBeUndefined();
  });
});

describe('getSession', () => {
  it('үл мэдэгдэх ref → UNKNOWN_SESSION (retryable биш, ref-ийг мессежид давтахгүй)', async () => {
    const { signer } = setup();
    const err = await rejection(signer.getSession('TRD-MOCK-secret-looking-ref'));
    expect(err.code).toBe('UNKNOWN_SESSION');
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('secret-looking-ref');
  });
});

describe('session retention', () => {
  it('ttl + 24 цагаас хуучин session-ийг шинэ session үүсгэх үед санах ойгоос цэвэрлэнэ', async () => {
    const { signer, advance } = setup();
    const old = await signer.createSession(sessionInput(DEFAULT_REGISTER, { ttlSeconds: 60 }));
    advance(60_000 + 24 * 3_600_000);
    await signer.createSession(sessionInput());
    expect(signer.owns(old.providerRef)).toBe(true); // яг хязгаарт — хараахан цэвэрлэгдээгүй

    advance(1);
    const fresh = await signer.createSession(sessionInput());
    expect(signer.owns(old.providerRef)).toBe(false);
    expect(signer.owns(fresh.providerRef)).toBe(true);
    expect((await rejection(signer.getSession(old.providerRef))).code).toBe('UNKNOWN_SESSION');
  });
});

describe('parseWebhook', () => {
  const REF = 'TRD-MOCK-3f1f9a52-0c43-4f6e-9a55-6b1c8e4c1d10';
  const body = (providerRef = REF): Buffer => Buffer.from(JSON.stringify({ providerRef }));
  const call = (headers: Record<string, string | undefined>, rawBody: Buffer) => setup().signer.parseWebhook({ headers, rawBody });
  const invalid = (fn: () => unknown) => expect(fn).toThrowError(expect.objectContaining({ name: 'ESignProviderError', code: 'INVALID_WEBHOOK', retryable: false }));

  it('зөв HMAC-тай webhook → providerRef', () => {
    const raw = body();
    expect(call({ [MOCK_WEBHOOK_SIGNATURE_HEADER]: signBody(raw) }, raw)).toEqual({ providerRef: REF });
  });

  it('толгойн нэр том/жижиг үсэгт мэдрэмтгий биш; hex том үсэг зөвшөөрнө', () => {
    const raw = body();
    expect(call({ 'X-Mock-Signature': signBody(raw).toUpperCase() }, raw)).toEqual({ providerRef: REF });
  });

  it('гарын үсэг байхгүй / хоосон / hex биш / урт буруу → INVALID_WEBHOOK', () => {
    const raw = body();
    invalid(() => call({}, raw));
    invalid(() => call({ 'x-mock-signature': undefined }, raw));
    invalid(() => call({ 'x-mock-signature': '' }, raw));
    invalid(() => call({ 'x-mock-signature': 'not-hex' }, raw));
    invalid(() => call({ 'x-mock-signature': signBody(raw).slice(0, 62) }, raw));
    invalid(() => call({ 'x-mock-signature': `${signBody(raw)}00` }, raw));
  });

  it('буруу нууцаар гарын үсэглэсэн → INVALID_WEBHOOK', () => {
    const raw = body();
    invalid(() => call({ 'x-mock-signature': signBody(raw, 'another-secret-another-secret') }, raw));
  });

  it('body өөрчлөгдсөн (tampered) → INVALID_WEBHOOK', () => {
    const signedBody = body();
    const tampered = body('TRD-MOCK-00000000-0000-4000-8000-000000000000');
    invalid(() => call({ 'x-mock-signature': signBody(signedBody) }, tampered));
    invalid(() => call({ 'x-mock-signature': signBody(signedBody) }, Buffer.concat([signedBody, Buffer.from(' ')])));
  });

  it('гарын үсэг зөв ч body JSON биш / providerRef байхгүй / төрөл буруу → INVALID_WEBHOOK', () => {
    for (const text of ['not json', '{}', '{"providerRef":""}', '{"providerRef":42}', '[]', 'null']) {
      const raw = Buffer.from(text);
      invalid(() => call({ 'x-mock-signature': signBody(raw) }, raw));
    }
  });

  it('өөр provider-ийн ref (MPS-MOCK-) Tridum-ийн webhook-оор орж болохгүй', () => {
    const raw = body('MPS-MOCK-3f1f9a52-0c43-4f6e-9a55-6b1c8e4c1d10');
    invalid(() => call({ 'x-mock-signature': signBody(raw) }, raw));
  });

  it('webhook нь session-ийн төлөвийг өөрчлөхгүй (зөвхөн ref буцаана)', async () => {
    const { signer } = setup();
    const { providerRef } = await signer.createSession(sessionInput());
    const raw = body(providerRef);
    expect(signer.parseWebhook({ headers: { 'x-mock-signature': signBody(raw) }, rawBody: raw })).toEqual({ providerRef });
    expect((await signer.getSession(providerRef)).state).toBe('PENDING');
  });
});
