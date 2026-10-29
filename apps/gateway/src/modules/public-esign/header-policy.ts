import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// Толгойн бодлого. Энгийн route-д upstream руу зөвхөн allowlist (content-type, x-correlation-id) + x-forwarded-for (бидний тодорхойлсон жинхэнэ IP);
// cookie/authorization/x-user-id гэх мэтийг ХЭЗЭЭ Ч дамжуулахгүй. Webhook-д provider-ийн гарын үсгийн толгой хэрэгтэй тул denylist-ээр дамжуулна.

export type ProxyKind = 'json' | 'pdf' | 'webhook';

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

// Webhook-д дамжуулахгүй толгойнууд: hop-by-hop · cookie · host/content-length/content-encoding/accept-encoding (fetch өөрөө зөв тавина; бие нь тайлагдсан байтаар явна) ·
// proxy-ийн толгойнууд (бид өөрсдөө тавина) · дотоод итгэмжлэлийн толгойнууд (CLAUDE.md §3.2.9 — сервисүүд X-User-Id/X-Roles/X-Branch-Id-д итгэдэг тул гаднаас орж ирж болохгүй)
const WEBHOOK_DENY = new Set([
  ...HOP_BY_HOP,
  'cookie',
  'host',
  'content-length',
  'content-encoding',
  'accept-encoding',
  'expect',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'x-user-id',
  'x-roles',
  'x-branch-id',
  'x-correlation-id',
]);

// Хариунд дамжуулах upstream толгойнууд (allowlist). set-cookie, location, server, cache-control зэрэг нь дамжихгүй.
const RESPONSE_ALLOW = ['content-type', 'content-disposition'] as const;

const CORRELATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Клиентийн x-correlation-id зөвхөн аюулгүй тэмдэгттэй бол хэрэглэнэ (лог/толгой injection-ээс сэргийлнэ), үгүй бол шинэ UUID. */
export function pickCorrelationId(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && CORRELATION_ID_RE.test(value) ? value : randomUUID();
}

export interface UpstreamHeaderContext {
  correlationId: string;
  clientIp: string | undefined;
  /** Бие явуулж байгаа эсэх (content-type зөвхөн үед нь) */
  hasBody: boolean;
}

export function buildUpstreamHeaders(kind: ProxyKind, incoming: IncomingHttpHeaders, ctx: UpstreamHeaderContext): Headers {
  const headers = new Headers();
  if (kind === 'webhook') {
    // `Connection: x-foo` гэж заасан толгойнууд бас hop-by-hop (RFC 9110 §7.6.1)
    const listed = String(incoming.connection ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    for (const [name, value] of Object.entries(incoming)) {
      if (value === undefined || WEBHOOK_DENY.has(name) || listed.includes(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
  } else if (ctx.hasBody && typeof incoming['content-type'] === 'string') {
    headers.set('content-type', incoming['content-type']);
  }
  headers.set('x-correlation-id', ctx.correlationId);
  if (ctx.clientIp) headers.set('x-forwarded-for', ctx.clientIp);
  return headers;
}

/** Upstream хариуны толгойноос клиентэд дамжуулахыг сонгоно. content-length зөвхөн бие нь шахагдаагүй (fetch тайлаагүй) үед. */
export function buildClientHeaders(upstream: Headers, correlationId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RESPONSE_ALLOW) {
    const value = upstream.get(name);
    if (value !== null) out[name] = value;
  }
  const encoding = upstream.get('content-encoding');
  const length = upstream.get('content-length');
  if (length !== null && (encoding === null || encoding.toLowerCase() === 'identity')) out['content-length'] = length;
  out['x-correlation-id'] = correlationId;
  return out;
}
