import { Controller, Get, Inject, Param, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '@los/nest-common';
import type { Request, Response } from 'express';
import { DmsProxyService } from './dms-proxy.service';
import { EsignRateLimitGuard, RateGroupOf } from './esign-rate-limit.guard';
import { PROXY_CONFIG, ProxyConfig } from './esign-proxy.config';
import { ProviderPipe, SigningTokenPipe, VerificationCodePipe } from './params.pipes';
import { PublicEsignExceptionFilter } from './public-esign.filter';

/**
 * FR-11.4 — зээлдэгчийн (JWT-гүй) цахим гарын үсгийн public API. dms-ийн `/api/public/esign/**`-ийг яг толин тусгана.
 * Зам бүр: rate limit (guard) → параметр шалгалт (pipe; буруу бол dms руу очихгүй 404) → dms руу дамжуулалт.
 *
 * `verify/:code` ба `callback/:provider`-ийг `:token` route-уудаас ӨМНӨ зарлана (Express дарааллаар таарна).
 */
@Public()
@SkipThrottle() // глобал 600/мин-ийн оронд доорх бүлэг тус бүрийн (EsignRateLimitGuard) хязгаар үйлчилнэ
@Controller('public/esign')
@UseGuards(EsignRateLimitGuard)
@UseFilters(PublicEsignExceptionFilter)
export class PublicEsignController {
  constructor(
    @Inject(DmsProxyService) private readonly proxy: DmsProxyService,
    @Inject(PROXY_CONFIG) private readonly config: ProxyConfig,
  ) {}

  /** QR кодын баталгаажуулалт */
  @Get('verify/:code')
  @RateGroupOf('read')
  verify(@Param('code', VerificationCodePipe) code: string, @Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, { name: 'verify', method: 'GET', path: `verify/${code}`, kind: 'json' });
  }

  /** Provider-ийн webhook. Бие нь байтаар, толгойнууд нь denylist-ээр дамжина (HMAC-ийг dms шалгана). */
  @Post('callback/:provider')
  @RateGroupOf('webhook')
  callback(@Param('provider', ProviderPipe) provider: string, @Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, {
      name: 'callback',
      method: 'POST',
      path: `callback/${provider}`,
      kind: 'webhook',
      maxBodyBytes: this.config.bodyLimits.webhookBytes,
    });
  }

  @Get(':token')
  @RateGroupOf('read')
  view(@Param('token', SigningTokenPipe) token: string, @Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, { name: 'view', method: 'GET', path: token, kind: 'json' });
  }

  @Get(':token/document')
  @RateGroupOf('read')
  document(@Param('token', SigningTokenPipe) token: string, @Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, { name: 'document', method: 'GET', path: `${token}/document`, kind: 'pdf' });
  }

  @Post(':token/start')
  @RateGroupOf('action')
  start(@Param('token', SigningTokenPipe) token: string, @Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, {
      name: 'start',
      method: 'POST',
      path: `${token}/start`,
      kind: 'json',
      maxBodyBytes: this.config.bodyLimits.jsonBytes,
    });
  }

  @Get(':token/status')
  @RateGroupOf('poll')
  status(@Param('token', SigningTokenPipe) token: string, @Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, { name: 'status', method: 'GET', path: `${token}/status`, kind: 'json' });
  }

  @Post(':token/decline')
  @RateGroupOf('action')
  decline(@Param('token', SigningTokenPipe) token: string, @Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, {
      name: 'decline',
      method: 'POST',
      path: `${token}/decline`,
      kind: 'json',
      maxBodyBytes: this.config.bodyLimits.jsonBytes,
    });
  }

  @Get(':token/signed-document')
  @RateGroupOf('read')
  signedDocument(@Param('token', SigningTokenPipe) token: string, @Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, { name: 'signed-document', method: 'GET', path: `${token}/signed-document`, kind: 'pdf' });
  }
}
