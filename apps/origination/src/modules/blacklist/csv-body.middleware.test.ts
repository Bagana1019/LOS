import { Readable } from 'node:stream';
import { BadRequestException, ForbiddenException, PayloadTooLargeException, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvBodyMiddleware } from './csv-body.middleware';

// FR-13.1: ≤ 5 MB. Тогтмолыг импортлохгүй — утга өөрчлөгдвөл тест унах ёстой.
const FIVE_MB = 5 * 1024 * 1024;
const CHUNK = 64 * 1024;
const AUTH = { 'content-type': 'text/csv', 'x-user-id': 'user-1', 'x-roles': 'ADMIN', 'x-org-id': 'org-1' };

/** Сүлжээний IncomingMessage-ийн оронд: хэдэн byte "татагдсаныг" тоолдог Readable. */
class FakeRequest extends Readable {
  pulled = 0;
  complete = false;
  body?: unknown;
  constructor(readonly headers: Record<string, string>, private readonly source: () => Buffer | null) { super(); }

  _read() {
    const chunk = this.source();
    if (chunk) {
      this.pulled += chunk.length;
      this.push(chunk);
    } else {
      this.complete = true;
      this.push(null);
    }
  }
}

const endless = () => Buffer.alloc(CHUNK, 0x61);
const chunksOf = (...parts: Buffer[]) => {
  const queue = [...parts];
  return () => queue.shift() ?? null;
};
const fakeRes = () => {
  const headers: Record<string, string> = {};
  return { headers, headersSent: false, setHeader: (k: string, v: string) => { headers[k] = v; } };
};
const run = async (req: FakeRequest, res = fakeRes()) => {
  const next = vi.fn();
  await csvBodyMiddleware(req as never, res as never, next);
  return { next, res };
};

