// FR-11.4 Зээлдэгчийн (JWT-гүй) public e-sign REST. Gateway `/api/public/esign/**`-ийг энд дамжуулна (rate limit, IP-г gateway тавина).
// Эрх = линкийн токен (bearer): шалгалт service-д. Path параметрийн хэлбэрийг service-д хүрэхээс өмнө шалгаж, буруу бол 404.
// Хариу бүрд `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` (алдаанд filter). `verify/:code`, `callback/:provider`-ийг `:token`-оос ӨМНӨ зарлана.
import {
  Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseFilters, UseInterceptors, type RawBodyRequest, type StreamableFile,
} from '@nestjs/common';
import {
  StartPublicSigning,
  type PublicSigningSession,
  type SigningVerification,
} from '@los/contracts';
import { Public } from '@los/nest-common';
import type { IncomingHttpHeaders } from 'node:http';
import type { Request } from 'express';
import type { WebhookRequest } from '../../../integrations/esign/esign-provider.port';
import { SigningWebhookRejectedError } from '../errors';
import { SigningService } from '../signing.service';
import { fileResponse } from './file-response';
import { NoStoreInterceptor } from './no-store';
import { LinkTokenPipe, VerificationCodePipe, WebhookProviderPipe } from './params';
import { clientMeta, headerValue } from './request-context';
import { SigningExceptionFilter } from './signing-exception.filter';
import { ZodPipe } from './zod.pipe';

/** Толгойнуудыг provider-ийн `parseWebhook`-д: нэр нь Node-оор жижиг үсэгтэй, давхардсан утга нь `, `-ээр нэгдсэн */
function webhookHeaders(headers: IncomingHttpHeaders): WebhookRequest['headers'] {
  return Object.fromEntries(Object.keys(headers).map((name) => [name, headerValue(headers, name)]));
}

/** JWT-гүй: эрх = линкийн токен (bearer). Gateway `/api/public/esign/**`-ийг rate limit-тэй дамжуулна; webhook-ийг provider-ийн adapter гарын үсгээр шалгана */
@Public()
@Controller('public/esign')
@UseFilters(SigningExceptionFilter)
@UseInterceptors(NoStoreInterceptor)
export class PublicEsignController {
  constructor(@Inject(SigningService) private readonly signing: SigningService) {}

  /** QR кодын баталгаажуулалт. Регистр, утас, файлын id ГАРАХГҮЙ */
  @Get('verify/:code')
  verify(@Param('code', VerificationCodePipe) code: string): Promise<SigningVerification> {
    return this.signing.verify(code);
  }

  /**
   * Provider-ийн webhook. Гарын үсгийг provider-ийн adapter БАЙТААР (`req.rawBody`, main.ts `rawBody: true`) шалгана;
   * буруу бол 401 (дэлгэрэнгүйгүй). Төлвийг webhook-ийн биеэс биш provider-оос дахин асууж шийднэ. Амжилт → 204
   */
  @Post('callback/:provider')
  @HttpCode(204)
  async callback(@Param('provider', WebhookProviderPipe) provider: string, @Req() req: RawBodyRequest<Request>): Promise<void> {
    // Бие JSON/urlencoded биш (эсвэл хоосон) бол rawBody тогтоогдохгүй — баталгаажуулах боломжгүй
    if (!req.rawBody) throw new SigningWebhookRejectedError();
    await this.signing.handleWebhook(provider, { headers: webhookHeaders(req.headers), rawBody: req.rawBody });
  }

  @Get(':token')
  view(@Param('token', LinkTokenPipe) token: string, @Req() req: Request): Promise<PublicSigningSession> {
    return this.signing.getPublicSession(token, clientMeta(req));
  }

  /** Эх гэрээний PDF (iframe-д inline). Нээсэн нь "үзсэн" гэж тэмдэглэгдэнэ — start-ын урьдчилсан нөхцөл */
  @Get(':token/document')
  async document(@Param('token', LinkTokenPipe) token: string, @Req() req: Request): Promise<StreamableFile> {
    return fileResponse(await this.signing.getDocumentForReview(token, clientMeta(req)), 'inline');
  }

  @Post(':token/start')
  @HttpCode(200)
  start(
    @Param('token', LinkTokenPipe) token: string,
    @Body(new ZodPipe(StartPublicSigning)) dto: StartPublicSigning,
    @Req() req: Request,
  ): Promise<PublicSigningSession> {
    return this.signing.start(token, dto, clientMeta(req));
  }

  /** Poll. IN_PROGRESS үед provider-оос асууж, SIGNED болсон бол finalize хийнэ */
  @Get(':token/status')
  status(@Param('token', LinkTokenPipe) token: string, @Req() req: Request): Promise<PublicSigningSession> {
    return this.signing.refresh(token, clientMeta(req));
  }

  @Post(':token/decline')
  @HttpCode(200)
  decline(@Param('token', LinkTokenPipe) token: string, @Req() req: Request): Promise<PublicSigningSession> {
    return this.signing.decline(token, clientMeta(req));
  }

  /** Гарын үсэг зурагдсаны дараа зээлдэгчид өөрт нь (линкийн хугацаа дуусаагүй байхад) */
  @Get(':token/signed-document')
  async signedDocument(@Param('token', LinkTokenPipe) token: string, @Req() req: Request): Promise<StreamableFile> {
    return fileResponse(await this.signing.getSignedDocumentForBorrower(token, clientMeta(req)), 'attachment');
  }
}
