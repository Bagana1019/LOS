import { describe, expect, it } from 'vitest';
import { buildClientHeaders, buildUpstreamHeaders, pickCorrelationId } from './header-policy';

const ctx = { correlationId: 'corr-1', clientIp: '203.0.113.7', hasBody: true };

describe('pickCorrelationId', () => {
  it('аюулгүй утгыг хадгална', () => {
    expect(pickCorrelationId('abc-123_X.y:z')).toBe('abc-123_X.y:z');
  });
  it.each([undefined, '', 'has space', 'a'.repeat(129), '<script>', 'a\nb'])('%j → шинэ UUID', (raw) => {
    expect(pickCorrelationId(raw)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('массив бол эхний утга', () => {
    expect(pickCorrelationId(['one', 'two'])).toBe('one');
  });
});

describe('buildUpstreamHeaders — энгийн route', () => {
  const incoming = {
    cookie: 'sid=1',
    authorization: 'Bearer x',
    'x-user-id': 'u1',
    'x-roles': 'ADMIN',
    'x-forwarded-for': '6.6.6.6',
    'content-type': 'application/json',
    'user-agent': 'curl',
    accept: '*/*',
    origin: 'https://evil.example',
  };

  it('зөвхөн content-type, x-correlation-id, x-forwarded-for', () => {
    const h = buildUpstreamHeaders('json', incoming, ctx);
    expect([...h.keys()].sort()).toEqual(['content-type', 'x-correlation-id', 'x-forwarded-for']);
    expect(h.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(h.get('x-correlation-id')).toBe('corr-1');
  });

  it('бие байхгүй бол content-type дамжуулахгүй; IP үл мэдэгдэх бол x-forwarded-for тавихгүй', () => {
    const h = buildUpstreamHeaders('pdf', incoming, { ...ctx, hasBody: false, clientIp: undefined });
    expect([...h.keys()]).toEqual(['x-correlation-id']);
  });
});

describe('buildUpstreamHeaders — webhook', () => {
  it('denylist-ээс бусдыг дамжуулж, дотоод итгэмжлэл/proxy толгойг устгана', () => {
    const h = buildUpstreamHeaders(
      'webhook',
      {
        host: 'gateway.public',
        connection: 'keep-alive, x-hop',
        'x-hop': '1',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'content-length': '12',
        'content-encoding': 'gzip',
        'accept-encoding': 'gzip',
        cookie: 'sid=1',
        'x-user-id': 'u1',
        'x-roles': 'ADMIN',
        'x-branch-id': 'b1',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-host': 'evil',
        forwarded: 'for=6.6.6.6',
        'x-real-ip': '6.6.6.6',
        'x-correlation-id': 'evil id',
        'content-type': 'application/json',
        authorization: 'Bearer provider-secret',
        'x-signature': 'sha256=abc',
        'x-multi': ['a', 'b'],
      },
      ctx,
    );
    expect(Object.fromEntries(h.entries())).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer provider-secret',
      'x-signature': 'sha256=abc',
      'x-multi': 'a, b',
      'x-correlation-id': 'corr-1',
      'x-forwarded-for': '203.0.113.7',
    });
  });
});

describe('buildClientHeaders', () => {
  it('allowlist: content-type, content-disposition, content-length; set-cookie/cache-control/server/location гарахгүй', () => {
    const upstream = new Headers({
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="a.pdf"',
      'content-length': '10',
      'set-cookie': 'sid=1',
      'cache-control': 'public, max-age=600',
      server: 'dms',
      location: 'http://dms.internal/x',
      etag: '"x"',
    });
    expect(buildClientHeaders(upstream, 'c1')).toEqual({
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="a.pdf"',
      'content-length': '10',
      'x-correlation-id': 'c1',
    });
  });

  it('upstream шахсан (content-encoding) бол fetch тайлсан тул content-length-ийг дамжуулахгүй', () => {
    const upstream = new Headers({ 'content-type': 'application/json', 'content-length': '5', 'content-encoding': 'gzip' });
    expect(buildClientHeaders(upstream, 'c1')).toEqual({ 'content-type': 'application/json', 'x-correlation-id': 'c1' });
    expect(buildClientHeaders(new Headers({ 'content-length': '5', 'content-encoding': 'identity' }), 'c1')['content-length']).toBe('5');
  });
});
