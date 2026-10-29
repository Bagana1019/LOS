import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentView, type CreateDocumentRequest, type RequestContext } from '@los/contracts';
import { DomainError, UpstreamError } from '@los/nest-common';
import { DMS_OCR_TIMEOUT_MS, DMS_TIMEOUT_MS, createDmsDocuments } from './http-dms-documents.port';

Logger.overrideLogger(false);

const CTX: RequestContext = { userId: 'officer-1', roles: ['OFFICER'], branchId: 'branch-1', orgId: 'org-1', customerId: null, correlationId: 'corr-9' };
const APP = '33333333-3333-4333-8333-333333333333';
const FILE = '22222222-2222-4222-8222-222222222222';
const REQUEST: CreateDocumentRequest = { applicationId: APP, type: 'id_card', relatedEntity: 'APPLICATION', fileId: FILE, checklistKey: 'id_card', note: 'Бат-Эрдэнийн үнэмлэх' };
const VIEW: DocumentView = {
  id: 'doc-1', applicationId: APP, type: 'id_card', relatedEntity: 'APPLICATION', relatedId: null, note: null, fileId: FILE, fileName: 'id-card.png', mime: 'image/png', size: 40,
  checklistKey: 'id_card', uploadedBy: 'officer-1', uploadedAt: '2026-10-29T01:00:00.000Z',
};
const OCR_BODY = {
  documentId: 'doc-1', docType: 'ID_CARD', detectedDocType: 'ID_CARD', warnings: ['w1'],
  fields: { registerNo: { value: 'УБ90000001', confidence: 0.93, raw: 'УБ90000001' }, lastName: { value: 'Дорж', confidence: 0.9 }, birthDate: { value: '1985-06-15', confidence: 0.9 } },
  ocr: { engine: 'mock', meanConfidence: 0.9, pageCount: 1, durationMs: 3 },
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

const dms = (timeoutMs = 1_000, ocrTimeoutMs = 1_000) => createDmsDocuments({ DMS_URL: baseUrl }, timeoutMs, ocrTimeoutMs);
const code = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  return err instanceof DomainError ? [err.getStatus(), err.code] : err;
};

describe('HttpDmsDocuments: хүсэлт', () => {
  it('create: POST /api/documents, JSON body (orgId-гүй), контекстын толгойг дамжуулна; хариуг DocumentView-ээр шалгана', async () => {
    handler = (_req, res) => json(res, 201, VIEW);
    const out = await dms().create(REQUEST, CTX);
    expect(out).toEqual(VIEW);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/documents' });
    expect(seen[0]!.headers).toMatchObject({ 'content-type': 'application/json', 'x-user-id': 'officer-1', 'x-roles': 'OFFICER', 'x-org-id': 'org-1', 'x-branch-id': 'branch-1', 'x-correlation-id': 'corr-9' });
    expect(JSON.parse(seen[0]!.body)).toEqual(REQUEST);
  });

  it('list: GET /api/documents?applicationId=…, зөвхөн өгсөн шүүлтүүрүүд query-д орно', async () => {
    handler = (_req, res) => json(res, 200, { items: [VIEW] });
    expect(await dms().list({ applicationId: APP }, CTX)).toEqual([VIEW]);
    await dms().list({ applicationId: APP, relatedEntity: 'BORROWER', relatedId: 'cust 1/2' }, CTX);
    expect(seen[0]!.url).toBe(`/api/documents?applicationId=${APP}`);
    expect(seen[1]!.url).toBe(`/api/documents?applicationId=${APP}&relatedEntity=BORROWER&relatedId=cust+1%2F2`);
    expect(seen[0]!.headers['content-type']).toBeUndefined(); // GET-д body байхгүй
  });

  it('remove: DELETE /api/documents/:id (id-г кодолно), 204 → true; 404 → false (идемпотент)', async () => {
    handler = (_req, res) => { res.writeHead(204); res.end(); };
    expect(await dms().remove('weird/id?x=1', CTX)).toBe(true);
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/api/documents/weird%2Fid%3Fx%3D1' });
    handler = (_req, res) => json(res, 404, { code: 'DOCUMENT_NOT_FOUND', message: 'x' });
    expect(await dms().remove('doc-1', CTX)).toBe(false);
    expect(seen).toHaveLength(2); // 404 дээр дахин оролдохгүй
  });

  it('ocr: POST /api/documents/:id/ocr; регистрээс бусад хувийн талбарыг хаяж, хэвийн хэлбэрт оруулна', async () => {
    handler = (_req, res) => json(res, 200, OCR_BODY);
    const out = await dms().ocr('doc-1', CTX);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/documents/doc-1/ocr' });
    expect(out).toEqual({ readable: true, ocr: { documentId: 'doc-1', docType: 'ID_CARD', warnings: ['w1'], registerNo: 'УБ90000001', registerConfidence: 0.93, meanConfidence: 0.9 } });
    expect(JSON.stringify(out)).not.toMatch(/Дорж|1985/); // нэр, төрсөн огноо origination-д орохгүй
  });

  it('ocr: регистр талбар байхгүй/хоосон → registerNo null', async () => {
    handler = (_req, res) => json(res, 200, { ...OCR_BODY, fields: {} });
    expect(await dms().ocr('doc-1', CTX)).toMatchObject({ readable: true, ocr: { registerNo: null, registerConfidence: null } });
    handler = (_req, res) => json(res, 200, { ...OCR_BODY, fields: { registerNo: { value: null, confidence: 0 } } });
    expect(await dms().ocr('doc-1', CTX)).toMatchObject({ readable: true, ocr: { registerNo: null } });
  });

  it('INTERNAL_AUTH_SECRET тохируулсан бол X-Internal-Token дамжуулна', async () => {
    await createDmsDocuments({ DMS_URL: baseUrl, INTERNAL_AUTH_SECRET: 's3cret-internal' }).list({ applicationId: APP }, CTX).catch(() => undefined);
    expect(seen[0]!.headers['x-internal-token']).toBe('s3cret-internal');
  });

  it('timeout: энгийн дуудлага 3с, OCR 15с (CLAUDE.md §3.1)', () => {
    expect(DMS_TIMEOUT_MS).toBe(3_000);
    expect(DMS_OCR_TIMEOUT_MS).toBe(15_000);
  });

  it('GET-ийг 5xx дээр нэг дахин оролдоно; POST/DELETE дахин оролдохгүй', async () => {
    handler = (_req, res) => json(res, 500, { message: 'boom' });
    await expect(dms().list({ applicationId: APP }, CTX)).rejects.toBeInstanceOf(UpstreamError);
    expect(seen).toHaveLength(2);
    seen.length = 0;
    await expect(dms().create(REQUEST, CTX)).rejects.toBeInstanceOf(UpstreamError);
    await expect(dms().remove('d', CTX)).rejects.toBeInstanceOf(UpstreamError);
    await expect(dms().ocr('d', CTX)).rejects.toBeInstanceOf(UpstreamError);
    expect(seen).toHaveLength(3);
  });
});

