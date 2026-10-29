import { describe, expect, it } from 'vitest';
import { normalizeIp, rateLimitKeyForIp, resolveClientIp } from './client-ip';

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['2001:DB8::1', '2001:db8::1'],
    ['fe80::1%eth0', 'fe80::1'],
    [' 10.0.0.1 ', '10.0.0.1'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });

  it.each([undefined, '', 'unknown', '1.2.3.4, 5.6.7.8', '999.1.1.1', 'a\r\nb: c'])('IP биш утга (%s) → undefined', (input) => {
    expect(normalizeIp(input)).toBeUndefined();
  });
});

describe('resolveClientIp', () => {
  it('req.ip хүчинтэй бол түүнийг, IP биш бол сокетын хаягийг ашиглана', () => {
    expect(resolveClientIp({ ip: '203.0.113.7', socket: { remoteAddress: '10.0.0.1' } } as never)).toBe('203.0.113.7');
    expect(resolveClientIp({ ip: 'not-an-ip', socket: { remoteAddress: '::ffff:10.0.0.1' } } as never)).toBe('10.0.0.1');
    expect(resolveClientIp({ ip: undefined, socket: {} } as never)).toBeUndefined();
  });
});

describe('rateLimitKeyForIp', () => {
  it('IPv4 хэвээр', () => {
    expect(rateLimitKeyForIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv6 нь /64 угтвараар нэгдэнэ', () => {
    const a = rateLimitKeyForIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(a).toBe('2001:0db8:0001:0002::/64');
    expect(rateLimitKeyForIp('2001:db8:1:2::9')).toBe(a);
    expect(rateLimitKeyForIp('2001:db8:1:3::9')).not.toBe(a);
  });

  it('товчилсон хэлбэрүүдийг зөв задална', () => {
    expect(rateLimitKeyForIp('::1')).toBe('0000:0000:0000:0000::/64');
    expect(rateLimitKeyForIp('::')).toBe('0000:0000:0000:0000::/64');
    expect(rateLimitKeyForIp('2001:db8::')).toBe('2001:0db8:0000:0000::/64');
    expect(rateLimitKeyForIp('64:ff9b::1.2.3.4')).toBe('0064:ff9b:0000:0000::/64');
  });

  it('IP байхгүй бол нийтлэг "unknown" түлхүүр', () => {
    expect(rateLimitKeyForIp(undefined)).toBe('unknown');
  });
});
