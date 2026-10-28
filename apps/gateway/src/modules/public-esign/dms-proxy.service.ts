import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response as ExpressResponse } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { resolveClientIp } from './client-ip';
import { PublicEsignError } from './errors';
import { buildClientHeaders, buildUpstreamHeaders, pickCorrelationId, ProxyKind } from './header-policy';
import { PROXY_CONFIG, ProxyConfig } from './esign-proxy.config';
import { readRequestBody } from './request-body';
import { applyNoStoreHeaders } from './response-headers';

export interface ProxyRoute {
  /** Логод бичих тогтвортой нэр — path параметр (токен) хэзээ ч ороогүй */
  name: string;
  method: 'GET' | 'POST';
  /** dms-ийн `/api/public/esign/` дараах зам; параметр нь аль хэдийн шалгагдсан */
  path: string;
  kind: ProxyKind;
  /** Хүсэлтийн биеийн дээд хэмжээ (байт). Тодорхойгүй бол бие уншихгүй, дамжуулахгүй. */
  maxBodyBytes?: number;
}

const UPSTREAM_PREFIX = '/api/public/esign/';

/**
 * Зээлдэгчийн (JWT-гүй) public e-sign хүсэлтийг dms-ийн `/api/public/esign/**` руу дамжуулна. FR-11.4.
 * Хариуг buffer-лэхгүй stream-ээр дамжуулна (PDF). Upstream-ийн URL, stack, set-cookie клиентэд хэзээ ч гарахгүй.
 */
@Injectable()
export class DmsProxyService {
  private readonly log = new Logger('EsignProxy');

  constructor(@Inject(PROXY_CONFIG) private readonly config: ProxyConfig) {}

  async forward(req: Request, res: ExpressResponse, route: ProxyRoute): Promise<void> {
    const correlationId = pickCorrelationId(req.headers['x-correlation-id']);
    const body = route.maxBodyBytes === undefined ? undefined : await readRequestBody(req, res, route.maxBodyBytes);
    const headers = buildUpstreamHeaders(route.kind, req.headers, {
      correlationId,
      clientIp: resolveClientIp(req),
      hasBody: body !== undefined,
    });

    const { headersMs, jsonTotalMs, pdfTotalMs } = this.config.timeouts;
    const abort = new AbortController();
    const headersTimer = setTimeout(() => abort.abort(), headersMs);
    const totalTimer = setTimeout(() => abort.abort(), route.kind === 'pdf' ? pdfTotalMs : jsonTotalMs);
    // Хариуны толгой ирэхээс өмнө клиент таслагдвал upstream-ийг ч зогсооно (stream хийж эхэлсний дараа pipeline өөрөө хийнэ)
    const onClientClose = () => abort.abort();
    res.once('close', onClientClose);

    try {
      let upstream: Response;
      try {
        upstream = await fetch(`${this.config.dmsBaseUrl}${UPSTREAM_PREFIX}${route.path}`, {
          method: route.method,
          headers,
          // Buffer нь ArrayBuffer-аар (SharedArrayBuffer биш) тулгуурласан — fetch-ийн BodyInit-д тохирно
          body: body as Uint8Array<ArrayBuffer> | undefined,
          signal: abort.signal,
          redirect: 'manual',
        });
      } catch (err) {
        throw this.upstreamFailure(res, route, correlationId, err);
      } finally {
        clearTimeout(headersTimer);
        res.off('close', onClientClose);
      }
      // dms public route redirect хийхгүй; ирвэл Location-д дотоод хаяг байж болох тул дамжуулахгүй
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => undefined);
        throw this.upstreamFailure(res, route, correlationId, new Error(`unexpected upstream status ${upstream.status}`));
      }

      res.status(upstream.status);
      for (const [name, value] of Object.entries(buildClientHeaders(upstream.headers, correlationId))) res.setHeader(name, value);
      applyNoStoreHeaders(res);
      if (!upstream.body) {
        res.end();
        return;
      }
      try {
        await pipeline(Readable.fromWeb(upstream.body as unknown as NodeWebStream), res);
      } catch (err) {
        // Толгой аль хэдийн явсан тул өөр статус өгөх боломжгүй — холболтыг таслана. Клиент өөрөө таслсан бол алдаа биш.
        if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') this.logFailure(route, correlationId, err);
        res.destroy();
      }
    } finally {
      clearTimeout(totalTimer);
    }
  }

  private upstreamFailure(res: ExpressResponse, route: ProxyRoute, correlationId: string, err: unknown): PublicEsignError {
    // Клиент өөрөө таслсан бол (res хаагдсан) алдаа биш
    if (!res.destroyed) this.logFailure(route, correlationId, err);
    return new PublicEsignError('UPSTREAM_UNAVAILABLE');
  }

  // Лог: зөвхөн route-ийн нэр, correlationId, алдааны төрөл. URL, токен, толгой, стек бичихгүй.
  private logFailure(route: ProxyRoute, correlationId: string, err: unknown): void {
    const reason = err instanceof Error ? ((err.cause as { code?: string } | undefined)?.code ?? err.name) : 'unknown';
    this.log.warn(JSON.stringify({ event: 'esign_proxy_upstream_failure', route: route.name, correlationId, reason }));
  }
}
