import { BlockList, isIP } from 'node:net';
import { normalizeIp } from '../public-esign/client-ip';
import { PUBLIC_PAYMENT_CALLBACKS, type PublicCallbackRoute } from '../proxy/route-policy';

// H9 — провайдер тус бүрийн итгэмжлэгдсэн эх сурвалжийн хүрээ (PAYMENT_CALLBACK_TRUSTED_CIDRS_<PROVIDER>, таслалаар, IPv4/IPv6 CIDR
// эсвэл ганц хаяг). Эхлэхэд шалгана: буруу утга → алдаа. /0 хориотой (бүх интернэтийг итгэмжлэх нь хамгаалалтыг утгагүй болгоно).
// Клиентийн IP-г trust-proxy-г мөрддөг resolveClientIp-ээр (дуудагч) авна — клиентийн X-Forwarded-For-д шууд итгэхгүй.

export type PaymentProvider = PublicCallbackRoute['provider'];
export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = [...new Set(PUBLIC_PAYMENT_CALLBACKS.map((r) => r.provider))];
export const trustedCidrEnv = (p: PaymentProvider) => `PAYMENT_CALLBACK_TRUSTED_CIDRS_${p}`;

export type IpMatcher = (ip: string | undefined) => boolean;

function addEntry(list: BlockList, name: string, entry: string): void {
  const fail = (): never => { throw new Error(`Invalid ${name}: "${entry}" is not an IPv4/IPv6 address or CIDR`); };
  const parts = entry.split('/');
  if (parts.length > 2) fail();
  const [addr, prefixRaw] = parts as [string, string | undefined];
  const family = isIP(addr);
  if (!family) fail();
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const max = family === 4 ? 32 : 128;
  if (prefixRaw === undefined) { list.addAddress(addr, type); return; }
  if (!/^\d{1,3}$/.test(prefixRaw)) fail();
  const prefix = Number(prefixRaw);
  if (prefix < 1 || prefix > max) fail();
  list.addSubnet(addr, prefix, type);
}

/** Таслалаар тусгаарласан CIDR жагсаалт → matcher. Хоосон бол юуг ч итгэмжлэхгүй. */
export function parseCidrList(name: string, raw: string | undefined): IpMatcher {
  const list = new BlockList();
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of entries) addEntry(list, name, e);
  if (entries.length === 0) return () => false;
  return (ip) => {
    const n = normalizeIp(ip);
    return !!n && list.check(n, isIP(n) === 4 ? 'ipv4' : 'ipv6');
  };
}

export interface TrustedSources { isTrusted(provider: PaymentProvider, ip: string | undefined): boolean; unconfigured: PaymentProvider[] }

export function loadTrustedSources(env: NodeJS.ProcessEnv = process.env): TrustedSources {
  const matchers = new Map(PAYMENT_PROVIDERS.map((p) => [p, parseCidrList(trustedCidrEnv(p), env[trustedCidrEnv(p)])] as const));
  return {
    isTrusted: (provider, ip) => matchers.get(provider)?.(ip) ?? false,
    unconfigured: PAYMENT_PROVIDERS.filter((p) => !(env[trustedCidrEnv(p)] ?? '').split(',').some((s) => s.trim())),
  };
}

/** Production-д хүрээгүй провайдер бүрт анхааруулга (унагахгүй): тэр провайдерын жинхэнэ callback «итгэмжлэгдээгүй» хязгаараар явна. */
export function trustedSourceWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  return loadTrustedSources(env).unconfigured.map((p) =>
    `payment callbacks: no trusted source ranges for ${p} (${trustedCidrEnv(p)}); its real callbacks are limited as untrusted traffic (PAYMENT_CALLBACK_UNTRUSTED_*)`);
}