describe('HttpDmsDocuments: алдааны хөрвүүлэлт', () => {
  it('create 404 FILE_NOT_FOUND → 422 FILE_NOT_FOUND (хүсэлт олдсонгүй 404-өөс ялгагдана)', async () => {
    handler = (_req, res) => json(res, 404, { code: 'FILE_NOT_FOUND', message: 'dms internal detail' });
    const err = await dms().create(REQUEST, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect([(err as DomainError).getStatus(), (err as DomainError).code]).toEqual([422, 'FILE_NOT_FOUND']);
    expect((err as DomainError).message).toBe('Файл олдсонгүй эсвэл устгагдсан байна');
  });

  it.each([400, 401, 403, 409, 413, 422])('create %i → 502 UPSTREAM_ERROR (dms-ийн дотоод мессеж ажилтанд дамжихгүй)', async (status) => {
    handler = (_req, res) => json(res, status, { code: 'RELATED_ID_REQUIRED', message: 'dms internal detail' });
    const err = await dms().create(REQUEST, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect([(err as DomainError).getStatus(), (err as DomainError).code]).toEqual([502, 'UPSTREAM_ERROR']);
    expect(JSON.stringify((err as DomainError).getResponse())).not.toContain('dms internal detail');
  });

  it.each([500, 502, 503])('%i → UpstreamError (502)', async (status) => {
    handler = (_req, res) => json(res, status, { message: 'whatever' });
    const err = await dms().create(REQUEST, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).getStatus()).toBe(502);
  });

  it('timeout: хариу өгөхгүй сервер → 504 (хугацаандаа)', async () => {
    handler = () => undefined;
    const started = Date.now();
    const err = await dms(150).create(REQUEST, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).getStatus()).toBe(504);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('OCR-д тусдаа (урт) timeout хэрэглэгдэнэ: энгийн timeout богино ч OCR хүлээнэ', async () => {
    handler = (_req, res) => setTimeout(() => json(res, 200, OCR_BODY), 300);
    expect(await dms(100, 2_000).ocr('doc-1', CTX)).toMatchObject({ readable: true });
    const err = await dms(2_000, 100).ocr('doc-1', CTX).catch((e: unknown) => e);
    expect((err as UpstreamError).getStatus()).toBe(504);
  });

  it('холбогдох боломжгүй → 502', async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const err = await createDmsDocuments({ DMS_URL: `http://127.0.0.1:${port}` }, 1_000).create(REQUEST, CTX).catch((e: unknown) => e);
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
      await expect(dms().create(REQUEST, CTX)).rejects.toBeInstanceOf(UpstreamError);
      expect(hit).not.toHaveBeenCalled();
    } finally {
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});

describe('HttpDmsDocuments: OCR-ийн уншигдахгүй байдал ба алдаа', () => {
  it.each([
    [415, 'UNSUPPORTED_MIME', 'UNSUPPORTED_FILE'],
    [422, 'EMPTY_RESULT', 'NO_TEXT'],
    [422, 'NO_FIXTURE', 'NO_TEXT'],
    [413, 'OCR_FILE_TOO_LARGE', 'FILE_TOO_LARGE'],
    [400, 'INVALID_INPUT', 'INVALID_FILE'],
  ])('%i %s → readable:false (%s), алдаа биш', async (status, errorCode, reason) => {
    handler = (_req, res) => json(res, status, { statusCode: status, code: errorCode, message: 'x' });
    expect(await dms().ocr('doc-1', CTX)).toEqual({ readable: false, reason });
  });

  it('404 → DOCUMENT_NOT_FOUND, 429 → OCR_BUSY, танигдаагүй 4xx → 502', async () => {
    handler = (_req, res) => json(res, 404, { code: 'DOCUMENT_NOT_FOUND', message: 'x' });
    expect(await code(dms().ocr('doc-1', CTX))).toEqual([404, 'DOCUMENT_NOT_FOUND']);
    handler = (_req, res) => json(res, 429, { code: 'BUSY', message: 'x' });
    expect(await code(dms().ocr('doc-1', CTX))).toEqual([429, 'OCR_BUSY']);
    handler = (_req, res) => json(res, 403, { code: 'FORBIDDEN', message: 'x' });
    expect(await code(dms().ocr('doc-1', CTX))).toEqual([502, 'UPSTREAM_ERROR']);
  });

  it('503 ENGINE_UNAVAILABLE / 504 TIMEOUT → UpstreamError (дүгнэлт биш, дахин оролдох алдаа)', async () => {
    for (const status of [502, 503, 504]) {
      handler = (_req, res) => json(res, status, { code: 'ENGINE_UNAVAILABLE', message: 'x' });
      await expect(dms().ocr('doc-1', CTX)).rejects.toBeInstanceOf(UpstreamError);
    }
  });
});

describe('HttpDmsDocuments: хариуны шалгалт, PII-гүй лог', () => {
  it('JSON биш / schema-д нийцэхгүй body → 502 UPSTREAM_ERROR', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>oops</html>'); };
    expect(await code(dms().create(REQUEST, CTX))).toEqual([502, 'UPSTREAM_ERROR']);
    handler = (_req, res) => json(res, 200, { ...VIEW, relatedEntity: 'NOPE' });
    expect(await code(dms().create(REQUEST, CTX))).toEqual([502, 'UPSTREAM_ERROR']);
    handler = (_req, res) => json(res, 200, { items: [{ id: 'x' }] });
    expect(await code(dms().list({ applicationId: APP }, CTX))).toEqual([502, 'UPSTREAM_ERROR']);
    handler = (_req, res) => json(res, 200, { documentId: 'd' });
    expect(await code(dms().ocr('d', CTX))).toEqual([502, 'UPSTREAM_ERROR']);
  });

  it('body-г хэзээ ч логлохгүй: алдааны замуудад тайлбар/регистр/файлын нэр лог, exception-д гарахгүй', async () => {
    const out: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void out.push(JSON.stringify(args)));
    }
    const leaky = { code: 'X', message: 'register УБ90000001 file id-card.png note Бат-Эрдэнийн үнэмлэх' };
    const errors: unknown[] = [];
    for (const status of [400, 404, 409, 500]) {
      handler = (_req, res) => json(res, status, leaky);
      errors.push(await dms().create(REQUEST, CTX).catch((e: unknown) => e));
      errors.push(await dms().ocr('doc-1', CTX).catch((e: unknown) => e));
    }
    handler = (_req, res) => json(res, 200, { ...VIEW, fileName: 123, note: 'УБ90000001' }); // schema алдаа
    errors.push(await dms().create(REQUEST, CTX).catch((e: unknown) => e));
    handler = (_req, res) => json(res, 200, { ...OCR_BODY, ocr: 'УБ90000001' });
    errors.push(await dms().ocr('doc-1', CTX).catch((e: unknown) => e));

    const everything = out.join('\n') + JSON.stringify(errors.map((e) => (e instanceof DomainError ? e.getResponse() : String(e))));
    for (const secret of ['УБ90000001', 'id-card.png', 'Бат-Эрдэнийн']) expect(everything).not.toContain(secret);
    expect(out.length).toBeGreaterThan(0); // зөвхөн { op, status, correlationId } логлосон
  });
});