describe('csvBodyMiddleware', () => {
  let delay: (ms: number) => Promise<void>;
  beforeEach(() => { delay = (ms) => new Promise((r) => setTimeout(r, ms)); });
  afterEach(() => vi.restoreAllMocks());

  it('stops reading as soon as the running total exceeds the cap: at most cap + one chunk is pulled, then nothing more', async () => {
    const req = new FakeRequest(AUTH, endless);
    const { next, res } = await run(req);

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0]).toBeInstanceOf(PayloadTooLargeException);
    // Хуулийн хязгаар + нэг chunk (Readable-ийн дотоод HWM-д нэг chunk илүү бэлтгэж болно).
    expect(req.pulled).toBeLessThanOrEqual(FIVE_MB + 2 * CHUNK);
    expect(req.pulled).toBeGreaterThan(FIVE_MB);
    const pulledAtReject = req.pulled;
    await delay(50);
    expect(req.pulled).toBe(pulledAtReject);
    expect(req.listenerCount('data')).toBe(0);
    expect(req.isPaused()).toBe(true);
    expect(res.headers.Connection).toBe('close');
  });

  it('accepts a body of exactly the cap', async () => {
    const parts = Array.from({ length: FIVE_MB / CHUNK }, () => endless());
    const req = new FakeRequest(AUTH, chunksOf(...parts));
    const { next } = await run(req);
    expect(next).toHaveBeenCalledWith();
    expect((req.body as string).length).toBe(FIVE_MB);
  });

  it('rejects one byte over the cap', async () => {
    const parts = [...Array.from({ length: FIVE_MB / CHUNK }, () => endless()), Buffer.from('a')];
    const { next } = await run(new FakeRequest(AUTH, chunksOf(...parts)));
    expect(next.mock.calls[0][0]).toBeInstanceOf(PayloadTooLargeException);
  });

  it.each([
    ['no X-User-Id', { 'content-type': 'text/csv', 'x-roles': 'ADMIN', 'x-org-id': 'org-1' }, UnauthorizedException],
    ['OFFICER', { ...AUTH, 'x-roles': 'OFFICER' }, ForbiddenException],
    ['no roles', { ...AUTH, 'x-roles': '' }, ForbiddenException],
    ['no org', { 'content-type': 'text/csv', 'x-user-id': 'user-1', 'x-roles': 'ADMIN' }, BadRequestException],
  ])('rejects %s before touching the body', async (_label, headers, errorType) => {
    vi.stubEnv('DEFAULT_ORG_ID', '');
    const req = new FakeRequest(headers, endless);
    const { next, res } = await run(req);

    expect(next.mock.calls[0][0]).toBeInstanceOf(errorType);
    expect(req.pulled).toBe(0);
    expect(req.listenerCount('data')).toBe(0);
    expect(res.headers.Connection).toBe('close');
    vi.unstubAllEnvs();
  });

  it('rejects an oversize Content-Length without reading, after the auth checks', async () => {
    const req = new FakeRequest({ ...AUTH, 'content-length': String(FIVE_MB + 1) }, endless);
    const { next, res } = await run(req);
    expect(next.mock.calls[0][0]).toBeInstanceOf(PayloadTooLargeException);
    expect(req.pulled).toBe(0);
    expect(res.headers.Connection).toBe('close');

    const forbidden = new FakeRequest({ ...AUTH, 'x-roles': 'OFFICER', 'content-length': String(FIVE_MB + 1) }, endless);
    expect((await run(forbidden)).next.mock.calls[0][0]).toBeInstanceOf(ForbiddenException);
  });

  it('puts the decoded UTF-8 text (BOM removed) into req.body and calls next() without an error or Connection: close', async () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('registerNo\nУБ12345678\n', 'utf8')]);
    const req = new FakeRequest({ ...AUTH, 'content-length': String(body.length) }, chunksOf(body.subarray(0, 7), body.subarray(7)));
    const { next, res } = await run(req);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toBe('registerNo\nУБ12345678\n');
    expect(res.headers.Connection).toBeUndefined();
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = Buffer.from('Бат', 'utf8');
    const req = new FakeRequest(AUTH, chunksOf(bytes.subarray(0, 1), bytes.subarray(1)));
    await run(req);
    expect(req.body).toBe('Бат');
  });

  it.each([
    ['windows-1251', Buffer.from([0xc1, 0xe0, 0xf2])],
    ['UTF-16LE', Buffer.from('﻿abc', 'utf16le')],
    ['a lone continuation byte', Buffer.from([0x61, 0x80, 0x62])],
    ['a truncated sequence', Buffer.from([0x61, 0xd0])],
  ])('answers 400 naming UTF-8 for %s, without a replacement-character fallback', async (_label, bytes) => {
    const req = new FakeRequest(AUTH, chunksOf(bytes));
    const { next, res } = await run(req);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain('UTF-8');
    expect(req.body).toBeUndefined();
    expect(res.headers.Connection).toBeUndefined(); // body бүрэн уншигдсан тул холболтыг хаах шаардлагагүй
  });

  // Бодит Node-д клиент таслахад req 'aborted' (ECONNRESET) алдаатай destroy болж, 'error' нь 'close'-оос өмнө ирдэг
  // (бодит socket-ийн тест нь blacklist.controller.test.ts-д).
  const abortedBody = () => {
    let n = 0;
    return new FakeRequest(AUTH, () => (++n <= 2 ? Buffer.from('abc') : Buffer.alloc(0)));
  };

  it('answers 400 (and never hangs) when the client aborts mid-body: only a close, no error', async () => {
    const req = abortedBody();
    setTimeout(() => req.destroy(), 10); // 'end' ирэхгүй, зөвхөн 'close'
    const { next } = await run(req);
    expect(next.mock.calls[0][0]).toBeInstanceOf(BadRequestException);
    expect((next.mock.calls[0][0] as BadRequestException).message).toBe('Request body was aborted');
    expect(req.complete).toBe(false);
  });

  it.each([
    ['ECONNRESET code', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ["message 'aborted' (Node's connection reset)", Object.assign(new Error('aborted'), { code: 'ECONNRESET' })],
    ["message 'aborted' without a code", new Error('aborted')],
    ['any other error while the body is incomplete', new Error('socket hang up')],
  ])('answers a quiet 400 (not the raw error) when the stream errors before close: %s', async (_label, error) => {
    const req = abortedBody();
    setTimeout(() => req.destroy(error), 10); // Node: destroy(err) нь 'error'-ыг 'close'-оос өмнө emit хийнэ
    const { next } = await run(req);
    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe('Request body was aborted');
    expect(req.listenerCount('error')).toBe(0);
  });

  it('forwards a stream error that is not an abort (the body was received completely)', async () => {
    const boom = new Error('decoder blew up');
    const req = new FakeRequest(AUTH, () => { req.complete = true; throw boom; });
    // Readable._read дотор шидвэл stream 'error' emit хийнэ. complete=true: body бүрэн ирсэн тул таслалт биш.
    const { next } = await run(req);
    expect(next.mock.calls[0][0]).toBe(boom);
  });

  it('ignores requests that are not text/csv', async () => {
    const req = new FakeRequest({ 'content-type': 'application/json' }, endless);
    const { next } = await run(req);
    expect(next).toHaveBeenCalledWith();
    expect(req.pulled).toBe(0);
    expect(req.body).toBeUndefined();
  });

  it('matches the content type case-insensitively and with parameters', async () => {
    const req = new FakeRequest({ ...AUTH, 'content-type': 'TEXT/CSV; charset=UTF-8' }, chunksOf(Buffer.from('a,b')));
    await run(req);
    expect(req.body).toBe('a,b');
  });

  it.each(['text/csv', 'text/csv;charset=utf-8', 'Text/CSV ; charset=utf-8'])('treats "%s" as CSV', async (contentType) => {
    const req = new FakeRequest({ ...AUTH, 'content-type': contentType }, chunksOf(Buffer.from('a,b')));
    await run(req);
    expect(req.body).toBe('a,b');
  });

  it.each([
    ['application/json', 'a JSON body'],
    ['text/plain', 'plain text'],
    ['text/csvx', 'a longer subtype'],
    ['application/text/csv', 'a different type that merely ends in text/csv'],
    ['application/json; note=text/csv', 'text/csv inside a parameter'],
    ['', 'an empty value'],
  ])('leaves "%s" (%s) alone: no auth check, nothing read, no req.body', async (contentType) => {
    const req = new FakeRequest({ 'content-type': contentType }, endless); // толгой хоосон: guard-д л үлдэнэ
    const { next } = await run(req);
    expect(next).toHaveBeenCalledWith();
    expect(req.pulled).toBe(0);
    expect(req.body).toBeUndefined();
  });

  it('leaves a request without a content type alone', async () => {
    const req = new FakeRequest({}, endless);
    const { next } = await run(req);
    expect(next).toHaveBeenCalledWith();
    expect(req.pulled).toBe(0);
  });

  // Хатуу декодер зөвхөн буруу БАЙТ-ыг барина; Windows-1251-ээс аль хэдийн U+FFFD болгон хөрвүүлсэн файл нь зөв UTF-8.
  it.each([
    ['in a data cell', 'registerNo,name\n\uFFFD\uFFFD12345678,\uFFFD\uFFFD\uFFFD\n'],
    ['alone, mid-line', 'registerNo,name\nУБ12345678,Бат\uFFFDБолд\n'],
    ['in the header', 'registerNo,na\uFFFDme\n'],
  ])('answers 400 naming UTF-8 for valid UTF-8 that contains U+FFFD %s (a lossy conversion already happened)', async (_label, text) => {
    for (const bom of [Buffer.alloc(0), Buffer.from([0xef, 0xbb, 0xbf])]) {
      const req = new FakeRequest(AUTH, chunksOf(Buffer.concat([bom, Buffer.from(text, 'utf8')])));
      const { next } = await run(req);
      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain('"CSV UTF-8"');
      expect(req.body).toBeUndefined();
    }
  });

  it('still accepts text next to characters that merely look like the replacement character', async () => {
    const req = new FakeRequest(AUTH, chunksOf(Buffer.from('registerNo\nУБ1 ◆ ? Бат\n', 'utf8')));
    await run(req);
    expect(req.body).toBe('registerNo\nУБ1 ◆ ? Бат\n');
  });
});
