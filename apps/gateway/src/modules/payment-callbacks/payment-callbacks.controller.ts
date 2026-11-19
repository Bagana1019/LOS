import { Controller, Get, HttpException, HttpStatus, Injectable, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public, serviceUrl } from '@los/nest-common';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { resolveClientIp } from '../public-esign/client-ip';
import { pickCorrelationId } from '../public-esign/header-policy';
import { readRequestBody } from '../public-esign/request-body';
import { PUBLIC_PAYMENT_CALLBACKS, type PublicCallbackRoute } from '../proxy/route-policy';
import { CallbackProvider, PaymentCallbackRateLimitGuard } from './payment-callback-rate-limit.guard';

const positiveInt = (name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}="${raw}"`);
  return n;
};

function route(provider: PublicCallbackRoute['provider'], method: PublicCallbackRoute['method']): PublicCallbackRoute {
  const r = PUBLIC_PAYMENT_CALLBACKS.find((x) => x.provider === provider && x.method === method);
  if (!r) throw new Error(`no public callback route ${method} ${provider}`);
  return r;
}
const QPAY_GET = route('QPAY', 'GET');
const QPAY_POST = route('QPAY', 'POST');
const SOCIALPAY_POST = route('SOCIALPAY', 'POST');
/** Global prefix `api`-гүй controller зам */
const rel = (r: PublicCallbackRoute) => r.path.replace(/^\/api\//, '');

/**
 * Callback-ийг origination-ийн ТОГТМОЛ зам руу дамжуулна. Upstream руу зөвхөн content-type (биетэй үед), x-correlation-id,
 * x-forwarded-for (бидний тодорхойлсон IP) — authorization/cookie/X-User-Id/X-Roles/X-Internal-Token зэрэг ХЭЗЭЭ Ч дамжихгүй.
 * Хариунаас зөвхөн статус, content-type, бие. Callback бүрийг (GET ч) аудитад бичнэ — query/бие бичихгүй.
 */
@Injectable()
export class PaymentCallbackForwarder {
  private readonly log = new Logger('PaymentCallbacks');
  private readonly maxBodyBytes = positiveInt('PAYMENT_CALLBACK_MAX_BODY_BYTES', 16 * 1024);
  private readonly timeoutMs = positiveInt('PAYMENT_CALLBACK_TIMEOUT_MS', 20_000);

  constructor(private readonly audit: AuditService) {}

  async forward(r: PublicCallbackRoute, req: Request, res: Response): Promise<void> {
    const started = Date.now();
    const correlationId = pickCorrelationId(req.headers['x-correlation-id']);
    const clientIp = resolveClientIp(req);
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    try {
      const body = r.method === 'POST' ? await readRequestBody(req, res, this.maxBodyBytes) : undefined;
      const headers = new Headers({ 'x-correlation-id': correlationId });
      if (clientIp) headers.set('x-forwarded-for', clientIp);
      if (body && typeof req.headers['content-type'] === 'string') headers.set('content-type', req.headers['content-type']);
      const q = req.originalUrl.indexOf('?');
      const url = `${serviceUrl('origination')}${r.upstreamPath}${q >= 0 ? req.originalUrl.slice(q) : ''}`;
      let upstream: globalThis.Response;
      try {
        upstream = await fetch(url, { method: r.method, headers, body: body as Uint8Array<ArrayBuffer> | undefined, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        this.log.warn(JSON.stringify({ event: 'payment_callback_upstream_failure', provider: r.provider, correlationId, reason: e instanceof Error ? e.name : 'unknown' }));
        throw new HttpException({ code: 'UPSTREAM_UNAVAILABLE', message: 'Үйлчилгээ түр боломжгүй байна' }, HttpStatus.BAD_GATEWAY);
      }
      const text = await upstream.text();
      status = upstream.status >= 300 && upstream.status < 400 ? HttpStatus.BAD_GATEWAY : upstream.status;
      res.status(status);
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8');
      res.setHeader('x-correlation-id', correlationId);
      res.send(text);
    } catch (e) {
      status = e instanceof HttpException ? e.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      throw e;
    } finally {
      this.audit.recordSafe({
        orgId: null, entity: 'PAYMENT_CALLBACK', entityId: r.provider, action: `PAYMENT_CALLBACK_${r.method}`, actorId: null,
        afterJson: { status, durationMs: Date.now() - started }, correlationId, ip: clientIp ?? null,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 256) : null,
      });
    }
  }
}

/**
 * H9 — QPay/SocialPay callback: ажилтны JWT-гүй (@Public). Глобал IP тутмын ThrottlerGuard-ыг алгасаж (@SkipThrottle), оронд нь
 * PaymentCallbackRateLimitGuard: итгэмжлэгдсэн хүрээ (PAYMENT_CALLBACK_TRUSTED_CIDRS_*) → провайдерын хувин + IP-ийн дээд хязгаар;
 * бусад IP → тусдаа жижиг IP хязгаар + «итгэмжлэгдээгүй» хувин (провайдерын хувинд хүрэхгүй). Зам: route-policy PUBLIC_PAYMENT_CALLBACKS.
 */
@Public()
@SkipThrottle()
@UseGuards(PaymentCallbackRateLimitGuard)
@Controller()
export class PaymentCallbacksController {
  constructor(private readonly forwarder: PaymentCallbackForwarder) {}

  @Get(rel(QPAY_GET))
  @CallbackProvider('QPAY')
  qpayGet(@Req() req: Request, @Res() res: Response) { return this.forwarder.forward(QPAY_GET, req, res); }

  @Post(rel(QPAY_POST))
  @CallbackProvider('QPAY')
  qpayPost(@Req() req: Request, @Res() res: Response) { return this.forwarder.forward(QPAY_POST, req, res); }

  @Post(rel(SOCIALPAY_POST))
  @CallbackProvider('SOCIALPAY')
  socialpay(@Req() req: Request, @Res() res: Response) { return this.forwarder.forward(SOCIALPAY_POST, req, res); }
}
