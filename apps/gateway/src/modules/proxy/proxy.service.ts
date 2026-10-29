import { Injectable, Logger } from '@nestjs/common';
import { CTX_HEADERS } from '@los/contracts';
import { contextOf, serviceUrl, type ServiceName } from '@los/nest-common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware';

export const PROXIED_SERVICES = ['origination', 'kyc', 'scoring', 'valuation', 'dms'] as const satisfies readonly ServiceName[];
export type ProxiedService = typeof PROXIED_SERVICES[number];

/** Клиентээс ирсэн бол ХЭЗЭЭ Ч дамжуулахгүй толгойнууд (identity нь зөвхөн gateway-ийн баталгаажуулсан утгаар). */
const STRIP = ['authorization', 'cookie', ...Object.values(CTX_HEADERS)];
const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

@Injectable()
export class ProxyService {
  private readonly log = new Logger('Proxy');
  private readonly handlers = new Map<ProxiedService, RequestHandler>();

  /** `/api/<service>/<rest>` → `<SERVICE_URL>/api/<rest>` */
  forward(service: ProxiedService, req: IncomingMessage, res: ServerResponse): void {
    let h = this.handlers.get(service);
    if (!h) { h = this.create(service); this.handlers.set(service, h); }
    void (h as unknown as (a: IncomingMessage, b: ServerResponse, n: (e?: unknown) => void) => unknown)(req, res, (e) => {
      this.log.error(`proxy next(${String(e)})`);
    });
  }

  private create(service: ProxiedService): RequestHandler {
    const prefix = new RegExp(`^/api/${service}`);
    return createProxyMiddleware({
      target: serviceUrl(service),
      changeOrigin: false,
      xfwd: true,
      timeout: 30_000,
      proxyTimeout: 30_000,
      pathRewrite: (path) => path.replace(prefix, '/api'),
      on: {
        proxyReq: (proxyReq, req) => {
          for (const h of [...STRIP, ...HOP]) proxyReq.removeHeader(h);
          const ctx = contextOf(req as never);
          // Баталгаажсан контекст (JwtAuthGuard тавьсан). Guard-аас өмнө хүрвэл identity байхгүй → сервис 401 өгнө.
          if (ctx.userId) proxyReq.setHeader(CTX_HEADERS.userId, ctx.userId);
          if (ctx.roles.length) proxyReq.setHeader(CTX_HEADERS.roles, ctx.roles.join(','));
          if (ctx.branchId) proxyReq.setHeader(CTX_HEADERS.branchId, ctx.branchId);
          if (ctx.orgId) proxyReq.setHeader(CTX_HEADERS.orgId, ctx.orgId);
          proxyReq.setHeader(CTX_HEADERS.correlationId, ctx.correlationId);
          if (process.env.INTERNAL_AUTH_SECRET) proxyReq.setHeader(CTX_HEADERS.internalToken, process.env.INTERNAL_AUTH_SECRET);
        },
        proxyRes: (proxyRes, req) => {
          delete proxyRes.headers['x-powered-by'];
          proxyRes.headers[CTX_HEADERS.correlationId] = contextOf(req as never).correlationId;
        },
        error: (err, req, res) => {
          const r = res as ServerResponse;
          const timeout = (err as NodeJS.ErrnoException).code === 'ECONNRESET' || /timeout/i.test(String(err));
          this.log.error(`${service} proxy error: ${err.message}`);
          if (r.headersSent || typeof r.writeHead !== 'function') return;
          r.writeHead(timeout ? 504 : 502, { 'content-type': 'application/json' });
          r.end(JSON.stringify({ code: timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR', message: `${service} сервис хариу өгсөнгүй`, correlationId: contextOf(req as never).correlationId }));
        },
      },
    });
  }
}
