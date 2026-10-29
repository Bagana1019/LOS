import { describe, expect, it } from 'vitest';
import { clientMeta, headerValue, loggableCorrelationId, normalizeIp, requestContext } from './request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const req = (headers: Record<string, string | string[] | undefined> = {}, remoteAddress?: string) => ({ headers, socket: { remoteAddress } }) as unknown as Parameters<typeof clientMeta>[0];

describe('headerValue', () => {
  it('trim хийнэ; хоосон/зөвхөн зай/байхгүй бол undefined; массивыг `, `-ээр нэгтгэнэ', () => {
    expect(headerValue({ a: '  x ' }, 'a')).toBe('x');
    expect(headerValue({ a: '' }, 'a')).toBeUndefined();
    expect(headerValue({ a: '   ' }, 'a')).toBeUndefined();
    expect(headerValue({}, 'a')).toBeUndefined();
    expect(headerValue({ a: ['1', '2'] }, 'a')).toBe('1, 2');
  });
});

describe('requestContext', () => {
  it('X-User-Id ба X-Correlation-Id-г уншина', () => {
    expect(requestContext(req({ 'x-user-id': 'officer-7', 'x-correlation-id': 'corr.1:a_b-2' }))).toEqual({ actorId: 'officer-7', correlationId: 'corr.1:a_b-2' });
  });

  it('X-User-Id байхгүй/хоосон → actorId null', () => {
    expect(requestContext(req()).actorId).toBeNull();
    expect(requestContext(req({ 'x-user-id': '  ' })).actorId).toBeNull();
  });

  it.each([['зай', 'a b'], ['128-аас урт', 'a'.repeat(129)], ['ASCII биш', 'officér'], ['олон толгой', ['a', 'b']], ['шинэ мөр', 'a\nb']])('X-User-Id %s → ZodError (x-user-id замтай), утгыг агуулахгүй', (_name, value) => {
    let thrown: unknown;
    try {
      requestContext(req({ 'x-user-id': value }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'ZodError', issues: [{ path: ['x-user-id'] }] });
    expect(JSON.stringify((thrown as { issues: unknown }).issues)).not.toContain('officér');
  });

  it('X-Correlation-Id байхгүй эсвэл буруу хэлбэр (injection) бол шинэ uuid', () => {
    expect(requestContext(req()).correlationId).toMatch(UUID);
    for (const bad of ['bad id', 'a'.repeat(129), 'x"y', 'a,b', 'ё']) expect(requestContext(req({ 'x-correlation-id': bad })).correlationId).toMatch(UUID);
    expect(requestContext(req()).correlationId).not.toBe(requestContext(req()).correlationId);
  });
});

describe('loggableCorrelationId', () => {
  it('зөвхөн хүчинтэй толгойнхыг буцаана, шинээр үүсгэхгүй', () => {
    expect(loggableCorrelationId(req({ 'x-correlation-id': 'corr-1' }))).toBe('corr-1');
    expect(loggableCorrelationId(req({ 'x-correlation-id': 'bad id' }))).toBeUndefined();
    expect(loggableCorrelationId(req())).toBeUndefined();
  });
});

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    [' 203.0.113.9 ', '203.0.113.9'],
    ['2001:DB8::1', '2001:db8::1'],
    ['::ffff:198.51.100.4', '198.51.100.4'],
    ['::FFFF:198.51.100.4', '198.51.100.4'],
    ['fe80::1%eth0', 'fe80::1'],
    ['::1', '::1'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeIp(raw)).toBe(expected);
  });

  it.each(['', 'garbage', '999.1.1.1', '1.2.3', '1.2.3.4:80', '::ffff:999.1.1.1', "1.2.3.4'", undefined])('%s → undefined', (raw) => {
    expect(normalizeIp(raw)).toBeUndefined();
  });
});

describe('clientMeta', () => {
  it('X-Forwarded-For-ийн эхний hop; User-Agent', () => {
    expect(clientMeta(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'TestBrowser/1.0' }, '10.0.0.5'))).toEqual({ ip: '203.0.113.9', userAgent: 'TestBrowser/1.0' });
  });

  it('X-Forwarded-For байхгүй бол сокетын хаяг (IPv4-mapped → IPv4)', () => {
    expect(clientMeta(req({}, '::ffff:10.0.0.5'))).toEqual({ ip: '10.0.0.5', userAgent: null });
  });

  it('эхний hop IP биш бол (дараагийн hop-д ШИЛЖИХГҮЙ) сокетын хаяг', () => {
    expect(clientMeta(req({ 'x-forwarded-for': 'unknown, 203.0.113.9' }, '10.0.0.5')).ip).toBe('10.0.0.5');
    expect(clientMeta(req({ 'x-forwarded-for': ', 203.0.113.9' }, '10.0.0.5')).ip).toBe('10.0.0.5');
  });

  it('хаяг огт тодорхойгүй бол null', () => {
    expect(clientMeta(req({}, undefined)).ip).toBeNull();
    expect(clientMeta({ headers: {} } as Parameters<typeof clientMeta>[0]).ip).toBeNull();
  });

  it('User-Agent 255 тэмдэгтээр таслагдана', () => {
    expect(clientMeta(req({ 'user-agent': 'u'.repeat(300) })).userAgent).toHaveLength(255);
    expect(clientMeta(req({ 'user-agent': 'u'.repeat(255) })).userAgent).toHaveLength(255);
  });
});
