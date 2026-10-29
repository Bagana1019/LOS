import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BadGatewayException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSigningRequest, SigningRequestView } from '@los/contracts';
import { UpstreamError } from '@los/nest-common';
import { context, silenceLogs } from './contract-signing.fixtures';
import { createDmsEsignGateway, DMS_TIMEOUT_MS } from './http-dms-esign.gateway';

silenceLogs();

const CTX = context('OFFICER', { correlationId: 'corr-9' });
const SECRET_URL = 'https://sign.example.test/sign/SECRET-TOKEN-123';

// orgId body-д байхгүй — dms байгууллагыг X-Org-Id толгойгоос авна
const REQUEST: CreateSigningRequest = {
  applicationId: 'app-1', contractId: 'c-1', contractNo: 'B1', sourceFileId: 'f-1',
  signer: { customerId: 'cu-1', fullName: 'Бат-Эрдэнэ Болд', registerNo: 'УА12345678', phone: '99112233' },
};

const VIEW: SigningRequestView = {
  id: 'sr-1', orgId: 'org-1', applicationId: 'app-1', contractId: 'c-1', contractNo: 'B1', status: 'PENDING', provider: null, providerMock: false, signerCustomerId: 'cu-1',
  signerNameMasked: 'Б. Болд', signerPhoneMasked: '+976 ****2233', linkExpiresAt: '2026-10-31T09:00:00.000Z', signedAt: null, signedFileId: null,
  signatureFileId: null, verificationCode: null, failureReason: null, createdAt: '2026-10-28T09:00:00.000Z',
};

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

let server: Server;
let seen: Seen[];
let handler: Handler;
let baseUrl: string;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => json(res, 200, VIEW);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const gateway = (timeoutMs = 1_000) => createDmsEsignGateway({ DMS_URL: baseUrl }, timeoutMs);

describe('HttpDmsEsignGateway: хүсэлт', () => {
  it('createRequest: POST /api/esign/requests, JSON body (orgId-гүй), контекстын толгойг дамжуулна', async () => {
    handler = (_req, res) => json(res, 201, { ...VIEW, signingUrl: SECRET_URL });
    const result = await gateway().createRequest(REQUEST, CTX);

    expect(result).toMatchObject({ id: 'sr-1', status: 'PENDING', signingUrl: SECRET_URL });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/esign/requests' });
    expect(seen[0]!.headers).toMatchObject({
      'content-type': 'application/json', accept: 'application/json', 'x-user-id': 'officer-1', 'x-roles': 'OFFICER', 'x-org-id': 'org-1', 'x-branch-id': 'branch-1', 'x-correlation-id': 'corr-9',
    });
    expect(JSON.parse(seen[0]!.body)).toEqual(REQUEST);
  });

  it('resend / cancel / get: зөв зам, method; id-г URL-д кодолно', async () => {
    handler = (_req, res) => json(res, 200, { ...VIEW, signingUrl: SECRET_URL });
    await gateway().resend('sr-1', CTX);
    handler = (_req, res) => json(res, 200, { ...VIEW, status: 'CANCELLED', failureReason: 'CANCELLED' });
    const cancelled = await gateway().cancel('sr-1', CTX);
    handler = (_req, res) => json(res, 200, VIEW);
    await gateway().get('weird/id?x=1', CTX);

    expect(cancelled.status).toBe('CANCELLED');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /api/esign/requests/sr-1/resend',
      'POST /api/esign/requests/sr-1/cancel',
      'GET /api/esign/requests/weird%2Fid%3Fx%3D1',
    ]);
    expect(seen[2]!.headers['content-type']).toBeUndefined(); // GET-д body байхгүй
    expect(seen[2]!.headers['x-org-id']).toBe('org-1');
  });

  it('INTERNAL_AUTH_SECRET тохируулсан бол X-Internal-Token дамжуулна', async () => {
    await createDmsEsignGateway({ DMS_URL: baseUrl, INTERNAL_AUTH_SECRET: 's3cret-internal' }).get('sr-1', CTX);
    expect(seen[0]!.headers['x-internal-token']).toBe('s3cret-internal');
  });

  it('GET-ийг нэг удаа л дуудна (5xx дээр дахин оролдсон ч POST дахин оролдохгүй)', async () => {
    handler = (_req, res) => json(res, 500, { message: 'boom' });
    await expect(gateway().createRequest(REQUEST, CTX)).rejects.toBeInstanceOf(UpstreamError);
    expect(seen).toHaveLength(1);
  });

  it('timeout анхдагч нь 3с (CLAUDE.md §3.1)', () => {
    expect(DMS_TIMEOUT_MS).toBe(3_000);
  });
});

