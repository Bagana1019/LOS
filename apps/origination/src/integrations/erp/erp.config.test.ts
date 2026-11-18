import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErpGateway, parseErpEnv } from './erp.config';
import { MockErpClient } from './mock.client';
import { RealErpClient } from './real.client';

const SECRET = 'whsec_0123456789abcdef-0123456789';
const TOKEN = 'tok_live_Zk39sdf8723hsd9fHJ';
const REAL = { INTEGRATION_MODE: 'real', ERP_API_URL: 'https://erp.example.com/api/journals', ERP_WEBHOOK_SECRET: SECRET };

function messageOf(fn: () => unknown): string {
  try { fn(); } catch (e) { return (e as Error).message; }
  throw new Error('expected a throw');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseErpEnv', () => {
  it('defaults to mock mode, a 15s timeout and secure transport when nothing is configured', () => {
    expect(parseErpEnv({})).toEqual({ INTEGRATION_MODE: 'mock', ERP_TIMEOUT_MS: 15_000, ERP_ALLOW_INSECURE: 'false', ERP_REQUIRE_ACK: 'true' });
  });

  it('parses a complete real-mode configuration and coerces the timeout to a number', () => {
    expect(parseErpEnv({
      INTEGRATION_MODE: 'real', ERP_API_URL: 'https://erp.example.com/hook', ERP_API_TOKEN: TOKEN,
      ERP_WEBHOOK_SECRET: SECRET, ERP_TIMEOUT_MS: '30000', ERP_ALLOW_INSECURE: 'true',
    })).toEqual({
      INTEGRATION_MODE: 'real', ERP_API_URL: 'https://erp.example.com/hook', ERP_API_TOKEN: TOKEN,
      ERP_WEBHOOK_SECRET: SECRET, ERP_TIMEOUT_MS: 30_000, ERP_ALLOW_INSECURE: 'true', ERP_REQUIRE_ACK: 'true',
    });
  });

  it('ignores unrelated environment variables and does not carry them into the result', () => {
    const env = parseErpEnv({ PATH: '/usr/bin', DATABASE_URL: 'postgres://user:pw@db/x', ERP_RELAY_ENABLED: 'false', ERP_MAX_ATTEMPTS: '3' });
    expect(Object.keys(env).sort()).toEqual(['ERP_ALLOW_INSECURE', 'ERP_REQUIRE_ACK', 'ERP_TIMEOUT_MS', 'INTEGRATION_MODE']);
  });

  it('requires INTEGRATION_MODE to be set explicitly in production', () => {
    expect(() => parseErpEnv({ NODE_ENV: 'production' })).toThrow(/INTEGRATION_MODE must be set explicitly/);
    expect(parseErpEnv({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock' }).INTEGRATION_MODE).toBe('mock');
  });

  it('parses ERP_REQUIRE_ACK', () => {
    expect(parseErpEnv({ ERP_REQUIRE_ACK: 'false' }).ERP_REQUIRE_ACK).toBe('false');
    expect(() => parseErpEnv({ ERP_REQUIRE_ACK: 'no' })).toThrow(/ERP_REQUIRE_ACK/);
  });

  it('treats variables that are present but undefined as unset', () => {
    const env = parseErpEnv({ INTEGRATION_MODE: undefined, ERP_API_URL: undefined, ERP_TIMEOUT_MS: undefined });
    expect(env.INTEGRATION_MODE).toBe('mock');
    expect(env.ERP_API_URL).toBeUndefined();
    expect(env.ERP_TIMEOUT_MS).toBe(15_000);
  });

  it.each([['mock'], ['real']])('accepts INTEGRATION_MODE=%s', (mode) => {
    expect(parseErpEnv({ INTEGRATION_MODE: mode }).INTEGRATION_MODE).toBe(mode);
  });

  it.each([['prod'], ['REAL'], ['Mock'], ['mock '], ['true']])('rejects INTEGRATION_MODE=%j', (mode) => {
    expect(() => parseErpEnv({ INTEGRATION_MODE: mode })).toThrow(/invalid ERP integration config: INTEGRATION_MODE/);
  });

  describe('ERP_TIMEOUT_MS', () => {
    it.each([['1000', 1_000], ['15000', 15_000], ['60000', 60_000]])('accepts %s', (raw, expected) => {
      expect(parseErpEnv({ ERP_TIMEOUT_MS: raw }).ERP_TIMEOUT_MS).toBe(expected);
    });

    it.each([['999'], ['0'], ['-1'], ['60001'], ['1500.5'], ['abc'], ['NaN']])('rejects %s', (raw) => {
      expect(() => parseErpEnv({ ERP_TIMEOUT_MS: raw })).toThrow(/ERP_TIMEOUT_MS/);
    });
  });

  describe('ERP_WEBHOOK_SECRET', () => {
    it('accepts a secret of exactly 16 characters', () => {
      expect(parseErpEnv({ ERP_WEBHOOK_SECRET: 'a'.repeat(16) }).ERP_WEBHOOK_SECRET).toBe('a'.repeat(16));
    });

    it('rejects a secret shorter than 16 characters without echoing it', () => {
      const short = 'tooshort-012345'; // 15 chars
      expect(short).toHaveLength(15);
      const msg = messageOf(() => parseErpEnv({ ERP_WEBHOOK_SECRET: short }));
      expect(msg).toContain('ERP_WEBHOOK_SECRET');
      expect(msg).not.toContain(short);
    });
  });

  describe('ERP_API_URL, ERP_API_TOKEN and ERP_ALLOW_INSECURE', () => {
    it('rejects a value that is not a URL without echoing it', () => {
      const bogus = 'not a url, but contains pw-S3CRET';
      const msg = messageOf(() => parseErpEnv({ ERP_API_URL: bogus }));
      expect(msg).toContain('ERP_API_URL');
      expect(msg).not.toContain('pw-S3CRET');
    });

    it('treats an empty token as not configured (the token is optional)', () => {
      expect(parseErpEnv({ ERP_API_TOKEN: '' }).ERP_API_TOKEN).toBeUndefined();
    });

    it.each([['true'], ['false']])('accepts ERP_ALLOW_INSECURE=%s', (v) => {
      expect(parseErpEnv({ ERP_ALLOW_INSECURE: v }).ERP_ALLOW_INSECURE).toBe(v);
    });

    it.each([['1'], ['yes'], ['TRUE'], ['false ']])('rejects ERP_ALLOW_INSECURE=%j', (v) => {
      expect(() => parseErpEnv({ ERP_ALLOW_INSECURE: v })).toThrow(/ERP_ALLOW_INSECURE/);
    });
  });

  it('lists every offending variable name, and only names, in the error', () => {
    const msg = messageOf(() => parseErpEnv({
      INTEGRATION_MODE: 'staging', ERP_API_URL: 'nonsense-url', ERP_WEBHOOK_SECRET: 'short-s3cr3t',
      ERP_TIMEOUT_MS: '5', ERP_ALLOW_INSECURE: 'maybe',
    }));
    expect(msg.startsWith('invalid ERP integration config: ')).toBe(true);
    for (const name of ['INTEGRATION_MODE', 'ERP_API_URL', 'ERP_WEBHOOK_SECRET', 'ERP_TIMEOUT_MS', 'ERP_ALLOW_INSECURE']) {
      expect(msg).toContain(name);
    }
    for (const value of ['staging', 'nonsense-url', 'short-s3cr3t', 'maybe']) expect(msg).not.toContain(value);
  });
});

// H6: .env.example ships `ERP_API_URL=`, `ERP_WEBHOOK_SECRET=`, `ERP_API_TOKEN=` (empty); an empty value means "not configured".
describe('parseErpEnv with empty / whitespace-only values (H6)', () => {
  const DEFAULTS = { INTEGRATION_MODE: 'mock', ERP_TIMEOUT_MS: 15_000, ERP_ALLOW_INSECURE: 'false', ERP_REQUIRE_ACK: 'true' };

  it.each([[''], ['   '], ['\t']])('treats every ERP variable set to %j as unset and applies the defaults', (blank) => {
    const env = parseErpEnv({
      INTEGRATION_MODE: blank, ERP_API_URL: blank, ERP_API_TOKEN: blank, ERP_WEBHOOK_SECRET: blank,
      ERP_TIMEOUT_MS: blank, ERP_ALLOW_INSECURE: blank, ERP_REQUIRE_ACK: blank,
    });
    expect(env).toEqual(DEFAULTS);
    expect(env.ERP_API_URL).toBeUndefined();
    expect(env.ERP_WEBHOOK_SECRET).toBeUndefined();
    expect(env.ERP_API_TOKEN).toBeUndefined();
  });

  it.each(['ERP_API_URL', 'ERP_API_TOKEN', 'ERP_WEBHOOK_SECRET', 'ERP_TIMEOUT_MS', 'ERP_ALLOW_INSECURE', 'ERP_REQUIRE_ACK'])('does not crash when only %s is empty', (key) => {
    expect(() => parseErpEnv({ [key]: '' })).not.toThrow();
  });

  it('boots with the ERP block of the repository .env.example exactly as shipped', () => {
    const lines = readFileSync(resolve(__dirname, '../../../../../.env.example'), 'utf8').split(/\r?\n/);
    const example: Record<string, string> = {};
    for (const line of lines) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) example[m[1]] = m[2];
    }
    // The file really does ship the empty values this test is about.
    expect(example).toMatchObject({ ERP_API_URL: '', ERP_WEBHOOK_SECRET: '', ERP_API_TOKEN: '' });
    expect(() => parseErpEnv(example)).not.toThrow();
    expect(() => parseErpEnv({ ...example, NODE_ENV: 'production' })).not.toThrow(); // the example sets INTEGRATION_MODE explicitly
    expect(createErpGateway(parseErpEnv(example))).toBeInstanceOf(MockErpClient);
  });

  it('a blank value is not a real one: real mode still refuses to start without URL and secret', () => {
    const msg = messageOf(() => createErpGateway(parseErpEnv({ INTEGRATION_MODE: 'real', ERP_API_URL: '', ERP_WEBHOOK_SECRET: '  ', ERP_API_TOKEN: '' })));
    expect(msg).toBe('INTEGRATION_MODE=real requires ERP_API_URL and ERP_WEBHOOK_SECRET');
  });

  it('a blank optional value does not hide a real one next to it', () => {
    const gw = createErpGateway(parseErpEnv({ ...REAL, ERP_API_TOKEN: '', ERP_TIMEOUT_MS: '' }));
    expect(gw).toBeInstanceOf(RealErpClient);
  });

  it('keeps rejecting values that are present but invalid, without echoing them', () => {
    const msg = messageOf(() => parseErpEnv({ ERP_API_URL: '', ERP_WEBHOOK_SECRET: 'short-s3cr3t', ERP_TIMEOUT_MS: '' }));
    expect(msg).toContain('ERP_WEBHOOK_SECRET');
    expect(msg).not.toContain('ERP_API_URL');
    expect(msg).not.toContain('ERP_TIMEOUT_MS');
    expect(msg).not.toContain('short-s3cr3t');
  });

  describe('production (INTEGRATION_MODE must still be explicit)', () => {
    it.each([[''], ['   ']])('treats a blank INTEGRATION_MODE=%j as not set and refuses to start', (blank) => {
      expect(() => parseErpEnv({ NODE_ENV: 'production', INTEGRATION_MODE: blank })).toThrow(/INTEGRATION_MODE must be set explicitly/);
    });

    it.each([['Production'], [' production ']])('recognises NODE_ENV=%j as production (fail closed)', (nodeEnv) => {
      expect(() => parseErpEnv({ NODE_ENV: nodeEnv })).toThrow(/INTEGRATION_MODE must be set explicitly/);
    });

    it('does not treat a blank NODE_ENV as production', () => {
      expect(parseErpEnv({ NODE_ENV: '' }).INTEGRATION_MODE).toBe('mock');
    });
  });
});

