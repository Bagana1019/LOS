import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { context, silenceLogs } from './contract-signing.fixtures';
import { createDmsDocgen } from './http-dms-docgen.port';

silenceLogs();

const CTX = context('OFFICER', { correlationId: 'corr-1' });

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let handler: Handler;
let urls: string[];
let baseUrl: string;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeEach(async () => {
  urls = [];
  handler = (_req, res) => json(res, 200, {});
  server = createServer((req, res) => { urls.push(req.url ?? ''); handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const docgen = () => createDmsDocgen({ DMS_URL: baseUrl });

// F4-13: the signed-scan type check relies on the type dms stored (verified against the file's magic bytes at upload).
describe('HttpDmsDocgen.fileInfo (F4-13)', () => {
  it('passes the dms-stored type and uploader through (GET /api/files/:id)', async () => {
    handler = (_req, res) => json(res, 200, { id: 'f-1', name: 'scan.png', mime: 'image/png', size: 10, sha256: 'x', uploadedBy: 'u-1', createdAt: '2026-11-20T00:00:00.000Z' });
    expect(await docgen().fileInfo('f-1', CTX)).toEqual({ uploadedBy: 'u-1', mime: 'image/png' });
    expect(urls).toEqual(['/api/files/f-1']);
  });

  it.each([['absent', {}], ['not a string', { mime: 42 }], ['null', { mime: null }]])('reports mime = null when dms returns it %s, so the caller fails closed', async (_label, extra) => {
    handler = (_req, res) => json(res, 200, { id: 'f-1', uploadedBy: 'u-1', ...extra });
    expect(await docgen().fileInfo('f-1', CTX)).toEqual({ uploadedBy: 'u-1', mime: null });
  });

  it('answers null for a file dms does not know (404)', async () => {
    handler = (_req, res) => json(res, 404, { code: 'NOT_FOUND', message: 'Файл олдсонгүй' });
    expect(await docgen().fileInfo('missing', CTX)).toBeNull();
  });
});
