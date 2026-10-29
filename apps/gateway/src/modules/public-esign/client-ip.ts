import { isIP, isIPv4, isIPv6 } from 'node:net';
import type { Request } from 'express';

// Клиентийн жинхэнэ IP. Express-ийн `req.ip` нь `trust proxy` тохиргоог (TRUST_PROXY, main.ts) зөв хэрэгжүүлдэг:
// тохируулаагүй бол сокетын хаяг, тохируулсан бол итгэмжлэгдсэн proxy-ийн хойно байгаа эхний хаяг.
// Клиентийн илгээсэн X-Forwarded-For-д БИДЭНД шууд итгэдэггүй.

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → `1.2.3.4`; zone id-г хасна. IP биш утга бол undefined. */
export function normalizeIp(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let ip = raw.trim();
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!isIP(ip)) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  return ip.toLowerCase();
}

export function resolveClientIp(req: Pick<Request, 'ip' | 'socket'>): string | undefined {
  // `req.ip` нь proxy-addr-аас ирэх тул (trust proxy үед) IP биш текст байж болно — шалгаад socket руу буцна
  return normalizeIp(req.ip) ?? normalizeIp(req.socket?.remoteAddress);
}

function expandIPv6(ip: string): string[] {
  let v = ip;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    v = `${v.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = rest ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...Array<string>(fill).fill('0'), ...t].map((g) => g.padStart(4, '0'));
}

/**
 * Rate limit-ийн түлхүүр. IPv6 хэрэглэгч бүр /64 блок эзэмшдэг тул хаягийг өөрчилж хязгаараас
 * гарахаас сэргийлж /64 угтвараар нь тоолно. IPv4 хэвээр.
 */
export function rateLimitKeyForIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (!isIPv6(ip)) return ip;
  return `${expandIPv6(ip).slice(0, 4).join(':')}::/64`;
}