describe('createErpGateway', () => {
  describe('mock mode', () => {
    it('returns the deterministic MockErpClient by default', () => {
      const gw = createErpGateway(parseErpEnv({}));
      expect(gw).toBeInstanceOf(MockErpClient);
      expect(gw.name).toBe('mock');
    });

    it('ignores real-mode settings (even a complete set) when INTEGRATION_MODE=mock', () => {
      const gw = createErpGateway(parseErpEnv({ INTEGRATION_MODE: 'mock', ERP_API_URL: 'https://erp.example.com/hook', ERP_WEBHOOK_SECRET: SECRET, ERP_API_TOKEN: TOKEN }));
      expect(gw).toBeInstanceOf(MockErpClient);
    });

    it('returns a new, independent mock on every call', () => {
      const env = parseErpEnv({});
      expect(createErpGateway(env)).not.toBe(createErpGateway(env));
    });
  });

  describe('real mode', () => {
    it('returns the webhook RealErpClient when URL and secret are configured', () => {
      const gw = createErpGateway(parseErpEnv(REAL));
      expect(gw).toBeInstanceOf(RealErpClient);
      expect(gw.name).toBe('webhook');
    });

    it('does not require a bearer token', () => {
      expect(() => createErpGateway(parseErpEnv(REAL))).not.toThrow();
    });

    it.each([
      ['both URL and secret are missing', { INTEGRATION_MODE: 'real' }],
      ['the URL is missing', { INTEGRATION_MODE: 'real', ERP_WEBHOOK_SECRET: SECRET, ERP_API_TOKEN: TOKEN }],
      ['the secret is missing', { INTEGRATION_MODE: 'real', ERP_API_URL: 'https://erp.example.com/hook', ERP_API_TOKEN: TOKEN }],
    ])('refuses to start when %s', (_label, raw) => {
      const msg = messageOf(() => createErpGateway(parseErpEnv(raw)));
      expect(msg).toBe('INTEGRATION_MODE=real requires ERP_API_URL and ERP_WEBHOOK_SECRET');
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain(TOKEN);
    });

    it('rejects a secret shorter than 16 characters at parse time without echoing it', () => {
      const short = 'tooshort-012345';
      const msg = messageOf(() => createErpGateway(parseErpEnv({ ...REAL, ERP_WEBHOOK_SECRET: short })));
      expect(msg).toContain('ERP_WEBHOOK_SECRET');
      expect(msg).not.toContain(short);
    });

    it('requires https for non-local hosts unless ERP_ALLOW_INSECURE=true', () => {
      const plain = { ...REAL, ERP_API_URL: 'http://erp.example.com/api/journals' };
      expect(() => createErpGateway(parseErpEnv(plain))).toThrow(/must be https/);
      expect(() => createErpGateway(parseErpEnv({ ...plain, ERP_ALLOW_INSECURE: 'false' }))).toThrow(/must be https/);
      expect(createErpGateway(parseErpEnv({ ...plain, ERP_ALLOW_INSECURE: 'true' }))).toBeInstanceOf(RealErpClient);
    });

    it.each([['http://localhost:4010/hook'], ['http://127.0.0.1:4010/hook'], ['http://[::1]:4010/hook']])('allows plain http to the loopback address %s', (url) => {
      expect(createErpGateway(parseErpEnv({ ...REAL, ERP_API_URL: url }))).toBeInstanceOf(RealErpClient);
    });

    it('does not echo the secret, token or URL credentials in a transport error', () => {
      const env = parseErpEnv({ ...REAL, ERP_API_URL: 'http://svc:pw-S3CRET@erp.example.com/hook', ERP_API_TOKEN: TOKEN });
      const msg = messageOf(() => createErpGateway(env));
      expect(msg).toMatch(/must not contain credentials/);
      for (const leaked of [SECRET, TOKEN, 'pw-S3CRET']) expect(msg).not.toContain(leaked);
    });

    it('rejects plain http to a remote host without echoing the secret or token', () => {
      const env = parseErpEnv({ ...REAL, ERP_API_URL: 'http://erp.example.com/hook', ERP_API_TOKEN: TOKEN });
      const msg = messageOf(() => createErpGateway(env));
      expect(msg).toMatch(/must be https/);
      for (const leaked of [SECRET, TOKEN]) expect(msg).not.toContain(leaked);
    });

    describe('wiring of the configured values into the client', () => {
      const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ reference: 'GL-1' }), { status: 200 }));
      const ctx = { correlationId: 'corr-1', attemptNo: 1 };
      const payload = {
        schemaVersion: 1, eventId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'o:DISBURSEMENT:req-1', eventType: 'DISBURSEMENT',
        orgId: 'o', branchId: null, applicationId: 'a', contractNo: null, coreLoanId: null, customerId: null,
        businessDate: '2026-10-28', currency: 'MNT', data: { amount: '1.00' }, correlationId: 'corr-1', createdAt: '2026-10-28T00:00:00.000Z',
      } as const;

      it('posts to ERP_API_URL with the bearer token and a signature made with ERP_WEBHOOK_SECRET', async () => {
        const fetchSpy = okFetch();
        vi.stubGlobal('fetch', fetchSpy);
        const gw = createErpGateway(parseErpEnv({ ...REAL, ERP_API_TOKEN: TOKEN }));
        expect(await gw.post({ ...payload, data: { ...payload.data } }, ctx)).toEqual({ externalRef: 'GL-1', duplicate: false });

        const [input, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit & { headers: Record<string, string> }];
        expect(String(input)).toBe('https://erp.example.com/api/journals');
        expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
        const { createHmac } = await import('node:crypto');
        const expected = createHmac('sha256', SECRET).update(`${init.headers['x-los-timestamp']}.${String(init.body)}`).digest('hex');
        expect(init.headers['x-los-signature']).toBe(`sha256=${expected}`);
      });

      it('omits the Authorization header when no token is configured', async () => {
        const fetchSpy = okFetch();
        vi.stubGlobal('fetch', fetchSpy);
        await createErpGateway(parseErpEnv(REAL)).post({ ...payload, data: { ...payload.data } }, ctx);
        const [, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit & { headers: Record<string, string> }];
        expect(init.headers.authorization).toBeUndefined();
      });

      it.each([[undefined, 15_000], ['2500', 2_500], ['60000', 60_000]])('uses ERP_TIMEOUT_MS=%s (%i ms) as the request timeout', async (raw, expectedMs) => {
        vi.stubGlobal('fetch', okFetch());
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
        const gw = createErpGateway(parseErpEnv({ ...REAL, ...(raw ? { ERP_TIMEOUT_MS: raw } : {}) }));
        await gw.post({ ...payload, data: { ...payload.data } }, ctx);
        expect(timeoutSpy).toHaveBeenCalledWith(expectedMs);
      });
    });
  });
});
