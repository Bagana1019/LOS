// FR-11.4 HTTP хүсэлтийн толгойноос контекст гаргана: ажилтны (gateway-ийн `X-User-Id`, `X-Correlation-Id`) ба зээлдэгчийн холболтын мэдээлэл (audit).
// Толгойн утга audit/event/лог руу орох тул хэлбэрийг нь шалгана (injection, хэт урт). PII-г энд уншихгүй.
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import type { Request } from 'express';
import { z } from 'zod';
import type { ClientMeta, RequestContext } from '../signing.service';

/** `X-Correlation-Id`: gateway-ийн дүрэмтэй ижил. Буруу хэлбэр бол шинэ UUID (алдаа биш) */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** `X-User-Id`: харагдах ASCII, зайгүй. Буруу бол 400 — хэн гэдэг нь тодорхойгүй үйлдлийг хэн нэгний нэр дээр бичихгүй */
const ActorHeaders = z.object({ 'x-user-id': z.string().regex(/^[\x21-\x7e]{1,128}$/).optional() });
/** Audit-ийн `user_agent` багана */
const MAX_USER_AGENT_LENGTH = 255;

type HeaderSource = Pick<Request, 'headers'>;

/** Node нь давтагдсан толгойг `, `-ээр нэгтгэж өгдөг; массив ирвэл (set-cookie) адилхан нэгтгэнэ. Хоосон/зөвхөн зай бол байхгүй гэж үзнэ */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  const value = (Array.isArray(raw) ? raw.join(', ') : raw)?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Ажилтны үйлдлийн контекст. `X-User-Id` буруу хэлбэртэй бол ZodError (→ 400, утгыг буцаахгүй) */
export function requestContext(req: HeaderSource): RequestContext {
  const { 'x-user-id': actorId } = ActorHeaders.parse({ 'x-user-id': headerValue(req.headers, 'x-user-id') });
  const correlationId = headerValue(req.headers, 'x-correlation-id');
  return { actorId: actorId ?? null, correlationId: correlationId !== undefined && CORRELATION_ID.test(correlationId) ? correlationId : randomUUID() };
}

/** IP хаягийг каноник болгоно (IPv4-mapped → IPv4, zone id хасна, жижиг үсэг). IP биш утга бол `undefined` */
export function normalizeIp(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const zone = raw.indexOf('%');
  const ip = (zone === -1 ? raw : raw.slice(0, zone)).trim();
  if (isIP(ip) === 0) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped && isIP(mapped[1]) === 4 ? mapped[1] : ip.toLowerCase();
}

/**
 * Зээлдэгчийн IP/User-Agent (audit-д ЗӨВХӨН). dms нь gateway-ийн ард дотоод сүлжээнд тул gateway-ийн тавьсан `X-Forwarded-For`
 * (нэг хаяг — жинхэнэ клиент)-ийн ЭХНИЙ hop-д итгэнэ; байхгүй эсвэл IP биш бол сокетын хаяг. User-Agent 255 тэмдэгтээр таслагдана.
 */
export function clientMeta(req: Pick<Request, 'headers' | 'socket'>): ClientMeta {
  const forwarded = normalizeIp(headerValue(req.headers, 'x-forwarded-for')?.split(',')[0]);
  const userAgent = headerValue(req.headers, 'user-agent')?.slice(0, MAX_USER_AGENT_LENGTH);
  return { ip: forwarded ?? normalizeIp(req.socket?.remoteAddress) ?? null, userAgent: userAgent ?? null };
}

/** Лог-д бичих correlation id: зөвхөн хүчинтэй хэлбэртэй толгойнхыг (шинээр үүсгэхгүй) */
export function loggableCorrelationId(req: HeaderSource): string | undefined {
  const value = headerValue(req.headers, 'x-correlation-id');
  return value !== undefined && CORRELATION_ID.test(value) ? value : undefined;
}