describe('HttpDmsEsignGateway: алдааны хөрвүүлэлт', () => {
  it('404 → NotFoundException', async () => {
    handler = (_req, res) => json(res, 404, { code: 'NOT_FOUND', message: 'nope' });
    await expect(gateway().get('sr-x', CTX)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409 → ConflictException', async () => {
    handler = (_req, res) => json(res, 409, { code: 'CONFLICT', message: 'active exists' });
    await expect(gateway().createRequest(REQUEST, CTX)).rejects.toBeInstanceOf(ConflictException);
    await expect(gateway().resend('sr-1', CTX)).rejects.toBeInstanceOf(ConflictException);
    await expect(gateway().cancel('sr-1', CTX)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([400, 401, 403, 413, 422])('%i → BadGatewayException (dms-ийн дотоод алдаа/мессеж ажилтанд дамжихгүй)', async (status) => {
    handler = (_req, res) => json(res, status, { code: 'X', message: 'dms internal detail' });
    const err = await gateway().get('sr-1', CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify((err as BadGatewayException).getResponse())).not.toContain('dms internal detail');
  });

  it.each([500, 502, 503])('%i → UpstreamError (502)', async (status) => {
    handler = (_req, res) => json(res, status, { message: 'whatever' });
    const err = await gateway().get('sr-1', CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).getStatus()).toBe(502);
  });

  it('timeout: хариу өгөхгүй сервер → 504 UPSTREAM_TIMEOUT (хугацаандаа)', async () => {
    handler = () => undefined; // хэзээ ч хариулахгүй
    const started = Date.now();
    const err = await gateway(150).createRequest(REQUEST, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).getStatus()).toBe(504);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('холбогдох боломжгүй (connection refused) → 502', async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const err = await createDmsEsignGateway({ DMS_URL: `http://127.0.0.1:${port}` }, 1_000).get('sr-1', CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).getStatus()).toBe(502);
  });

  it('redirect дагахгүй (толгой/нууц өөр хост руу алдагдахаас сэргийлнэ)', async () => {
    const other = createServer((_req, res) => json(res, 200, VIEW));
    const hit = vi.fn();
    other.on('request', hit);
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal` });
      res.end();
    };
    try {
      await expect(gateway().get('sr-1', CTX)).rejects.toBeInstanceOf(UpstreamError);
      expect(hit).not.toHaveBeenCalled();
    } finally {
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});

describe('HttpDmsEsignGateway: хариуны шалгалт', () => {
  it('JSON биш body → BadGatewayException', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>oops</html>');
    };
    await expect(gateway().get('sr-1', CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('schema-д нийцэхгүй body (status буруу, талбар дутуу) → BadGatewayException (400 VALIDATION биш)', async () => {
    handler = (_req, res) => json(res, 200, { ...VIEW, status: 'WHATEVER' });
    await expect(gateway().get('sr-1', CTX)).rejects.toBeInstanceOf(BadGatewayException);
    handler = (_req, res) => json(res, 200, { id: 'sr-1' });
    await expect(gateway().cancel('sr-1', CTX)).rejects.toBeInstanceOf(BadGatewayException);
    handler = (_req, res) => json(res, 200, null);
    await expect(gateway().get('sr-1', CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('create/resend хариунд signingUrl байхгүй эсвэл URL биш бол BadGatewayException', async () => {
    handler = (_req, res) => json(res, 201, VIEW);
    await expect(gateway().createRequest(REQUEST, CTX)).rejects.toBeInstanceOf(BadGatewayException);
    handler = (_req, res) => json(res, 200, { ...VIEW, signingUrl: 'not-a-url' });
    await expect(gateway().resend('sr-1', CTX)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('get-ийн хариу signingUrl-тай ирсэн ч алдаа биш (service strip хийнэ)', async () => {
    handler = (_req, res) => json(res, 200, { ...VIEW, signingUrl: SECRET_URL });
    await expect(gateway().get('sr-1', CTX)).resolves.toMatchObject({ id: 'sr-1' });
  });

  it('body-г хэзээ ч логлохгүй: алдааны замууд ба хүсэлт/хариуны нууц лог/exception-д гарахгүй', async () => {
    const out: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void out.push(JSON.stringify(args)));
    }
    const leaky = { message: `register УА12345678 phone 99112233 url ${SECRET_URL}`, signingUrl: SECRET_URL };
    const errors: unknown[] = [];

    for (const status of [404, 409, 422, 500]) {
      handler = (_req, res) => json(res, status, leaky);
      errors.push(await gateway().createRequest(REQUEST, CTX).catch((e: unknown) => e));
    }
    handler = (_req, res) => json(res, 200, { ...leaky, status: 'BOGUS' }); // schema алдаа
    errors.push(await gateway().createRequest(REQUEST, CTX).catch((e: unknown) => e));
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(`not json ${SECRET_URL}`);
    };
    errors.push(await gateway().createRequest(REQUEST, CTX).catch((e: unknown) => e));

    expect(out.length).toBeGreaterThan(0); // алдаа бүр логлогдсон (зөвхөн body-гүй)
    // Клиентэд очих хариу (exception body) ба лог хоёрт нууц байхгүй. `upstreamBody` нь filter-ээр гарахгүй (зөвхөн code/message/details).
    const bodies = errors.map((e) => { const r = (e as { getResponse?: () => unknown }).getResponse?.(); return r ?? String(e); });
    const everything = out.join('\n') + JSON.stringify(bodies);
    for (const secret of ['УА12345678', '99112233', 'SECRET-TOKEN', 'sign.example.test']) expect(everything).not.toContain(secret);
    expect(out.join('\n')).toContain('corr-9');
  });
});
